import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import type { StockAdjustmentReason, StockMovementType, StockSubjectType } from '../../config/catalog';
import { withTransaction } from '../../db/transaction';
import { Item, type ItemDocument } from '../../models/Item';
import { RawMaterial, type RawMaterialDocument } from '../../models/RawMaterial';
import { StockMovement, type StockMovementDocument } from '../../models/StockMovement';
import { computeIsLowStock } from '../../models/stockFields';
import { writeAudit } from '../../services/auditService';
import { AppError, ErrorCode } from '../../utils/AppError';
import { describeQuantity, fromThousandths } from '../../utils/quantity';

/** Who is making the change, for the ledger and the audit trail. */
export interface StockActor {
  type: 'merchant' | 'admin' | 'system';
  id?: Types.ObjectId | null;
  label: string;
}

export type StockSubject = ItemDocument | RawMaterialDocument;

/** Movement types that count towards "everything ever received" (PRD section 6.2). */
const RECEIVING_TYPES: ReadonlySet<StockMovementType> = new Set<StockMovementType>([
  'opening',
  'receipt',
]);

/**
 * Items and materials are separate models, so the lookup branches rather than
 * returning a union whose query methods TypeScript cannot reconcile.
 */
async function findStockSubject(
  subjectType: StockSubjectType,
  subjectId: string,
  merchantId: Types.ObjectId,
  session?: ClientSession,
): Promise<StockSubject | null> {
  if (subjectType === 'item') {
    const query = Item.findOne({ _id: subjectId, merchantId });
    if (session) query.session(session);
    return query;
  }

  const query = RawMaterial.findOne({ _id: subjectId, merchantId });
  if (session) query.session(session);
  return query;
}

/**
 * Loads a stock-tracked record, scoped to its owner.
 *
 * The merchant id is part of the query, so one merchant can never reach another's
 * record even with a valid id (PRD section 28).
 */
export async function loadStockSubject(
  subjectType: StockSubjectType,
  subjectId: string,
  merchantId: Types.ObjectId,
  session?: ClientSession,
): Promise<StockSubject> {
  if (!Types.ObjectId.isValid(subjectId)) {
    throw AppError.notFound('That record was not found.');
  }

  const subject = await findStockSubject(subjectType, subjectId, merchantId, session);
  if (!subject) throw AppError.notFound('That record was not found.');
  return subject;
}

export interface ApplyStockMovementInput {
  merchantId: Types.ObjectId;
  subjectType: StockSubjectType;
  subjectId: string;
  type: StockMovementType;
  reason?: StockAdjustmentReason | null;
  /** Signed change in thousandths of the unit. */
  deltaThousandths: number;
  note?: string | null;
  actor: StockActor;
  reference?: { type: string; id?: Types.ObjectId | null } | null;
  req?: Request;
}

export interface StockMovementResult {
  subject: StockSubject;
  movement: StockMovementDocument;
}

/**
 * Applies one change to a stock-tracked record and records it in the ledger.
 *
 * The balance written to the ledger and the quantity cached on the record are produced
 * together inside a transaction, so a quantity can never exist that the ledger cannot
 * explain (PRD section 33).
 */
export async function applyStockMovement(
  input: ApplyStockMovementInput,
): Promise<StockMovementResult> {
  const result = await withTransaction((session) => applyStockMovementInSession(session, input));
  await auditStockMovement(input, result);
  return result;
}

/**
 * The body of a stock movement, running inside a session the caller owns.
 *
 * Exposed separately so work that must be atomic *with* a stock change — receiving a
 * purchase writes the ledger entries and marks the purchase received — can put all of
 * it in one transaction. Starting a nested transaction here instead would leave a
 * purchase that claims to be received alongside stock that never moved.
 *
 * The caller is responsible for the audit entry; `auditStockMovement` writes it, after
 * the transaction has committed.
 */
export async function applyStockMovementInSession(
  session: ClientSession | undefined,
  input: ApplyStockMovementInput,
): Promise<StockMovementResult> {
  if (input.deltaThousandths === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'quantity', message: 'Enter a quantity other than zero.' },
    ]);
  }

  const subject = await loadStockSubject(
    input.subjectType,
    input.subjectId,
    input.merchantId,
    session,
  );

  if (!subject.trackStock) {
    throw AppError.conflict('Stock is not tracked for this record, so it cannot be adjusted.');
  }
  if (subject.archived) {
    throw AppError.conflict('Restore this record before changing its stock.');
  }

  const balanceAfter = subject.quantityThousandths + input.deltaThousandths;
  if (balanceAfter < 0) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `There is not enough stock. Available: ${describeQuantity(subject.quantityThousandths)} ${subject.unit}.`,
      { meta: { available: fromThousandths(subject.quantityThousandths), unit: subject.unit } },
    );
  }

  subject.quantityThousandths = balanceAfter;
  if (RECEIVING_TYPES.has(input.type) && input.deltaThousandths > 0) {
    subject.totalReceivedThousandths += input.deltaThousandths;
  }
  subject.isLowStock = computeIsLowStock({
    trackStock: subject.trackStock,
    quantityThousandths: subject.quantityThousandths,
    lowStockThresholdThousandths: subject.lowStockThresholdThousandths,
  });

  await subject.save({ session });

  const [movement] = await StockMovement.create(
    [
      {
        merchantId: input.merchantId,
        subjectType: input.subjectType,
        subjectId: subject._id,
        subjectName: subject.name,
        type: input.type,
        reason: input.reason ?? null,
        deltaThousandths: input.deltaThousandths,
        balanceAfterThousandths: balanceAfter,
        note: input.note ?? null,
        actorType: input.actor.type,
        actorId: input.actor.id ?? null,
        actorLabel: input.actor.label,
        referenceType: input.reference?.type ?? null,
        referenceId: input.reference?.id ?? null,
      },
    ],
    { session, ordered: true },
  );

  return { subject, movement: movement! };
}

/** Records a committed stock movement in the audit trail (PRD section 27). */
export async function auditStockMovement(
  input: ApplyStockMovementInput,
  result: StockMovementResult,
): Promise<void> {
  const direction = input.deltaThousandths > 0 ? 'increased' : 'decreased';
  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'stock.adjusted',
    targetType: input.subjectType,
    targetId: result.subject._id,
    summary:
      `Stock for ${result.subject.name} ${direction} by ` +
      `${describeQuantity(Math.abs(input.deltaThousandths))} ${result.subject.unit} ` +
      `(${input.reason ?? input.type}); now ${describeQuantity(result.subject.quantityThousandths)}.`,
    changes: [
      {
        field: 'quantity',
        from: fromThousandths(result.subject.quantityThousandths - input.deltaThousandths),
        to: fromThousandths(result.subject.quantityThousandths),
      },
    ],
    metadata: { reason: input.reason ?? null, type: input.type, note: input.note ?? null },
    req: input.req,
  });
}

/**
 * Sets stock to an exact figure, which is what a recount produces.
 *
 * Expressed as a delta so the ledger still shows what changed rather than only the
 * new total.
 */
export async function setStockQuantity(input: {
  merchantId: Types.ObjectId;
  subjectType: StockSubjectType;
  subjectId: string;
  targetThousandths: number;
  reason: StockAdjustmentReason;
  note?: string | null;
  actor: StockActor;
  req?: Request;
}): Promise<StockMovementResult> {
  const subject = await loadStockSubject(input.subjectType, input.subjectId, input.merchantId);
  const delta = input.targetThousandths - subject.quantityThousandths;

  if (delta === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'quantity', message: 'That is already the recorded quantity.' },
    ]);
  }

  return applyStockMovement({
    merchantId: input.merchantId,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    type: 'adjustment',
    reason: input.reason,
    deltaThousandths: delta,
    note: input.note ?? null,
    actor: input.actor,
    req: input.req,
  });
}

/**
 * Records the stock a record starts life with.
 *
 * Kept separate from an adjustment so a merchant's first quantity reads as an opening
 * balance rather than a correction.
 */
export async function recordOpeningStock(input: {
  merchantId: Types.ObjectId;
  subjectType: StockSubjectType;
  subject: StockSubject;
  quantityThousandths: number;
  actor: StockActor;
  req?: Request;
}): Promise<void> {
  if (input.quantityThousandths <= 0) return;

  await applyStockMovement({
    merchantId: input.merchantId,
    subjectType: input.subjectType,
    subjectId: String(input.subject._id),
    type: 'opening',
    reason: 'opening_stock',
    deltaThousandths: input.quantityThousandths,
    actor: input.actor,
    req: input.req,
  });
}

export const MOVEMENT_SORT_FIELDS = ['createdAt'] as const;

export interface MovementFilters {
  subjectType?: StockSubjectType;
  subjectId?: string;
  type?: StockMovementType;
  reason?: StockAdjustmentReason;
}

/** Stock history, newest first, for one record or for the whole business. */
export async function listStockMovements(
  merchantId: Types.ObjectId,
  filters: MovementFilters,
  pagination: { skip: number; limit: number },
): Promise<{ items: StockMovementDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId };
  if (filters.subjectType) query.subjectType = filters.subjectType;
  if (filters.type) query.type = filters.type;
  if (filters.reason) query.reason = filters.reason;
  if (filters.subjectId) {
    if (!Types.ObjectId.isValid(filters.subjectId)) {
      throw AppError.notFound('That record was not found.');
    }
    query.subjectId = new Types.ObjectId(filters.subjectId);
  }

  const [items, total] = await Promise.all([
    StockMovement.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    StockMovement.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Recomputes a record's cached quantity from the ledger.
 *
 * Used by the consistency tests, and available as a repair path if a cached quantity
 * is ever doubted.
 */
export async function recomputeQuantityFromLedger(
  subjectType: StockSubjectType,
  subjectId: Types.ObjectId,
): Promise<number> {
  const result = await StockMovement.aggregate<{ total: number }>([
    { $match: { subjectType, subjectId } },
    { $group: { _id: null, total: { $sum: '$deltaThousandths' } } },
  ]);

  return result[0]?.total ?? 0;
}
