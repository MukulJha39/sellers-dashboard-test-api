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

/** What may be corrected on an entry after the fact. Money is not on this list. */
export interface AnnotatePaymentInput {
  merchantId: Types.ObjectId;
  paymentId: string;
  reference?: string | null;
  paidAt?: Date;
  notes?: string | null;
  actor: PaymentActor;
  req?: Request;
}

/**
 * Corrects the descriptive fields of a payment entry.
 *
 * Entries stay append-only where it counts: the **amount, the method, the payable and the
 * balance it left behind can never change**, because a total has to remain explainable by
 * the sum of its entries and a history that can be rewritten is not a history. What can be
 * corrected is what the entry *says about itself* — a mistyped cheque number, a note, or
 * the date the money actually changed hands. None of those move a rupee.
 *
 * A wrong amount is not fixed here. It is fixed by a further entry, and refunds and credit
 * notes arrive in Phase 5.
 */
export async function annotatePayment(
  input: AnnotatePaymentInput,
): Promise<PaymentEntryDocument> {
  if (!Types.ObjectId.isValid(input.paymentId)) {
    throw AppError.notFound('That payment was not found.');
  }

  const entry = await PaymentEntry.findOne({
    _id: input.paymentId,
    merchantId: input.merchantId,
  });
  if (!entry) throw AppError.notFound('That payment was not found.');

  const before = {
    reference: entry.reference ?? null,
    paidAt: entry.paidAt.toISOString(),
    notes: entry.notes ?? null,
  };

  // Presence, not truthiness: an explicit null is how a reference or a note is cleared.
  if (input.reference !== undefined) entry.reference = input.reference;
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.paidAt !== undefined) entry.paidAt = input.paidAt;

  await entry.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'payment.annotated',
    targetType: entry.payableType,
    targetId: entry.payableId,
    summary:
      `Corrected the details of a ${describeMoneyMinor(entry.amountMinor)} payment on ` +
      `${entry.payableReference}. The amount was not changed.`,
    changes: [
      { field: 'reference', from: before.reference, to: entry.reference ?? null },
      { field: 'paidAt', from: before.paidAt, to: entry.paidAt.toISOString() },
      { field: 'notes', from: before.notes, to: entry.notes ?? null },
    ].filter((change) => change.from !== change.to),
    req: input.req,
  });

  return entry;
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
