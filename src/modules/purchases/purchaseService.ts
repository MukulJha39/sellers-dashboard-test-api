import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import type { StockSubjectType } from '../../config/catalog';
import { withTransaction } from '../../db/transaction';
import { Purchase, type PurchaseDocument, type PurchaseLine } from '../../models/Purchase';
import { writeAudit } from '../../services/auditService';
import { nextReference } from '../../services/referenceService';
import { AppError } from '../../utils/AppError';
import { describeMoneyMinor, multiplyMoneyByQuantity, requireMoneyMinor } from '../../utils/money';
import { escapeRegex } from '../../utils/pagination';
import { describeQuantity, requireQuantityThousandths } from '../../utils/quantity';
import { assertQuantityFitsUnit } from '../catalog/itemService';
import {
  applyStockMovementInSession,
  auditStockMovement,
  loadStockSubject,
  type ApplyStockMovementInput,
  type StockActor,
  type StockMovementResult,
} from '../catalog/stockService';
import {
  derivePaymentStatus,
  outstandingMinor,
  registerPayable,
  type PayableSnapshot,
} from '../payments/paymentEngine';
import { loadSupplier, refreshSupplierTotals } from '../relationships/supplierService';

export interface PurchaseLineInput {
  subjectType?: StockSubjectType;
  subjectId?: string;
  quantity?: number;
  unitCostMinor?: number;
}

export interface PurchaseInput {
  supplierId?: string;
  lines?: PurchaseLineInput[];
  additionalCostMinor?: number;
  purchaseDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
  /** Take the goods into stock as part of recording the purchase. */
  receiveStock?: boolean;
}

function parseDate(value: string | null | undefined, field: string, fallback?: Date): Date | null {
  if (value === undefined || value === null || value.trim() === '') {
    return fallback ?? null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field, message: 'Enter a valid date.' },
    ]);
  }
  return parsed;
}

/**
 * Resolves the submitted lines against the merchant's own catalog and prices them.
 *
 * The name and unit are copied onto the line here, once. A purchase is a record of
 * what happened, so renaming an item next year must not change what this document
 * says was bought (PRD section 33).
 */
async function buildLines(
  merchantId: Types.ObjectId,
  inputs: PurchaseLineInput[],
): Promise<{ lines: PurchaseLine[]; subtotalMinor: number }> {
  if (inputs.length === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'lines', message: 'Add at least one material or item.' },
    ]);
  }

  const lines: PurchaseLine[] = [];
  const seen = new Set<string>();
  let subtotalMinor = 0;

  for (const [index, raw] of inputs.entries()) {
    const subjectType = raw.subjectType;
    if (subjectType !== 'item' && subjectType !== 'material') {
      throw AppError.validation('Please correct the highlighted fields.', [
        { field: `lines[${index}].subjectType`, message: 'Choose an item or a raw material.' },
      ]);
    }

    const key = `${subjectType}:${raw.subjectId ?? ''}`;
    if (seen.has(key)) {
      // Two lines for the same thing make the received quantity ambiguous and the
      // purchase harder to read; one line with the full quantity is what was meant.
      throw AppError.validation('Please correct the highlighted fields.', [
        { field: `lines[${index}].subjectId`, message: 'This is already on the purchase. Change its quantity instead.' },
      ]);
    }
    seen.add(key);

    const subject = await loadStockSubject(subjectType, raw.subjectId ?? '', merchantId);
    if (subject.archived) {
      throw AppError.conflict(`${subject.name} is archived. Restore it before buying more.`);
    }

    const quantityField = `lines[${index}].quantity`;
    const quantityThousandths = requireQuantityThousandths(raw.quantity, quantityField, {
      allowZero: false,
    });
    // Pieces are counted, not measured: buying 2.5 of them is not a thing.
    assertQuantityFitsUnit(subject.unit, quantityThousandths, quantityField);

    const unitCostMinor = requireMoneyMinor(raw.unitCostMinor, `lines[${index}].unitCostMinor`);
    const lineTotalMinor = multiplyMoneyByQuantity(unitCostMinor, quantityThousandths);

    lines.push({
      subjectType,
      subjectId: subject._id,
      name: subject.name,
      unit: subject.unit,
      quantityThousandths,
      unitCostMinor,
      lineTotalMinor,
    });
    subtotalMinor += lineTotalMinor;
  }

  return { lines, subtotalMinor };
}

/** The stock movement that corresponds to one purchase line. */
function receiptFor(
  purchase: PurchaseDocument,
  line: PurchaseLine,
  actor: StockActor,
  req?: Request,
): ApplyStockMovementInput {
  return {
    merchantId: purchase.merchantId,
    subjectType: line.subjectType,
    subjectId: String(line.subjectId),
    type: 'receipt',
    deltaThousandths: line.quantityThousandths,
    note: `Received on purchase ${purchase.reference}`,
    actor,
    reference: { type: 'purchase', id: purchase._id },
    req,
  };
}

/**
 * Records a purchase, optionally taking the goods into stock.
 *
 * When stock is received, the ledger entries and the purchase document are written in
 * one transaction. Splitting them would allow a purchase that claims to be received
 * next to stock that never moved — a discrepancy a merchant cannot diagnose and the
 * ledger cannot explain.
 */
export async function createPurchase(input: {
  merchantId: Types.ObjectId;
  data: PurchaseInput;
  actor: StockActor;
  req?: Request;
}): Promise<PurchaseDocument> {
  const supplier = await loadSupplier(input.merchantId, input.data.supplierId ?? '');
  if (supplier.archived) {
    throw AppError.conflict(`${supplier.name} is archived. Restore them before recording a purchase.`);
  }

  const { lines, subtotalMinor } = await buildLines(input.merchantId, input.data.lines ?? []);
  const additionalCostMinor = requireMoneyMinor(
    input.data.additionalCostMinor ?? 0,
    'additionalCostMinor',
  );

  const purchaseDate = parseDate(input.data.purchaseDate, 'purchaseDate', new Date())!;
  const dueDate = parseDate(input.data.dueDate, 'dueDate');
  const receiveStock = input.data.receiveStock !== false;

  const movements: StockMovementResult[] = [];
  const movementInputs: ApplyStockMovementInput[] = [];

  const purchase = await withTransaction(async (session) => {
    const reference = await nextReference(input.merchantId, 'purchase', session);

    const [created] = await Purchase.create(
      [
        {
          merchantId: input.merchantId,
          reference,
          supplierId: supplier._id,
          supplierName: supplier.name,
          lines,
          subtotalMinor,
          additionalCostMinor,
          totalMinor: subtotalMinor + additionalCostMinor,
          purchaseDate,
          dueDate,
          notes: input.data.notes?.trim() || null,
          status: 'recorded',
          received: receiveStock,
          receivedAt: receiveStock ? new Date() : null,
          paidMinor: 0,
          paymentStatus: 'unpaid',
        },
      ],
      { session, ordered: true },
    );

    const doc = created!;

    if (receiveStock) {
      for (const line of doc.lines) {
        const movementInput = receiptFor(doc, line, input.actor, input.req);
        movementInputs.push(movementInput);
        movements.push(await applyStockMovementInSession(session, movementInput));
      }
    }

    await refreshSupplierTotals(input.merchantId, supplier._id, session);
    return doc;
  });

  // Audits are written after the transaction commits, so a slow audit write cannot
  // hold a lock and a failed one cannot roll back a purchase that really happened.
  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'purchase.created',
    targetType: 'purchase',
    targetId: purchase._id,
    summary:
      `Recorded purchase ${purchase.reference} from ${purchase.supplierName} ` +
      `for ${describeMoneyMinor(purchase.totalMinor)}` +
      `${purchase.received ? ' and received the stock' : ''}.`,
    metadata: {
      lines: purchase.lines.length,
      received: purchase.received,
      total: purchase.totalMinor,
    },
    req: input.req,
  });

  for (const [index, movement] of movements.entries()) {
    await auditStockMovement(movementInputs[index]!, movement);
  }

  return purchase;
}

export async function loadPurchase(
  merchantId: Types.ObjectId,
  purchaseId: string,
  session?: ClientSession,
): Promise<PurchaseDocument> {
  if (!Types.ObjectId.isValid(purchaseId)) {
    throw AppError.notFound('That purchase was not found.');
  }

  const query = Purchase.findOne({ _id: purchaseId, merchantId });
  if (session) query.session(session);

  const purchase = await query;
  if (!purchase) throw AppError.notFound('That purchase was not found.');
  return purchase;
}

/**
 * Takes the goods on an already-recorded purchase into stock.
 *
 * Separate from creation because the two genuinely happen apart: a merchant records
 * the bill when it arrives and receives the goods when the van does.
 */
export async function receivePurchase(input: {
  merchantId: Types.ObjectId;
  purchaseId: string;
  actor: StockActor;
  req?: Request;
}): Promise<PurchaseDocument> {
  const movements: StockMovementResult[] = [];
  const movementInputs: ApplyStockMovementInput[] = [];

  const purchase = await withTransaction(async (session) => {
    const doc = await loadPurchase(input.merchantId, input.purchaseId, session);

    if (doc.status === 'cancelled') {
      throw AppError.conflict('This purchase was cancelled, so its stock cannot be received.');
    }
    if (doc.received) {
      throw AppError.conflict('This purchase has already been received.');
    }

    for (const line of doc.lines) {
      const movementInput = receiptFor(doc, line, input.actor, input.req);
      movementInputs.push(movementInput);
      movements.push(await applyStockMovementInSession(session, movementInput));
    }

    doc.received = true;
    doc.receivedAt = new Date();
    await doc.save({ session });

    return doc;
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'purchase.received',
    targetType: 'purchase',
    targetId: purchase._id,
    summary: `Received the stock on purchase ${purchase.reference} from ${purchase.supplierName}.`,
    metadata: { lines: purchase.lines.length },
    req: input.req,
  });

  for (const [index, movement] of movements.entries()) {
    await auditStockMovement(movementInputs[index]!, movement);
  }

  return purchase;
}

/**
 * Cancels a purchase, putting back any stock it brought in.
 *
 * Two rules, both chosen so the outcome is predictable rather than convenient:
 *
 * - A purchase with payments against it cannot be cancelled. Cancelling would strand
 *   the money with nothing to belong to. Supplier returns and refunds are the right
 *   instrument, and they arrive in Phase 5.
 * - If the received goods have since been sold or written off, the reversal would drive
 *   stock negative. That is refused with the shortfall named, rather than silently
 *   clamping to zero and leaving the ledger unable to explain the quantity.
 */
export async function cancelPurchase(input: {
  merchantId: Types.ObjectId;
  purchaseId: string;
  reason?: string | null;
  actor: StockActor;
  req?: Request;
}): Promise<PurchaseDocument> {
  const movements: StockMovementResult[] = [];
  const movementInputs: ApplyStockMovementInput[] = [];

  const purchase = await withTransaction(async (session) => {
    const doc = await loadPurchase(input.merchantId, input.purchaseId, session);

    if (doc.status === 'cancelled') {
      throw AppError.conflict('This purchase is already cancelled.');
    }
    if (doc.paidMinor > 0) {
      throw AppError.conflict(
        `${describeMoneyMinor(doc.paidMinor)} has already been paid against this purchase, so it cannot be cancelled.`,
        { meta: { paid: doc.paidMinor } },
      );
    }

    if (doc.received) {
      for (const line of doc.lines) {
        const movementInput: ApplyStockMovementInput = {
          merchantId: doc.merchantId,
          subjectType: line.subjectType,
          subjectId: String(line.subjectId),
          type: 'reversal',
          deltaThousandths: -line.quantityThousandths,
          note: `Purchase ${doc.reference} cancelled`,
          actor: input.actor,
          reference: { type: 'purchase', id: doc._id },
          req: input.req,
        };
        movementInputs.push(movementInput);
        movements.push(await applyStockMovementInSession(session, movementInput));
      }

      doc.received = false;
      doc.receivedAt = null;
    }

    doc.status = 'cancelled';
    doc.cancelledAt = new Date();
    doc.cancelledReason = input.reason?.trim() || null;
    await doc.save({ session });

    await refreshSupplierTotals(input.merchantId, doc.supplierId, session);
    return doc;
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'purchase.cancelled',
    targetType: 'purchase',
    targetId: purchase._id,
    summary:
      `Cancelled purchase ${purchase.reference} from ${purchase.supplierName}` +
      `${movements.length > 0 ? `, returning ${movements.length} line(s) of stock` : ''}.`,
    metadata: { reason: purchase.cancelledReason, reversedLines: movements.length },
    req: input.req,
  });

  for (const [index, movement] of movements.entries()) {
    await auditStockMovement(movementInputs[index]!, movement);
  }

  return purchase;
}

/**
 * Edits the parts of a purchase that carry no consequences elsewhere.
 *
 * Lines, totals and the supplier are not editable. Changing them after the stock has
 * moved and payments have landed would require unwinding both, and "cancel and record
 * it again" is a path a merchant can understand and verify.
 */
export async function updatePurchase(input: {
  merchantId: Types.ObjectId;
  purchaseId: string;
  data: { purchaseDate?: string | null; dueDate?: string | null; notes?: string | null };
  actor: StockActor;
  req?: Request;
}): Promise<PurchaseDocument> {
  const purchase = await loadPurchase(input.merchantId, input.purchaseId);

  if (purchase.status === 'cancelled') {
    throw AppError.conflict('This purchase was cancelled, so it cannot be edited.');
  }

  if (input.data.purchaseDate !== undefined) {
    purchase.purchaseDate = parseDate(input.data.purchaseDate, 'purchaseDate', purchase.purchaseDate)!;
  }
  if (input.data.dueDate !== undefined) {
    purchase.dueDate = parseDate(input.data.dueDate, 'dueDate');
  }
  if (input.data.notes !== undefined) {
    purchase.notes = input.data.notes?.trim() || null;
  }

  await purchase.save();
  await refreshSupplierTotals(input.merchantId, purchase.supplierId);

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'purchase.updated',
    targetType: 'purchase',
    targetId: purchase._id,
    summary: `Updated purchase ${purchase.reference}.`,
    req: input.req,
  });

  return purchase;
}

export const PURCHASE_SORT_FIELDS = ['purchaseDate', 'createdAt', 'totalMinor', 'dueDate'] as const;

export interface PurchaseFilters {
  search?: string;
  supplierId?: string;
  subjectId?: string;
  status?: 'recorded' | 'cancelled';
  paymentStatus?: 'unpaid' | 'partially_paid' | 'fully_paid';
  overdue?: boolean;
  received?: boolean;
  from?: Date;
  to?: Date;
}

export function purchaseQuery(
  merchantId: Types.ObjectId,
  filters: PurchaseFilters,
  now: Date = new Date(),
): Record<string, unknown> {
  const query: Record<string, unknown> = { merchantId };

  if (filters.status) query.status = filters.status;
  if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
  if (filters.received !== undefined) query.received = filters.received;

  if (filters.supplierId) {
    if (!Types.ObjectId.isValid(filters.supplierId)) {
      throw AppError.notFound('That supplier was not found.');
    }
    query.supplierId = new Types.ObjectId(filters.supplierId);
  }

  if (filters.subjectId) {
    if (!Types.ObjectId.isValid(filters.subjectId)) {
      throw AppError.notFound('That record was not found.');
    }
    query['lines.subjectId'] = new Types.ObjectId(filters.subjectId);
  }

  // Overdue is computed from the clock, so it is a query rather than a stored flag.
  if (filters.overdue) {
    query.status = 'recorded';
    query.paymentStatus = { $ne: 'fully_paid' };
    query.dueDate = { $ne: null, $lt: now };
  }

  if (filters.from || filters.to) {
    query.purchaseDate = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [{ reference: pattern }, { supplierName: pattern }, { 'lines.name': pattern }];
  }

  return query;
}

export async function listPurchases(
  merchantId: Types.ObjectId,
  filters: PurchaseFilters,
  pagination: { skip: number; limit: number },
  sort: Record<string, 1 | -1>,
): Promise<{ items: PurchaseDocument[]; total: number }> {
  const query = purchaseQuery(merchantId, filters);

  const [items, total] = await Promise.all([
    Purchase.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Purchase.countDocuments(query),
  ]);

  return { items, total };
}

/** Totals for the dashboard's purchase card. */
export async function purchaseSummary(merchantId: Types.ObjectId): Promise<{
  recorded: number;
  awaitingStock: number;
  unpaid: number;
  overdue: number;
  outstandingMinor: number;
  spentThisMonthMinor: number;
}> {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [counts, outstanding, thisMonth] = await Promise.all([
    Purchase.aggregate<{ _id: null; recorded: number; awaitingStock: number; unpaid: number; overdue: number }>([
      { $match: { merchantId, status: 'recorded' } },
      {
        $group: {
          _id: null,
          recorded: { $sum: 1 },
          awaitingStock: { $sum: { $cond: ['$received', 0, 1] } },
          unpaid: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'fully_paid'] }, 0, 1] } },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$paymentStatus', 'fully_paid'] },
                    { $ne: ['$dueDate', null] },
                    { $lt: ['$dueDate', now] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    Purchase.aggregate<{ total: number }>([
      { $match: { merchantId, status: 'recorded' } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } } } },
    ]),
    Purchase.aggregate<{ total: number }>([
      { $match: { merchantId, status: 'recorded', purchaseDate: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$totalMinor' } } },
    ]),
  ]);

  return {
    recorded: counts[0]?.recorded ?? 0,
    awaitingStock: counts[0]?.awaitingStock ?? 0,
    unpaid: counts[0]?.unpaid ?? 0,
    overdue: counts[0]?.overdue ?? 0,
    outstandingMinor: Math.max(0, outstanding[0]?.total ?? 0),
    spentThisMonthMinor: thisMonth[0]?.total ?? 0,
  };
}

/**
 * Registers purchases with the payment engine.
 *
 * Done here, at module load, so the engine never imports the Purchase model and Phase
 * 4's orders can register themselves the same way without either knowing about the
 * other.
 */
registerPayable<PurchaseDocument>('purchase', {
  direction: 'out',

  load: ({ merchantId, payableId, session }) => loadPurchase(merchantId, payableId, session),

  snapshot: (doc): PayableSnapshot => ({
    id: doc._id,
    merchantId: doc.merchantId,
    reference: doc.reference,
    label: `purchase ${doc.reference}`,
    totalMinor: doc.totalMinor,
    paidMinor: doc.paidMinor,
    dueDate: doc.dueDate ?? null,
    cancelled: doc.status === 'cancelled',
  }),

  applyPayment: (doc, next) => {
    doc.paidMinor = next.paidMinor;
    doc.paymentStatus = next.paymentStatus;
  },

  save: (doc, session) => doc.save({ session }).then(() => undefined),

  // A purchase payment changes what the merchant owes that supplier, and the supplier
  // list shows that figure, so it is brought back in step inside the same transaction.
  afterPayment: (doc, session) => refreshSupplierTotals(doc.merchantId, doc.supplierId, session),
});

/** Re-exported for the tests, which check the derivation against the stored status. */
export { derivePaymentStatus, outstandingMinor, describeQuantity };
