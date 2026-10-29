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
  actor: PaymentActor;
  req?: Request;
}

export interface RecordPaymentResult {
  entry: PaymentEntryDocument;
  snapshot: PayableSnapshot;
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

    // Refused rather than capped. A merchant who typed 50,000 instead of 5,000 needs
    // to be told, not quietly given a receipt for a different number.
    if (input.amountMinor > outstanding) {
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        `That is more than the outstanding amount of ${describeMoneyMinor(outstanding)}.`,
        { meta: { outstanding, total: before.totalMinor, paid: before.paidMinor } },
      );
    }

    const paidMinor = before.paidMinor + input.amountMinor;
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
          amountMinor: input.amountMinor,
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

    if (adapter.afterPayment) await adapter.afterPayment(doc, session);

    return { entry: entry!, snapshot: adapter.snapshot(doc) };
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'payment.recorded',
    targetType: input.payableType,
    targetId: result.snapshot.id,
    summary:
      `Recorded ${describeMoneyMinor(input.amountMinor)} against ${result.snapshot.label} ` +
      `by ${input.method}; ${describeMoneyMinor(outstandingMinor(result.snapshot.totalMinor, result.snapshot.paidMinor))} outstanding.`,
    changes: [
      {
        field: 'paidMinor',
        from: result.snapshot.paidMinor - input.amountMinor,
        to: result.snapshot.paidMinor,
      },
    ],
    metadata: {
      method: input.method,
      reference: input.reference ?? null,
      paidAt: paidAt.toISOString(),
    },
    req: input.req,
  });

  return result;
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
  /** The right amount. Omitted when only the descriptive fields change. */
  amountMinor?: number;
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

    const fromMinor = entry.amountMinor;
    const toMinor = amountMinor ?? fromMinor;
    const increase = toMinor - fromMinor;

    if (increase > 0 && before.cancelled) {
      throw AppError.conflict(
        'This record was cancelled, so a payment against it can only be lowered or deleted.',
      );
    }
    if (increase > 0 && before.paidMinor + increase > before.totalMinor) {
      const most = fromMinor + outstandingMinor(before.totalMinor, before.paidMinor);
      throw new AppError(
        409,
        ErrorCode.CONFLICT,
        `That would be more than the total of ${describeMoneyMinor(before.totalMinor)}. ` +
          `This payment can be at most ${describeMoneyMinor(most)}.`,
        { meta: { maxAmountMinor: most, total: before.totalMinor, paid: before.paidMinor } },
      );
    }

    const set: Record<string, unknown> = {};
    if (increase !== 0) set.amountMinor = toMinor;
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
    if (increase !== 0) await rebuildFromLedger(adapter, doc, entry.payableType, session);

    const updated = await loadEntry(input.merchantId, input.paymentId, session);
    return { entry: updated, after: adapter.snapshot(doc), before, fromMinor, toMinor, detailsBefore };
  });

  const { entry, after, before, fromMinor, toMinor, detailsBefore } = outcome;
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
          `outstanding.${reason ? ` Reason: ${reason}` : ''}`,
    changes: [
      { field: 'amountMinor', from: fromMinor, to: toMinor },
      { field: 'paidMinor', from: before.paidMinor, to: after.paidMinor },
      { field: 'reference', from: detailsBefore.reference, to: entry.reference ?? null },
      { field: 'paidAt', from: detailsBefore.paidAt, to: entry.paidAt.toISOString() },
      { field: 'notes', from: detailsBefore.notes, to: entry.notes ?? null },
    ].filter((change) => change.from !== change.to),
    metadata: { paymentId: String(entry._id), method: entry.method, reason },
    req: input.req,
  });

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

    await PaymentEntry.deleteOne({ _id: entry._id }, session ? { session } : {});
    await rebuildFromLedger(adapter, doc, entry.payableType, session);

    return { entry, before, after: adapter.snapshot(doc) };
  });

  const { entry, before, after } = outcome;
  const reason = input.reason?.trim() || null;

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'payment.deleted',
    targetType: entry.payableType,
    targetId: entry.payableId,
    summary:
      `Deleted a ${describeMoneyMinor(entry.amountMinor)} ${entry.method} payment on ${entry.payableReference}; ` +
      `${describeMoneyMinor(outstandingMinor(after.totalMinor, after.paidMinor))} outstanding.` +
      (reason ? ` Reason: ${reason}` : ''),
    changes: [{ field: 'paidMinor', from: before.paidMinor, to: after.paidMinor }],
    metadata: {
      reason,
      // A full copy, so a deleted payment can always be accounted for later.
      payment: {
        id: String(entry._id),
        amountMinor: entry.amountMinor,
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
