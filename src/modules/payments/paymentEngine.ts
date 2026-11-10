import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import type {
  PayableType,
  PaymentDirection,
  PaymentMethod,
  PaymentState,
  PaymentStatus,
} from '../../config/commerce';
import { withTransaction } from '../../db/transaction';
import { Customer } from '../../models/Customer';
import { PaymentEntry, type PaymentEntryDocument } from '../../models/PaymentEntry';
import { writeAudit } from '../../services/auditService';
import { AppError, ErrorCode } from '../../utils/AppError';
import { describeMoneyMinor } from '../../utils/money';

/**
 * The payment engine, shared by every kind of payable.
 *
 * Purchases are its first consumer; orders become its second in Phase 4. The engine
 * knows nothing about either — a payable registers an adapter that can load itself,
 * report its totals and write back the derived fields. That is what keeps one engine
 * from becoming two, which is how the two would eventually disagree about what
 * "partially paid" means.
 */

/** Who recorded the payment, for the entry and the audit trail. */
export interface PaymentActor {
  type: 'merchant' | 'admin' | 'system';
  id?: Types.ObjectId | null;
  label: string;
}

/** What the engine needs to know about a payable, whatever kind it is. */
export interface PayableSnapshot {
  id: Types.ObjectId;
  merchantId: Types.ObjectId;
  reference: string;
  /** A short description for audit summaries, such as `purchase PUR-0007`. */
  label: string;
  totalMinor: number;
  paidMinor: number;
  dueDate?: Date | null;
  /** A cancelled payable takes no further payments. */
  cancelled: boolean;
  /**
   * The customer an overpayment can be kept for as an advance. Only orders have one, and
   * only when the order names a customer.
   */
  customerId?: Types.ObjectId | null;
}

/**
 * How one kind of payable participates. `TDoc` stays generic so an adapter can hand
 * its own document back to itself without the engine needing to know the shape.
 */
export interface PayableAdapter<TDoc = unknown> {
  /** The direction money moves for this kind: out to a supplier, in from a customer. */
  direction: PaymentDirection;
  load(input: {
    merchantId: Types.ObjectId;
    payableId: string;
    session?: ClientSession;
  }): Promise<TDoc>;
  snapshot(doc: TDoc): PayableSnapshot;
  /**
   * Writes the derived payment fields back onto the document.
   *
   * `installmentNumber` is passed through from the request so a payable that keeps a
   * schedule can allocate against it. A payable without one ignores it.
   */
  applyPayment(
    doc: TDoc,
    next: {
      paidMinor: number;
      paymentStatus: PaymentStatus;
      installmentNumber?: number | null;
    },
  ): void;
  save(doc: TDoc, session?: ClientSession): Promise<void>;
  /**
   * Rebuilds the derived payment fields from the full list of entries, oldest first.
   *
   * Used after an entry is corrected or deleted, when "add this amount" no longer
   * describes the change. A payable that keeps a schedule replays the entries into it
   * here; one without a schedule can leave this out and the engine sets the totals.
   */
  rebuild?(
    doc: TDoc,
    next: { paidMinor: number; paymentStatus: PaymentStatus },
    entries: ReadonlyArray<{ amountMinor: number; installmentNumber?: number | null }>,
  ): void;
  /**
   * Called after the transaction commits, so a counterparty's outstanding balance can
   * be brought in step. Optional: not every payable has one.
   */
  afterPayment?(doc: TDoc, session?: ClientSession): Promise<void>;
}

const adapters = new Map<PayableType, PayableAdapter<never>>();

/** Registers the adapter for one kind of payable. Called once, at module load. */
export function registerPayable<TDoc>(type: PayableType, adapter: PayableAdapter<TDoc>): void {
  adapters.set(type, adapter as PayableAdapter<never>);
}

function adapterFor(type: PayableType): PayableAdapter<never> {
  const adapter = adapters.get(type);
  if (!adapter) {
    // Reaching this means a payable type was accepted by validation but never
    // registered, which is a wiring mistake rather than anything a client did.
    throw AppError.notFound('That record was not found.');
  }
  return adapter;
}

/**
 * Settles the stored payment status from the amounts alone.
 *
 * Overdue is deliberately absent: it depends on the clock, not on a write, so storing
 * it would need a nightly job and any row the job had not reached would be wrong.
 */
export function derivePaymentStatus(totalMinor: number, paidMinor: number): PaymentStatus {
  if (paidMinor >= totalMinor) return 'fully_paid';
  if (paidMinor > 0) return 'partially_paid';
  return 'unpaid';
}

/**
 * What a client displays: the stored status, with the time-derived overdue case folded
 * in. A fully paid payable is never overdue, however long ago its due date was.
 */
export function derivePaymentState(input: {
  paymentStatus: PaymentStatus;
  dueDate?: Date | null;
  now?: Date;
}): PaymentState {
  if (input.paymentStatus === 'fully_paid') return 'fully_paid';
  if (!input.dueDate) return input.paymentStatus;

  const now = input.now ?? new Date();
  return input.dueDate.getTime() < now.getTime() ? 'overdue' : input.paymentStatus;
}

/** A Mongo filter matching the payables that are overdue right now. */
export function overdueFilter(now: Date = new Date()): Record<string, unknown> {
  return { paymentStatus: { $ne: 'fully_paid' }, dueDate: { $ne: null, $lt: now } };
}

export function outstandingMinor(totalMinor: number, paidMinor: number): number {
  return Math.max(0, totalMinor - paidMinor);
}

/* --------------------------------- advances -------------------------------- */

/**
 * Credits (positive) or takes back (negative) part of a customer's advance.
 *
 * The take-back is conditional on the balance, so an advance that was already spent can
 * never be driven below zero.
 */
async function adjustCustomerAdvance(
  merchantId: Types.ObjectId,
  customerId: Types.ObjectId,
  deltaMinor: number,
  session?: ClientSession,
): Promise<{ from: number; to: number }> {
  const filter: Record<string, unknown> = { _id: customerId, merchantId };
  if (deltaMinor < 0) filter.advanceMinor = { $gte: -deltaMinor };

  const updated = await Customer.findOneAndUpdate(
    filter,
    { $inc: { advanceMinor: deltaMinor } },
    { new: true, session: session ?? null },
  );

  if (!updated) {
    const customer = await Customer.findOne({ _id: customerId, merchantId }).session(
      session ?? null,
    );
    if (!customer) {
      throw AppError.conflict(
        "This payment's customer no longer exists, so its advance cannot be changed.",
      );
    }
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `${describeMoneyMinor(-deltaMinor)} of this payment was kept as advance, but the customer ` +
        `has only ${describeMoneyMinor(customer.advanceMinor)} of advance left; the rest has already been used.`,
      { meta: { advanceMinor: customer.advanceMinor, requiredMinor: -deltaMinor } },
    );
  }

  return { from: updated.advanceMinor - deltaMinor, to: updated.advanceMinor };
}

/** The customer an overpayment is kept for, or a 409 when there is none. */
function advanceCustomerFor(
  snapshot: PayableSnapshot,
  direction: PaymentDirection,
): Types.ObjectId {
  if (direction !== 'in' || !snapshot.customerId) {
    throw AppError.conflict(
      'This order has no customer, so the extra amount cannot be kept as advance.',
    );
  }
  return snapshot.customerId;
}

/** A customer-side audit entry, so the advance has its own history. */
async function auditAdvance(input: {
  actor: PaymentActor;
  customerId: Types.ObjectId;
  change: { from: number; to: number };
  payableReference: string;
  paymentId: Types.ObjectId;
  req?: Request;
}): Promise<void> {
  const delta = input.change.to - input.change.from;
  if (delta === 0) return;
  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: delta > 0 ? 'customer.advance_credited' : 'customer.advance_reversed',
    targetType: 'customer',
    targetId: input.customerId,
    summary:
      delta > 0
        ? `Kept ${describeMoneyMinor(delta)} paid on ${input.payableReference} as advance; ` +
          `advance is now ${describeMoneyMinor(input.change.to)}.`
        : `Took back ${describeMoneyMinor(-delta)} of advance from a payment on ` +
          `${input.payableReference}; advance is now ${describeMoneyMinor(input.change.to)}.`,
    changes: [{ field: 'advanceMinor', from: input.change.from, to: input.change.to }],
    metadata: { paymentId: String(input.paymentId), payableReference: input.payableReference },
    req: input.req,
  });
}

export interface RecordPaymentInput {
  merchantId: Types.ObjectId;
  payableType: PayableType;
  payableId: string;
  amountMinor: number;
  method: PaymentMethod;
  reference?: string | null;
  paidAt?: Date | null;
  notes?: string | null;
  /** Which installment of the payable's plan this settles, where it has one. */
  installmentNumber?: number | null;
  /**
   * When the amount is more than the balance: settle the balance and keep the rest as
   * the customer's advance, instead of refusing the payment.
   */
  keepExtraAsAdvance?: boolean;
  actor: PaymentActor;
  req?: Request;
}

export interface RecordPaymentResult {
  entry: PaymentEntryDocument;
  snapshot: PayableSnapshot;
  /** The customer's advance before and after, when part of the payment was kept as one. */
  advance?: { customerId: Types.ObjectId; from: number; to: number } | null;
}

/**
 * Records one payment against one payable.
 *
 * The entry and the parent's `paidMinor` are written in the same transaction, so a
 * total can never exist that the entries cannot explain — the same guarantee the stock
 * ledger gives for quantities (PRD section 33).
 */
export async function recordPayment(input: RecordPaymentInput): Promise<RecordPaymentResult> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'amountMinor', message: 'Enter an amount greater than zero.' },
    ]);
  }

  const adapter = adapterFor(input.payableType);
  const paidAt = input.paidAt ?? new Date();

  const result = await withTransaction(async (session) => {
    const doc = await adapter.load({
      merchantId: input.merchantId,
      payableId: input.payableId,
      session,
    });
    const before = adapter.snapshot(doc);

    if (before.cancelled) {
      throw AppError.conflict('This record was cancelled, so no further payment can be recorded.');
    }

    const outstanding = outstandingMinor(before.totalMinor, before.paidMinor);
    if (outstanding === 0) {
      throw AppError.conflict('This is already fully paid.');
    }

    // Refused rather than capped, unless the merchant said to keep the extra as advance.
    // A merchant who typed 50,000 instead of 5,000 needs to be told, not quietly given a
    // receipt for a different number.
    let advanceCustomerId: Types.ObjectId | null = null;
    if (input.amountMinor > outstanding && input.keepExtraAsAdvance) {
      advanceCustomerId = advanceCustomerFor(before, adapter.direction);
    } else if (input.amountMinor > outstanding) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        `That is more than the outstanding amount of ${describeMoneyMinor(outstanding)}.`,
        { meta: { outstanding, total: before.totalMinor, paid: before.paidMinor } },
      );
    }

    // The order takes only what it is owed; the rest is the customer's advance.
    const appliedMinor = Math.min(input.amountMinor, outstanding);
    const advanceMinor = input.amountMinor - appliedMinor;
    const paidMinor = before.paidMinor + appliedMinor;
    const paymentStatus = derivePaymentStatus(before.totalMinor, paidMinor);
    const balanceAfter = outstandingMinor(before.totalMinor, paidMinor);

    adapter.applyPayment(doc, {
      paidMinor,
      paymentStatus,
      installmentNumber: input.installmentNumber ?? null,
    });
    await adapter.save(doc, session);

    const [entry] = await PaymentEntry.create(
      [
        {
          merchantId: input.merchantId,
          payableType: input.payableType,
          payableId: before.id,
          payableReference: before.reference,
          direction: adapter.direction,
          amountMinor: appliedMinor,
          advanceMinor,
          advanceCustomerId: advanceMinor > 0 ? advanceCustomerId : null,
          method: input.method,
          reference: input.reference ?? null,
          paidAt,
          notes: input.notes ?? null,
          installmentNumber: input.installmentNumber ?? null,
          balanceAfterMinor: balanceAfter,
          actorType: input.actor.type,
          actorId: input.actor.id ?? null,
          actorLabel: input.actor.label,
        },
      ],
      { session, ordered: true },
    );

    const advance =
      advanceMinor > 0 && advanceCustomerId
        ? {
            customerId: advanceCustomerId,
            ...(await adjustCustomerAdvance(
              input.merchantId,
              advanceCustomerId,
              advanceMinor,
              session,
            )),
          }
        : null;

    if (adapter.afterPayment) await adapter.afterPayment(doc, session);

    return { entry: entry!, snapshot: adapter.snapshot(doc), advance, appliedMinor, advanceMinor };
  });

  const { appliedMinor, advanceMinor } = result;

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'payment.recorded',
    targetType: input.payableType,
    targetId: result.snapshot.id,
    summary:
      `Recorded ${describeMoneyMinor(input.amountMinor)} against ${result.snapshot.label} ` +
      `by ${input.method}; ${describeMoneyMinor(outstandingMinor(result.snapshot.totalMinor, result.snapshot.paidMinor))} outstanding.` +
      (advanceMinor > 0
        ? ` ${describeMoneyMinor(advanceMinor)} kept as the customer's advance.`
        : ''),
    changes: [
      {
        field: 'paidMinor',
        from: result.snapshot.paidMinor - appliedMinor,
        to: result.snapshot.paidMinor,
      },
      ...(advanceMinor > 0 ? [{ field: 'advanceMinor', from: 0, to: advanceMinor }] : []),
    ],
    metadata: {
      paymentId: String(result.entry._id),
      method: input.method,
      reference: input.reference ?? null,
      paidAt: paidAt.toISOString(),
      receivedMinor: input.amountMinor,
      appliedMinor,
      advanceMinor,
      advanceCustomerId: result.advance ? String(result.advance.customerId) : null,
    },
    req: input.req,
  });

  if (result.advance) {
    await auditAdvance({
      actor: input.actor,
      customerId: result.advance.customerId,
      change: result.advance,
      payableReference: result.snapshot.reference,
      paymentId: result.entry._id,
      req: input.req,
    });
  }

  return { entry: result.entry, snapshot: result.snapshot, advance: result.advance };
}

/* ------------------------- correcting a wrong payment ------------------------ */

/** Where a payable stands after its payments changed, for the client to redraw. */
export interface PayableSummary {
  type: PayableType;
  id: string;
  reference: string;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  paymentStatus: PaymentStatus;
}

function summarise(type: PayableType, snapshot: PayableSnapshot): PayableSummary {
  return {
    type,
    id: String(snapshot.id),
    reference: snapshot.reference,
    totalMinor: snapshot.totalMinor,
    paidMinor: snapshot.paidMinor,
    outstandingMinor: outstandingMinor(snapshot.totalMinor, snapshot.paidMinor),
    paymentStatus: derivePaymentStatus(snapshot.totalMinor, snapshot.paidMinor),
  };
}

async function loadEntry(merchantId: Types.ObjectId, paymentId: string, session?: ClientSession) {
  if (!Types.ObjectId.isValid(paymentId)) throw AppError.notFound('That payment was not found.');
  const entry = await PaymentEntry.findOne({ _id: paymentId, merchantId }).session(session ?? null);
  if (!entry) throw AppError.notFound('That payment was not found.');
  return entry;
}

/**
 * Brings a payable back in line with its ledger after an entry was corrected or removed.
 *
 * Everything derived from the entries is rebuilt from them rather than patched: the
 * paid total, the payment status, the instalment progress (replayed in the order the
 * payments were recorded) and each entry's "balance after", so every row still reads
 * true on its own.
 */
async function rebuildFromLedger(
  adapter: PayableAdapter<never>,
  doc: never,
  payableType: PayableType,
  session?: ClientSession,
): Promise<void> {
  const snapshot = adapter.snapshot(doc);
  const entries = await PaymentEntry.find({
    merchantId: snapshot.merchantId,
    payableType,
    payableId: snapshot.id,
  })
    .sort({ createdAt: 1, _id: 1 })
    .session(session ?? null);

  const paidMinor = entries.reduce((sum, entry) => sum + entry.amountMinor, 0);
  const next = { paidMinor, paymentStatus: derivePaymentStatus(snapshot.totalMinor, paidMinor) };

  if (adapter.rebuild) adapter.rebuild(doc, next, entries);
  else adapter.applyPayment(doc, next);
  await adapter.save(doc, session);

  // The running balance is a stored projection too. Written with a direct update on
  // purpose: the model refuses money changes made through a plain save.
  let running = 0;
  const updates = entries.flatMap((entry) => {
    running += entry.amountMinor;
    const balanceAfterMinor = outstandingMinor(snapshot.totalMinor, running);
    return entry.balanceAfterMinor === balanceAfterMinor
      ? []
      : [{ updateOne: { filter: { _id: entry._id }, update: { $set: { balanceAfterMinor } } } }];
  });
  if (updates.length > 0) await PaymentEntry.bulkWrite(updates, session ? { session } : {});

  if (adapter.afterPayment) await adapter.afterPayment(doc, session);
}

export interface CorrectPaymentInput {
  merchantId: Types.ObjectId;
  paymentId: string;
  /**
   * The right amount received: what the entry applied plus any advance it kept. Omitted
   * when only the descriptive fields change.
   */
  amountMinor?: number;
  /** When raising the amount past the balance, keep the extra as the customer's advance. */
  keepExtraAsAdvance?: boolean;
  reference?: string | null;
  paidAt?: Date;
  notes?: string | null;
  /** Why the amount was wrong, kept in the audit trail. */
  reason?: string | null;
  actor: PaymentActor;
  req?: Request;
}

/**
 * Fixes a payment that was entered with the wrong amount.
 *
 * The entry keeps its identity, method, date and instalment; only the money changes,
 * and the payable is rebuilt from its ledger in the same transaction. The new total may
 * not exceed what the payable is for, and a cancelled payable can only be corrected
 * downwards — recording more money against it would be a new payment, which it no
 * longer accepts. The old and new amounts are kept in the audit trail.
 */
export async function correctPayment(
  input: CorrectPaymentInput,
): Promise<{ entry: PaymentEntryDocument; payable: PayableSummary }> {
  const amountMinor = input.amountMinor;
  if (amountMinor !== undefined && (!Number.isInteger(amountMinor) || amountMinor <= 0)) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'amountMinor', message: 'Enter an amount greater than zero.' },
    ]);
  }

  const outcome = await withTransaction(async (session) => {
    const entry = await loadEntry(input.merchantId, input.paymentId, session);
    const adapter = adapterFor(entry.payableType);
    const doc = await adapter.load({
      merchantId: input.merchantId,
      payableId: String(entry.payableId),
      session,
    });
    const before = adapter.snapshot(doc);

    // Amounts here are what was received: the part applied to the payable plus any part
    // kept as advance. A payment without an advance reads exactly as it always did.
    const fromApplied = entry.amountMinor;
    const fromAdvance = entry.advanceMinor ?? 0;
    const fromMinor = fromApplied + fromAdvance;
    const toMinor = amountMinor ?? fromMinor;
    const increase = toMinor - fromMinor;
    const outstanding = outstandingMinor(before.totalMinor, before.paidMinor);

    if (increase > 0 && before.cancelled) {
      throw AppError.conflict(
        'This record was cancelled, so a payment against it can only be lowered or deleted.',
      );
    }

    let toApplied = fromApplied;
    let toAdvance = fromAdvance;
    let advanceCustomerId: Types.ObjectId | null = entry.advanceCustomerId ?? null;
    if (increase > 0) {
      // The extra settles the balance first; whatever is left is advance, if allowed.
      const extraAdvance = Math.max(0, increase - outstanding);
      if (extraAdvance > 0 && !input.keepExtraAsAdvance) {
        const most = fromMinor + outstanding;
        throw new AppError(
          409,
          ErrorCode.CONFLICT,
          `That would be more than the total of ${describeMoneyMinor(before.totalMinor)}. ` +
            `This payment can be at most ${describeMoneyMinor(most)}.`,
          { meta: { maxAmountMinor: most, total: before.totalMinor, paid: before.paidMinor } },
        );
      }
      if (extraAdvance > 0) {
        const customerId = advanceCustomerFor(before, adapter.direction);
        if (advanceCustomerId && fromAdvance > 0 && !advanceCustomerId.equals(customerId)) {
          throw AppError.conflict(
            "This payment's advance belongs to a different customer than the order now has.",
          );
        }
        advanceCustomerId = customerId;
      }
      toApplied = fromApplied + (increase - extraAdvance);
      toAdvance = fromAdvance + extraAdvance;
    } else if (increase < 0) {
      // A lower amount comes out of the advance first, then out of the payable.
      const decrease = -increase;
      const takenFromAdvance = Math.min(decrease, fromAdvance);
      toAdvance = fromAdvance - takenFromAdvance;
      toApplied = fromApplied - (decrease - takenFromAdvance);
    }

    let advanceChange: { from: number; to: number } | null = null;
    if (toAdvance !== fromAdvance && advanceCustomerId) {
      advanceChange = await adjustCustomerAdvance(
        input.merchantId,
        advanceCustomerId,
        toAdvance - fromAdvance,
        session,
      );
    }

    const set: Record<string, unknown> = {};
    if (toApplied !== fromApplied) set.amountMinor = toApplied;
    if (toAdvance !== fromAdvance) {
      set.advanceMinor = toAdvance;
      set.advanceCustomerId = toAdvance > 0 ? advanceCustomerId : null;
    }
    if (input.reference !== undefined) set.reference = input.reference;
    if (input.notes !== undefined) set.notes = input.notes;
    if (input.paidAt !== undefined) set.paidAt = input.paidAt;
    const detailsBefore = {
      reference: entry.reference ?? null,
      paidAt: entry.paidAt.toISOString(),
      notes: entry.notes ?? null,
    };

    if (Object.keys(set).length > 0) {
      await PaymentEntry.updateOne({ _id: entry._id }, { $set: set }, session ? { session } : {});
    }
    if (toApplied !== fromApplied) {
      await rebuildFromLedger(adapter, doc, entry.payableType, session);
    }

    const updated = await loadEntry(input.merchantId, input.paymentId, session);
    return {
      entry: updated,
      after: adapter.snapshot(doc),
      before,
      fromMinor,
      toMinor,
      fromAdvance,
      toAdvance,
      advanceChange,
      advanceCustomerId,
      detailsBefore,
    };
  });

  const { entry, after, before, fromMinor, toMinor, fromAdvance, toAdvance, detailsBefore } =
    outcome;
  const reason = input.reason?.trim() || null;

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: fromMinor === toMinor ? 'payment.annotated' : 'payment.corrected',
    targetType: entry.payableType,
    targetId: entry.payableId,
    summary:
      fromMinor === toMinor
        ? `Corrected the details of a ${describeMoneyMinor(toMinor)} payment on ${entry.payableReference}. ` +
          'The amount was not changed.'
        : `Changed a payment on ${entry.payableReference} from ${describeMoneyMinor(fromMinor)} to ` +
          `${describeMoneyMinor(toMinor)}; ${describeMoneyMinor(outstandingMinor(after.totalMinor, after.paidMinor))} ` +
          `outstanding.` +
          (toAdvance !== fromAdvance
            ? ` Advance kept from this payment went from ${describeMoneyMinor(fromAdvance)} ` +
              `to ${describeMoneyMinor(toAdvance)}.`
            : '') +
          (reason ? ` Reason: ${reason}` : ''),
    changes: [
      { field: 'amountMinor', from: fromMinor, to: toMinor },
      { field: 'paidMinor', from: before.paidMinor, to: after.paidMinor },
      { field: 'advanceMinor', from: fromAdvance, to: toAdvance },
      { field: 'reference', from: detailsBefore.reference, to: entry.reference ?? null },
      { field: 'paidAt', from: detailsBefore.paidAt, to: entry.paidAt.toISOString() },
      { field: 'notes', from: detailsBefore.notes, to: entry.notes ?? null },
    ].filter((change) => change.from !== change.to),
    metadata: {
      paymentId: String(entry._id),
      method: entry.method,
      reason,
      advanceCustomerId: outcome.advanceCustomerId ? String(outcome.advanceCustomerId) : null,
    },
    req: input.req,
  });

  if (outcome.advanceChange && outcome.advanceCustomerId) {
    await auditAdvance({
      actor: input.actor,
      customerId: outcome.advanceCustomerId,
      change: outcome.advanceChange,
      payableReference: entry.payableReference,
      paymentId: entry._id,
      req: input.req,
    });
  }

  return { entry, payable: summarise(entry.payableType, after) };
}

export interface DeletePaymentInput {
  merchantId: Types.ObjectId;
  paymentId: string;
  /** Why it was removed, kept in the audit trail. */
  reason?: string | null;
  actor: PaymentActor;
  req?: Request;
}

/**
 * Removes a payment that should never have been recorded — a duplicate, or one against
 * the wrong order. The payable is rebuilt from the entries that remain, in the same
 * transaction, and the audit trail keeps a full copy of what was removed.
 */
export async function deletePayment(
  input: DeletePaymentInput,
): Promise<{ payment: PaymentEntryDocument; payable: PayableSummary }> {
  const outcome = await withTransaction(async (session) => {
    const entry = await loadEntry(input.merchantId, input.paymentId, session);
    const adapter = adapterFor(entry.payableType);
    const doc = await adapter.load({
      merchantId: input.merchantId,
      payableId: String(entry.payableId),
      session,
    });
    const before = adapter.snapshot(doc);

    // The advance this payment created is taken back first; if it was already spent the
    // delete is refused, so the customer's advance never goes negative.
    const kept = entry.advanceMinor ?? 0;
    const advanceChange =
      kept > 0 && entry.advanceCustomerId
        ? await adjustCustomerAdvance(input.merchantId, entry.advanceCustomerId, -kept, session)
        : null;

    await PaymentEntry.deleteOne({ _id: entry._id }, session ? { session } : {});
    await rebuildFromLedger(adapter, doc, entry.payableType, session);

    return { entry, before, after: adapter.snapshot(doc), advanceChange };
  });

  const { entry, before, after, advanceChange } = outcome;
  const advanceMinor = entry.advanceMinor ?? 0;
  const reason = input.reason?.trim() || null;

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'payment.deleted',
    targetType: entry.payableType,
    targetId: entry.payableId,
    summary:
      `Deleted a ${describeMoneyMinor(entry.amountMinor + advanceMinor)} ${entry.method} payment on ${entry.payableReference}; ` +
      `${describeMoneyMinor(outstandingMinor(after.totalMinor, after.paidMinor))} outstanding.` +
      (reason ? ` Reason: ${reason}` : ''),
    changes: [
      { field: 'paidMinor', from: before.paidMinor, to: after.paidMinor },
      ...(advanceMinor > 0 ? [{ field: 'advanceMinor', from: advanceMinor, to: 0 }] : []),
    ],
    metadata: {
      reason,
      // A full copy, so a deleted payment can always be accounted for later.
      payment: {
        id: String(entry._id),
        amountMinor: entry.amountMinor,
        advanceMinor,
        advanceCustomerId: entry.advanceCustomerId ? String(entry.advanceCustomerId) : null,
        method: entry.method,
        reference: entry.reference ?? null,
        paidAt: entry.paidAt.toISOString(),
        notes: entry.notes ?? null,
        installmentNumber: entry.installmentNumber ?? null,
        recordedBy: entry.actorLabel,
        recordedAt: entry.createdAt.toISOString(),
      },
    },
    req: input.req,
  });

  if (advanceChange && entry.advanceCustomerId) {
    await auditAdvance({
      actor: input.actor,
      customerId: entry.advanceCustomerId,
      change: advanceChange,
      payableReference: entry.payableReference,
      paymentId: entry._id,
      req: input.req,
    });
  }

  return { payment: entry, payable: summarise(entry.payableType, after) };
}

export const PAYMENT_SORT_FIELDS = ['paidAt', 'amountMinor', 'createdAt'] as const;

export interface PaymentFilters {
  payableType?: PayableType;
  payableId?: string;
  method?: PaymentMethod;
  direction?: PaymentDirection;
  installmentNumber?: number;
  from?: Date;
  to?: Date;
}

/** Payment entries, newest first, for one payable or across the business. */
export async function listPayments(
  merchantId: Types.ObjectId,
  filters: PaymentFilters,
  pagination: { skip: number; limit: number },
  sort: Record<string, 1 | -1> = { paidAt: -1 },
): Promise<{ items: PaymentEntryDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId };
  if (filters.payableType) query.payableType = filters.payableType;
  if (filters.method) query.method = filters.method;
  if (filters.direction) query.direction = filters.direction;
  if (filters.installmentNumber) query.installmentNumber = filters.installmentNumber;
  if (filters.payableId) {
    if (!Types.ObjectId.isValid(filters.payableId)) {
      throw AppError.notFound('That record was not found.');
    }
    query.payableId = new Types.ObjectId(filters.payableId);
  }
  if (filters.from || filters.to) {
    query.paidAt = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    PaymentEntry.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    PaymentEntry.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Sums the entries for one payable.
 *
 * Used by the consistency tests, and available as a repair path if a stored
 * `paidMinor` is ever doubted — the counterpart of `recomputeQuantityFromLedger`.
 */
export async function recomputePaidFromEntries(
  payableType: PayableType,
  payableId: Types.ObjectId,
): Promise<number> {
  const result = await PaymentEntry.aggregate<{ total: number }>([
    { $match: { payableType, payableId } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);

  return result[0]?.total ?? 0;
}
