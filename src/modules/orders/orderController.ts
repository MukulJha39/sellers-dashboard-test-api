import type { Request, Response } from 'express';
import type { PaymentMethod } from '../../config/commerce';
import type { OrderStatus } from '../../config/orders';
import { ORDER_TRANSITIONS } from '../../config/orders';
import { AppError } from '../../utils/AppError';
import { parsePagination, parseSort } from '../../utils/pagination';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import type { AuthenticatedMerchant } from '../../types/express';
import type { StockActor } from '../catalog/stockService';
import { listPayments, recordPayment } from '../payments/paymentEngine';
import { presentPaymentEntry } from '../relationships/relationshipPresenters';
import {
  dashboardSummary,
  receivablesByCustomer,
  upcomingInstallments,
} from './dashboardService';
import { presentOrder, presentOrderActivity } from './orderPresenters';
import {
  createOrder,
  evenInstallments,
  listOrders,
  loadOrder,
  orderActivity,
  ORDER_SORT_FIELDS,
  setInstallmentPlan,
  transitionOrder,
  updateOrder,
  type InstallmentInput,
  type OrderFilters,
  type OrderInput,
} from './orderService';

function merchantContext(req: Request): AuthenticatedMerchant {
  if (!req.merchant) throw AppError.unauthenticated('Sign in to continue.');
  return req.merchant;
}

function merchantActor(req: Request): StockActor {
  const merchant = merchantContext(req);
  return {
    type: 'merchant',
    id: merchant.objectId,
    label: `${merchant.firstName} ${merchant.lastName}`.trim(),
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function optionalDate(value: unknown): Date | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/* ---------------------------------- orders --------------------------------- */

export async function getOrders(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, ORDER_SORT_FIELDS, { orderDate: -1 });

  const filters: OrderFilters = {
    search: optionalString(req.query.search),
    customerId: optionalString(req.query.customerId),
    subjectId: optionalString(req.query.subjectId),
    status: optionalString(req.query.status) as OrderStatus | undefined,
    paymentStatus: optionalString(req.query.paymentStatus) as OrderFilters['paymentStatus'],
    overdue: optionalBoolean(req.query.overdue),
    open: optionalBoolean(req.query.open),
    from: optionalDate(req.query.from),
    to: optionalDate(req.query.to),
  };

  const { items, total } = await listOrders(merchant.objectId, filters, pagination, sort);
  const now = new Date();

  sendList(
    res,
    items.map((order) => presentOrder(order, now)),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getOrderById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const order = await loadOrder(merchant.objectId, req.params.id!);

  // The payments come with the order: a merchant opening one wants the timeline, and a
  // second round trip for three rows is not worth it.
  const { items } = await listPayments(
    merchant.objectId,
    { payableType: 'order', payableId: String(order._id) },
    { skip: 0, limit: 100 },
  );

  sendData(res, {
    order: presentOrder(order),
    payments: items.map(presentPaymentEntry),
    /** What this order may become next, so a client need not reimplement the map. */
    allowedTransitions: ORDER_TRANSITIONS[order.status],
  });
}

export async function postOrder(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const order = await createOrder({
    merchantId: merchant.objectId,
    data: req.body as OrderInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { order: presentOrder(order) }, 201);
}

export async function patchOrder(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const order = await updateOrder({
    merchantId: merchant.objectId,
    orderId: req.params.id!,
    data: req.body as OrderInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { order: presentOrder(order) });
}

export async function postOrderStatus(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as Record<string, unknown>;

  const order = await transitionOrder({
    merchantId: merchant.objectId,
    orderId: req.params.id!,
    to: body.status as OrderStatus,
    reason: optionalString(body.reason) ?? null,
    actor: merchantActor(req),
    req,
  });

  sendData(res, {
    order: presentOrder(order),
    allowedTransitions: ORDER_TRANSITIONS[order.status],
  });
}

export async function getOrderActivity(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 100);

  const entries = await orderActivity(merchant.objectId, req.params.id!, limit);
  sendData(res, { activity: entries.map(presentOrderActivity) });
}

/* --------------------------------- payments -------------------------------- */

export async function postOrderPayment(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as Record<string, unknown>;

  const result = await recordPayment({
    merchantId: merchant.objectId,
    payableType: 'order',
    payableId: req.params.id!,
    amountMinor: Number(body.amountMinor),
    method: body.method as PaymentMethod,
    reference: optionalString(body.reference) ?? null,
    paidAt: optionalDate(body.paidAt) ?? null,
    notes: optionalString(body.notes) ?? null,
    installmentNumber: body.installmentNumber === undefined ? null : Number(body.installmentNumber),
    actor: merchantActor(req),
    req,
  });

  // The order comes back with the entry so the caller need not refetch to show the new
  // outstanding amount and the updated plan.
  const order = await loadOrder(merchant.objectId, req.params.id!);
  sendData(res, { payment: presentPaymentEntry(result.entry), order: presentOrder(order) }, 201);
}

/* ------------------------------- installments ------------------------------ */

export async function putInstallmentPlan(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as { installments: InstallmentInput[] };

  const order = await setInstallmentPlan({
    merchantId: merchant.objectId,
    orderId: req.params.id!,
    installments: body.installments,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { order: presentOrder(order) });
}

/** Builds an evenly split plan, which is what most merchants want. */
export async function postEvenInstallmentPlan(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as Record<string, unknown>;

  const order = await loadOrder(merchant.objectId, req.params.id!);
  const firstDueDate = optionalDate(body.firstDueDate);
  if (!firstDueDate) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'firstDueDate', message: 'Enter when the first instalment is due.' },
    ]);
  }

  const planned = await setInstallmentPlan({
    merchantId: merchant.objectId,
    orderId: req.params.id!,
    installments: evenInstallments(
      order.totalMinor,
      Number(body.count),
      firstDueDate,
      body.everyDays === undefined ? 30 : Number(body.everyDays),
    ),
    actor: merchantActor(req),
    req,
  });

  sendData(res, { order: presentOrder(planned) });
}

/* --------------------------- receivables & dashboard ------------------------ */

export async function getReceivables(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);

  const { items, total } = await receivablesByCustomer(merchant.objectId, {
    overdueOnly: optionalBoolean(req.query.overdue) ?? false,
    skip: pagination.skip,
    limit: pagination.limit,
  });

  sendList(res, items, buildPageMeta(pagination.page, pagination.limit, total));
}

export async function getUpcomingInstallments(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);

  const items = await upcomingInstallments(merchant.objectId, {
    overdueOnly: optionalBoolean(req.query.overdue) ?? false,
    ...(req.query.withinDays ? { withinDays: Number(req.query.withinDays) } : {}),
    limit,
  });

  sendData(res, { installments: items });
}

export async function getDashboard(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  sendData(res, { summary: await dashboardSummary(merchant.objectId) });
}
