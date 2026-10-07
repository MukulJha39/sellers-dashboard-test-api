import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import type { BillingUnit } from '../../config/catalog';
import { DURATION_BILLING_UNITS } from '../../config/catalog';
import type { DiscountType, OrderLineType, OrderStatus } from '../../config/orders';
import {
  canTransition,
  EDITABLE_ORDER_STATUSES,
  holdsStock,
  MAX_INSTALLMENTS,
  ORDER_TRANSITIONS,
  TERMINAL_ORDER_STATUSES,
} from '../../config/orders';
import { withTransaction } from '../../db/transaction';
import { AuditLog, type AuditLogDocument } from '../../models/AuditLog';
import { Item, type ItemDocument } from '../../models/Item';
import { Order, type OrderDocument, type OrderInstallment, type OrderLine } from '../../models/Order';
import { ServiceOffering } from '../../models/ServiceOffering';
import { writeAudit } from '../../services/auditService';
import { nextReference } from '../../services/referenceService';
import { AppError } from '../../utils/AppError';
import { describeMoneyMinor, requireMoneyMinor } from '../../utils/money';
import { escapeRegex } from '../../utils/pagination';
import { requireQuantityThousandths } from '../../utils/quantity';
import { assertQuantityFitsUnit } from '../catalog/itemService';
import {
  applyStockMovementInSession,
  auditStockMovement,
  type ApplyStockMovementInput,
  type StockActor,
  type StockMovementResult,
} from '../catalog/stockService';
import {
  derivePaymentStatus,
  registerPayable,
  type PayableSnapshot,
} from '../payments/paymentEngine';
import { loadCustomer, refreshCustomerOutstanding } from '../relationships/customerService';
import { assertPlanMatchesTotal, computeTotals, splitIntoInstallments } from './orderTotals';

export interface OrderLineInput {
  lineType?: OrderLineType;
  subjectId?: string;
  quantity?: number;
  /** Omitted to use the record's own price, which is the common case. */
  unitRateMinor?: number;
  durationMinutes?: number | null;
}

export interface OrderInput {
  /** Omitted for an anonymous counter sale, which the PRD allows (section 8). */
  customerId?: string | null;
  lines?: OrderLineInput[];
  discountType?: DiscountType;
  discountMinor?: number;
  discountPercent?: number;
  taxPercent?: number;
  status?: OrderStatus;
  orderDate?: string | null;
  dueDate?: string | null;
  notes?: string | null;
}

function parseDate(value: string | null | undefined, field: string, fallback?: Date): Date | null {
  if (value === undefined || value === null || value.trim() === '') return fallback ?? null;

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
 * Names and rates are copied onto the line here, once. Repricing an item next week must
 * not change what a customer was charged last Tuesday (PRD section 33).
 */
async function buildLines(
  merchantId: Types.ObjectId,
  inputs: OrderLineInput[],
): Promise<OrderLine[]> {
  if (inputs.length === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'lines', message: 'Add at least one item or service.' },
    ]);
  }

  const lines: OrderLine[] = [];
  const seen = new Set<string>();

  for (const [index, raw] of inputs.entries()) {
    const lineType = raw.lineType;
    if (lineType !== 'item' && lineType !== 'service') {
      throw AppError.validation('Please correct the highlighted fields.', [
        { field: `lines[${index}].lineType`, message: 'Choose an item or a service.' },
      ]);
    }

    const subjectId = raw.subjectId ?? '';
    if (!Types.ObjectId.isValid(subjectId)) {
      throw AppError.notFound('That record was not found.');
    }

    const key = `${lineType}:${subjectId}`;
    if (seen.has(key)) {
      // One line per record: two lines for the same thing make the stock effect
      // ambiguous and the receipt harder to read.
      throw AppError.validation('Please correct the highlighted fields.', [
        {
          field: `lines[${index}].subjectId`,
          message: 'This is already on the order. Change its quantity instead.',
        },
      ]);
    }
    seen.add(key);

    const quantityField = `lines[${index}].quantity`;

    if (lineType === 'item') {
      const item = await Item.findOne({ _id: subjectId, merchantId });
      if (!item) throw AppError.notFound('That item was not found.');
      if (item.archived) {
        throw AppError.conflict(`${item.name} is archived. Restore it before selling it.`);
      }

      const quantityThousandths = requireQuantityThousandths(raw.quantity, quantityField, {
        allowZero: false,
      });
      assertQuantityFitsUnit(item.unit, quantityThousandths, quantityField);

      const unitRateMinor =
        raw.unitRateMinor === undefined
          ? item.sellingPriceMinor
          : requireMoneyMinor(raw.unitRateMinor, `lines[${index}].unitRateMinor`);

      lines.push({
        lineType: 'item',
        subjectId: item._id,
        name: item.name,
        unit: item.unit,
        billingUnit: null,
        quantityThousandths,
        unitRateMinor,
        durationMinutes: null,
        lineTotalMinor: 0,
      });
      continue;
    }

    const service = await ServiceOffering.findOne({ _id: subjectId, merchantId });
    if (!service) throw AppError.notFound('That service was not found.');
    if (service.archived) {
      throw AppError.conflict(`${service.name} is archived. Restore it before selling it.`);
    }
    if (!service.isActive) {
      throw AppError.conflict(`${service.name} is not being offered at the moment.`);
    }

    const quantityThousandths = requireQuantityThousandths(raw.quantity, quantityField, {
      allowZero: false,
    });

    const unitRateMinor =
      raw.unitRateMinor === undefined
        ? service.rateMinor
        : requireMoneyMinor(raw.unitRateMinor, `lines[${index}].unitRateMinor`);

    // A duration only means something for time-based billing, so it is kept only there.
    const supportsDuration = DURATION_BILLING_UNITS.has(service.billingUnit as BillingUnit);
    const durationMinutes = supportsDuration
      ? raw.durationMinutes ?? service.durationMinutes ?? null
      : null;

    lines.push({
      lineType: 'service',
      subjectId: service._id,
      name: service.name,
      unit: null,
      billingUnit: service.billingUnit,
      quantityThousandths,
      unitRateMinor,
      durationMinutes,
      lineTotalMinor: 0,
    });
  }

  return lines;
}

/** Prices the lines and returns the order-level amounts alongside them. */
function priceOrder(lines: OrderLine[], data: OrderInput) {
  const totals = computeTotals({
    lines: lines.map((line) => ({
      quantityThousandths: line.quantityThousandths,
      unitRateMinor: line.unitRateMinor,
    })),
    discountType: data.discountType ?? 'none',
    ...(data.discountMinor !== undefined ? { discountMinor: data.discountMinor } : {}),
    ...(data.discountPercent !== undefined ? { discountPercent: data.discountPercent } : {}),
    ...(data.taxPercent !== undefined ? { taxPercent: data.taxPercent } : {}),
  });

  for (const [index, line] of lines.entries()) {
    line.lineTotalMinor = totals.lineTotalsMinor[index]!;
  }

  return totals;
}

/** The stock movement that corresponds to selling one item line. */
function saleMovement(
  order: OrderDocument,
  line: OrderLine,
  actor: StockActor,
  req?: Request,
): ApplyStockMovementInput {
  return {
    merchantId: order.merchantId,
    subjectType: 'item',
    subjectId: String(line.subjectId),
    type: 'sale',
    deltaThousandths: -line.quantityThousandths,
    note: `Sold on order ${order.reference}`,
    actor,
    reference: { type: 'order', id: order._id },
    req,
  };
}

/** The movement that puts one item line back, on a cancellation or a return. */
function restoreMovement(
  order: OrderDocument,
  line: OrderLine,
  actor: StockActor,
  reason: 'cancelled' | 'returned',
  req?: Request,
): ApplyStockMovementInput {
  return {
    merchantId: order.merchantId,
    subjectType: 'item',
    subjectId: String(line.subjectId),
    type: reason === 'returned' ? 'return' : 'reversal',
    deltaThousandths: line.quantityThousandths,
    note: `Order ${order.reference} ${reason}`,
    actor,
    reference: { type: 'order', id: order._id },
    req,
  };
}

/** Only item lines move stock, and only the ones whose item is tracked. */
function stockLines(order: OrderDocument): OrderLine[] {
  return order.lines.filter((line) => line.lineType === 'item');
}

/**
 * Takes the sold items out of stock, inside the caller's transaction.
 *
 * Services are skipped entirely: there is no quantity to move, which is the guarantee
 * that selling a service can never change one.
 */
async function commitStock(
  session: ClientSession | undefined,
  order: OrderDocument,
  actor: StockActor,
  collected: { inputs: ApplyStockMovementInput[]; results: StockMovementResult[] },
  req?: Request,
): Promise<void> {
  for (const line of stockLines(order)) {
    const input = saleMovement(order, line, actor, req);
    // An untracked item has no quantity to move; the ledger service says so, and a sale
    // of one is perfectly ordinary, so it is skipped rather than refused.
    const item = await Item.findOne({ _id: line.subjectId, merchantId: order.merchantId }).session(
      session ?? null,
    );
    if (!item || !item.trackStock) continue;

    collected.inputs.push(input);
    collected.results.push(await applyStockMovementInSession(session, input));
  }

  order.stockCommitted = true;
  order.stockCommittedAt = new Date();
}

/** Puts the sold items back, inside the caller's transaction. */
async function releaseStock(
  session: ClientSession | undefined,
  order: OrderDocument,
  actor: StockActor,
  reason: 'cancelled' | 'returned',
  collected: { inputs: ApplyStockMovementInput[]; results: StockMovementResult[] },
  req?: Request,
): Promise<void> {
  for (const line of stockLines(order)) {
    const item = await Item.findOne({ _id: line.subjectId, merchantId: order.merchantId }).session(
      session ?? null,
    );
    if (!item || !item.trackStock) continue;

    const input = restoreMovement(order, line, actor, reason, req);
    collected.inputs.push(input);
    collected.results.push(await applyStockMovementInSession(session, input));
  }

  order.stockCommitted = false;
  order.stockCommittedAt = null;
}

export async function loadOrder(
  merchantId: Types.ObjectId,
  orderId: string,
  session?: ClientSession,
): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) {
    throw AppError.notFound('That order was not found.');
  }

  const query = Order.findOne({ _id: orderId, merchantId });
  if (session) query.session(session);

  const order = await query;
  if (!order) throw AppError.notFound('That order was not found.');
  return order;
}

/**
 * Creates an order.
 *
 * The order document and the stock it commits are written in one transaction. Splitting
 * them would allow a sale that claims to have happened next to stock that never moved —
 * the discrepancy a merchant cannot diagnose and the ledger cannot explain
 * (PRD section 33).
 */
export async function createOrder(input: {
  merchantId: Types.ObjectId;
  data: OrderInput;
  actor: StockActor;
  req?: Request;
}): Promise<OrderDocument> {
  const { data } = input;

  // An anonymous sale is allowed, so a missing customer is not an error.
  let customerName: string | null = null;
  let customerId: Types.ObjectId | null = null;
  if (data.customerId) {
    const customer = await loadCustomer(input.merchantId, data.customerId);
    if (customer.archived) {
      throw AppError.conflict(
        `${customer.fullName} is archived. Restore them before selling to them.`,
      );
    }
    customerId = customer._id;
    customerName = customer.fullName;
  }

  const lines = await buildLines(input.merchantId, data.lines ?? []);
  const totals = priceOrder(lines, data);

  const status: OrderStatus = data.status ?? 'confirmed';
  if (TERMINAL_ORDER_STATUSES.has(status)) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'status', message: 'An order cannot be created as cancelled or returned.' },
    ]);
  }

  const orderDate = parseDate(data.orderDate, 'orderDate', new Date())!;
  const dueDate = parseDate(data.dueDate, 'dueDate');

  const collected = { inputs: [] as ApplyStockMovementInput[], results: [] as StockMovementResult[] };

  const order = await withTransaction(async (session) => {
    const reference = await nextReference(input.merchantId, 'order', session);

    const [created] = await Order.create(
      [
        {
          merchantId: input.merchantId,
          reference,
          customerId,
          customerName,
          lines,
          subtotalMinor: totals.subtotalMinor,
          discountType: data.discountType ?? 'none',
          discountPercent: data.discountPercent ?? null,
          discountMinor: totals.discountMinor,
          taxPercent: data.taxPercent ?? null,
          taxMinor: totals.taxMinor,
          totalMinor: totals.totalMinor,
          status,
          stockCommitted: false,
          orderDate,
          dueDate,
          notes: data.notes?.trim() || null,
          paidMinor: 0,
          paymentStatus: derivePaymentStatus(totals.totalMinor, 0),
          installments: [],
        },
      ],
      { session, ordered: true },
    );

    const doc = created!;

    // A draft holds nothing; anything else has committed the goods.
    if (holdsStock(doc.status)) {
      await commitStock(session, doc, input.actor, collected, input.req);
      await doc.save({ session });
    }

    if (customerId) await refreshCustomerOutstanding(input.merchantId, customerId, session);
    return doc;
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'order.created',
    targetType: 'order',
    targetId: order._id,
    summary:
      `Created order ${order.reference}` +
      `${order.customerName ? ` for ${order.customerName}` : ' (no customer)'} ` +
      `for ${describeMoneyMinor(order.totalMinor)} (${order.status}).`,
    metadata: {
      lines: order.lines.length,
      status: order.status,
      total: order.totalMinor,
      stockCommitted: order.stockCommitted,
    },
    req: input.req,
  });

  for (const [index, movement] of collected.results.entries()) {
    await auditStockMovement(collected.inputs[index]!, movement);
  }

  return order;
}

/**
 * Moves an order to a new status, applying the stock effect that goes with it.
 *
 * The transition map in `config/orders.ts` decides what is allowed; this function
 * decides what it means for stock. Those are the only two places either question is
 * answered.
 */
export async function transitionOrder(input: {
  merchantId: Types.ObjectId;
  orderId: string;
  to: OrderStatus;
  reason?: string | null;
  actor: StockActor;
  req?: Request;
}): Promise<OrderDocument> {
  const collected = { inputs: [] as ApplyStockMovementInput[], results: [] as StockMovementResult[] };
  let from: OrderStatus = 'draft';

  const order = await withTransaction(async (session) => {
    const doc = await loadOrder(input.merchantId, input.orderId, session);
    from = doc.status;

    if (from === input.to) {
      throw AppError.conflict(`This order is already ${input.to.replace(/_/g, ' ')}.`);
    }
    if (!canTransition(from, input.to)) {
      throw AppError.conflict(
        `An order that is ${from.replace(/_/g, ' ')} cannot become ${input.to.replace(/_/g, ' ')}.`,
        { meta: { from, to: input.to, allowed: ORDER_TRANSITIONS[from] } },
      );
    }

    // Cancelling an order that has been paid would strand the money with nothing to
    // belong to. Refunds are the right instrument and arrive in Phase 5.
    if (input.to === 'cancelled' && doc.paidMinor > 0) {
      throw AppError.conflict(
        `${describeMoneyMinor(doc.paidMinor)} has already been paid against this order, so it cannot be cancelled.`,
        { meta: { paid: doc.paidMinor } },
      );
    }

    const shouldHold = holdsStock(input.to);
    if (shouldHold && !doc.stockCommitted) {
      await commitStock(session, doc, input.actor, collected, input.req);
    } else if (!shouldHold && doc.stockCommitted) {
      await releaseStock(
        session,
        doc,
        input.actor,
        input.to === 'returned' ? 'returned' : 'cancelled',
        collected,
        input.req,
      );
    }

    doc.status = input.to;
    if (input.to === 'completed') doc.completedAt = new Date();
    if (input.to === 'cancelled') {
      doc.cancelledAt = new Date();
      doc.cancelledReason = input.reason?.trim() || null;
    }
    if (input.to === 'returned') {
      doc.returnedAt = new Date();
      doc.returnedReason = input.reason?.trim() || null;
    }

    await doc.save({ session });
    if (doc.customerId) {
      await refreshCustomerOutstanding(input.merchantId, doc.customerId, session);
    }

    return doc;
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: `order.${input.to}`,
    targetType: 'order',
    targetId: order._id,
    summary:
      `Order ${order.reference} moved from ${from.replace(/_/g, ' ')} to ` +
      `${input.to.replace(/_/g, ' ')}${collected.results.length > 0 ? ', and its stock moved with it' : ''}.`,
    changes: [{ field: 'status', from, to: input.to }],
    metadata: { reason: input.reason ?? null, stockMovements: collected.results.length },
    req: input.req,
  });

  for (const [index, movement] of collected.results.entries()) {
    await auditStockMovement(collected.inputs[index]!, movement);
  }

  return order;
}

/**
 * Edits an order that is still a draft.
 *
 * Only a draft may change its lines or totals. Once stock has moved and payments may
 * have landed, the lines are history; "cancel it and write it again" is a path a merchant
 * can understand and verify.
 */
export async function updateOrder(input: {
  merchantId: Types.ObjectId;
  orderId: string;
  data: OrderInput;
  actor: StockActor;
  req?: Request;
}): Promise<OrderDocument> {
  const order = await loadOrder(input.merchantId, input.orderId);
  const { data } = input;

  const changingLines = data.lines !== undefined;
  const changingMoney =
    data.discountType !== undefined ||
    data.discountMinor !== undefined ||
    data.discountPercent !== undefined ||
    data.taxPercent !== undefined;

  if ((changingLines || changingMoney) && !EDITABLE_ORDER_STATUSES.has(order.status)) {
    throw AppError.conflict(
      'Only a draft order can have its lines or totals changed. Cancel it and write a new one.',
      { meta: { status: order.status } },
    );
  }

  if (data.customerId !== undefined) {
    if (data.customerId === null) {
      order.customerId = null;
      order.customerName = null;
    } else {
      const customer = await loadCustomer(input.merchantId, data.customerId);
      order.customerId = customer._id;
      order.customerName = customer.fullName;
    }
  }

  if (changingLines || changingMoney) {
    const lines = changingLines
      ? await buildLines(input.merchantId, data.lines ?? [])
      : order.lines.map((line) => ({ ...line }));

    const totals = priceOrder(lines, {
      discountType: data.discountType ?? order.discountType,
      ...(data.discountMinor !== undefined
        ? { discountMinor: data.discountMinor }
        : order.discountType === 'amount'
          ? { discountMinor: order.discountMinor }
          : {}),
      ...(data.discountPercent !== undefined
        ? { discountPercent: data.discountPercent }
        : order.discountPercent !== null
          ? { discountPercent: order.discountPercent }
          : {}),
      ...(data.taxPercent !== undefined
        ? { taxPercent: data.taxPercent }
        : order.taxPercent !== null
          ? { taxPercent: order.taxPercent }
          : {}),
    });

    order.lines = lines;
    order.subtotalMinor = totals.subtotalMinor;
    order.discountType = data.discountType ?? order.discountType;
    if (data.discountPercent !== undefined) order.discountPercent = data.discountPercent;
    order.discountMinor = totals.discountMinor;
    if (data.taxPercent !== undefined) order.taxPercent = data.taxPercent;
    order.taxMinor = totals.taxMinor;
    order.totalMinor = totals.totalMinor;
    order.paymentStatus = derivePaymentStatus(totals.totalMinor, order.paidMinor);

    // A plan built against the old total no longer adds up, so it is cleared rather than
    // left to disagree with the order.
    if (order.installments.length > 0) order.installments = [];
  }

  if (data.orderDate !== undefined) {
    order.orderDate = parseDate(data.orderDate, 'orderDate', order.orderDate)!;
  }
  if (data.dueDate !== undefined) order.dueDate = parseDate(data.dueDate, 'dueDate');
  if (data.notes !== undefined) order.notes = data.notes?.trim() || null;

  await order.save();
  if (order.customerId) await refreshCustomerOutstanding(input.merchantId, order.customerId);

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'order.updated',
    targetType: 'order',
    targetId: order._id,
    summary: `Updated order ${order.reference}.`,
    metadata: { linesChanged: changingLines, totalsChanged: changingMoney },
    req: input.req,
  });

  return order;
}

/* ------------------------------- installments ------------------------------ */

export interface InstallmentInput {
  amountMinor?: number;
  dueDate?: string;
  notes?: string | null;
}

/**
 * Sets an order's installment plan, replacing any existing one.
 *
 * The plan must add up to the order total exactly: the point of a schedule is that
 * paying all of it settles the order, and a plan short by a rupee leaves a balance nobody
 * can explain.
 */
export async function setInstallmentPlan(input: {
  merchantId: Types.ObjectId;
  orderId: string;
  installments: InstallmentInput[];
  actor: StockActor;
  req?: Request;
}): Promise<OrderDocument> {
  const order = await loadOrder(input.merchantId, input.orderId);

  if (TERMINAL_ORDER_STATUSES.has(order.status)) {
    throw AppError.conflict('This order is closed, so it cannot take an instalment plan.');
  }
  if (input.installments.length === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'installments', message: 'Add at least one instalment.' },
    ]);
  }
  if (input.installments.length > MAX_INSTALLMENTS) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'installments', message: `Use ${MAX_INSTALLMENTS} instalments or fewer.` },
    ]);
  }

  // Replacing a plan that money has already been allocated against would leave the
  // entries pointing at instalments that no longer exist.
  if (order.paidMinor > 0 && order.installments.length > 0) {
    throw AppError.conflict(
      'Payments have already been recorded against this plan, so it cannot be replaced.',
      { meta: { paid: order.paidMinor } },
    );
  }

  const amounts = input.installments.map((entry, index) =>
    requireMoneyMinor(entry.amountMinor, `installments[${index}].amountMinor`),
  );
  for (const [index, amount] of amounts.entries()) {
    if (amount <= 0) {
      throw AppError.validation('Please correct the highlighted fields.', [
        { field: `installments[${index}].amountMinor`, message: 'Enter an amount above zero.' },
      ]);
    }
  }
  assertPlanMatchesTotal(amounts, order.totalMinor);

  const dueDates = input.installments.map(
    (entry, index) => parseDate(entry.dueDate, `installments[${index}].dueDate`)!,
  );
  for (const [index, dueDate] of dueDates.entries()) {
    if (!dueDate) {
      throw AppError.validation('Please correct the highlighted fields.', [
        { field: `installments[${index}].dueDate`, message: 'Enter when this instalment is due.' },
      ]);
    }
    // Out-of-order dates make "next due" meaningless and a plan impossible to read.
    if (index > 0 && dueDate.getTime() < dueDates[index - 1]!.getTime()) {
      throw AppError.validation('Please correct the highlighted fields.', [
        {
          field: `installments[${index}].dueDate`,
          message: 'Each instalment must be due no earlier than the one before it.',
        },
      ]);
    }
  }

  order.installments = input.installments.map((entry, index) => ({
    number: index + 1,
    amountMinor: amounts[index]!,
    dueDate: dueDates[index]!,
    paidMinor: 0,
    status: 'pending' as const,
    notes: entry.notes?.trim() || null,
    reminderSentAt: null,
  }));

  // A plan may be added to an order that has already taken money — a deposit, then terms
  // agreed afterwards. What has been paid is spread across the new plan from the earliest
  // instalment, because the plan is a projection of the payments: leaving it at zero would
  // have the schedule claim the full amount is still owed while the order knows better.
  if (order.paidMinor > 0) allocateToInstallments(order, order.paidMinor);

  // The order's own due date follows the last instalment, so a plan and a due date can
  // never say different things about when the money is expected.
  order.dueDate = dueDates[dueDates.length - 1]!;

  await order.save();
  if (order.customerId) await refreshCustomerOutstanding(input.merchantId, order.customerId);

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'installments.planned',
    targetType: 'order',
    targetId: order._id,
    summary:
      `Set a ${order.installments.length}-instalment plan on order ${order.reference} ` +
      `for ${describeMoneyMinor(order.totalMinor)}.`,
    metadata: { installments: order.installments.length },
    req: input.req,
  });

  return order;
}

/** Builds an evenly split plan, which is what most merchants want. */
export function evenInstallments(
  totalMinor: number,
  count: number,
  firstDueDate: Date,
  everyDays: number,
): InstallmentInput[] {
  const amounts = splitIntoInstallments(totalMinor, count);

  return amounts.map((amountMinor, index) => {
    const dueDate = new Date(firstDueDate.getTime());
    dueDate.setDate(dueDate.getDate() + index * everyDays);
    return { amountMinor, dueDate: dueDate.toISOString() };
  });
}

/**
 * Allocates a payment across the plan, and returns the installment numbers it touched.
 *
 * When the payment names an installment it goes there. Otherwise it fills the earliest
 * unpaid ones in order, which is what a merchant handing over cash means by "put this
 * towards what I owe".
 */
export function allocateToInstallments(
  order: OrderDocument,
  amountMinor: number,
  installmentNumber?: number | null,
): number[] {
  if (order.installments.length === 0) return [];

  const touched: number[] = [];
  let remaining = amountMinor;

  const targets = installmentNumber
    ? order.installments.filter((entry) => entry.number === installmentNumber)
    : order.installments
        .filter((entry) => entry.paidMinor < entry.amountMinor)
        .sort((a, b) => a.number - b.number);

  if (installmentNumber && targets.length === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'installmentNumber', message: 'That instalment is not on this plan.' },
    ]);
  }

  for (const entry of targets) {
    if (remaining <= 0) break;

    const owed = entry.amountMinor - entry.paidMinor;
    if (owed <= 0) continue;

    const applied = Math.min(owed, remaining);
    entry.paidMinor += applied;
    entry.status = entry.paidMinor >= entry.amountMinor ? 'paid' : 'partially_paid';
    remaining -= applied;
    touched.push(entry.number);
  }

  // Anything left over belongs to the order but to no instalment — which happens when a
  // merchant pays more than the named instalment owes. The order's own paid total still
  // accounts for it, so no money is lost; it simply is not attributed to a schedule row.
  return touched;
}

/** The next installment that still owes money, for the "next due" emphasis the PRD asks for. */
export function nextDueInstallment(order: OrderDocument): OrderInstallment | null {
  return (
    order.installments
      .filter((entry) => entry.paidMinor < entry.amountMinor)
      .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime())[0] ?? null
  );
}

/* --------------------------------- activity -------------------------------- */

/**
 * What has happened to one order, newest first.
 *
 * Read from the same audit trail the admin panel reads, scoped by first loading the order
 * as the merchant — the ownership check is the scope, because audit entries are keyed by
 * target rather than by merchant. The `{ targetType, targetId, createdAt }` index serves
 * this directly.
 *
 * The merchant sees who did each thing, which is the point: when support records a payment
 * or moves an order on, it must not look like it happened by itself (PRD section 36).
 */
export async function orderActivity(
  merchantId: Types.ObjectId,
  orderId: string,
  limit = 50,
): Promise<AuditLogDocument[]> {
  const order = await loadOrder(merchantId, orderId);

  return AuditLog.find({ targetType: 'order', targetId: order._id })
    .sort({ createdAt: -1 })
    .limit(limit);
}

/* ---------------------------------- listing --------------------------------- */

export const ORDER_SORT_FIELDS = ['orderDate', 'createdAt', 'totalMinor', 'dueDate'] as const;

export interface OrderFilters {
  search?: string;
  customerId?: string;
  subjectId?: string;
  status?: OrderStatus;
  paymentStatus?: 'unpaid' | 'partially_paid' | 'fully_paid';
  overdue?: boolean;
  /** Only orders that are still open: not cancelled, not returned. */
  open?: boolean;
  from?: Date;
  to?: Date;
}

export function orderQuery(
  merchantId: Types.ObjectId,
  filters: OrderFilters,
  now: Date = new Date(),
): Record<string, unknown> {
  const query: Record<string, unknown> = { merchantId };

  if (filters.status) query.status = filters.status;
  if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
  if (filters.open) query.status = { $nin: ['cancelled', 'returned', 'completed'] };

  if (filters.customerId) {
    if (!Types.ObjectId.isValid(filters.customerId)) {
      throw AppError.notFound('That customer was not found.');
    }
    query.customerId = new Types.ObjectId(filters.customerId);
  }

  if (filters.subjectId) {
    if (!Types.ObjectId.isValid(filters.subjectId)) {
      throw AppError.notFound('That record was not found.');
    }
    query['lines.subjectId'] = new Types.ObjectId(filters.subjectId);
  }

  // Overdue is computed from the clock, so it is a query rather than a stored flag.
  if (filters.overdue) {
    query.status = { $nin: ['cancelled', 'returned'] };
    query.paymentStatus = { $ne: 'fully_paid' };
    query.dueDate = { $ne: null, $lt: now };
  }

  if (filters.from || filters.to) {
    query.orderDate = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [{ reference: pattern }, { customerName: pattern }, { 'lines.name': pattern }];
  }

  return query;
}

export async function listOrders(
  merchantId: Types.ObjectId,
  filters: OrderFilters,
  pagination: { skip: number; limit: number },
  sort: Record<string, 1 | -1>,
): Promise<{ items: OrderDocument[]; total: number }> {
  const query = orderQuery(merchantId, filters);

  const [items, total] = await Promise.all([
    Order.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Order.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Registers orders with the payment engine.
 *
 * Purchases registered the same way in Phase 3; the engine still knows about neither.
 * This is what keeps one engine from becoming two that disagree about what "partially
 * paid" means.
 */
registerPayable<OrderDocument>('order', {
  direction: 'in',

  load: ({ merchantId, payableId, session }) => loadOrder(merchantId, payableId, session),

  snapshot: (doc): PayableSnapshot => ({
    id: doc._id,
    merchantId: doc.merchantId,
    reference: doc.reference,
    label: `order ${doc.reference}`,
    totalMinor: doc.totalMinor,
    paidMinor: doc.paidMinor,
    dueDate: doc.dueDate ?? null,
    cancelled: TERMINAL_ORDER_STATUSES.has(doc.status),
  }),

  applyPayment: (doc, next) => {
    const applied = next.paidMinor - doc.paidMinor;
    doc.paidMinor = next.paidMinor;
    doc.paymentStatus = next.paymentStatus;
    // The plan is a projection of the payments, so it is brought along with them.
    if (doc.installments.length > 0) allocateToInstallments(doc, applied, next.installmentNumber);
  },

  save: (doc, session) => doc.save({ session }).then(() => undefined),

  // An order payment changes what the customer owes, and several screens show that
  // figure, so it is brought back in step inside the same transaction.
  afterPayment: (doc, session) =>
    doc.customerId
      ? refreshCustomerOutstanding(doc.merchantId, doc.customerId, session)
      : Promise.resolve(),
});

export type { ItemDocument };
