import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { PaymentMethod } from '../../config/commerce';
import type { OrderStatus } from '../../config/orders';
import { ORDER_TRANSITIONS } from '../../config/orders';
import { AppError } from '../../utils/AppError';
import { parsePagination, parseSort } from '../../utils/pagination';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import type { AuthenticatedAdmin } from '../../types/express';
import type { StockActor } from '../catalog/stockService';
import { annotatePayment, recordPayment } from '../payments/paymentEngine';
import { presentOrder } from '../orders/orderPresenters';
import {
  setInstallmentPlan,
  transitionOrder,
  type InstallmentInput,
} from '../orders/orderService';
import { presentPaymentEntry } from '../relationships/relationshipPresenters';
import { loadMerchantNames } from './adminCatalogService';
import {
  ADMIN_ORDER_SORT_FIELDS,
  adminListInstallments,
  adminListOrders,
  adminLoadOrder,
  adminOrderSummary,
  adminReceivables,
  type AdminOrderFilters,
} from './adminOrderService';
import { adminListPayments, adminLoadPayment } from './adminRelationshipService';

/**
 * Admin endpoints for orders, payments, instalments and receivables.
 *
 * Reads come from `adminOrderService`, which spans merchants. Writes go through the
 * merchant-side services with `actorType: 'admin'`, so the lifecycle rules, the stock
 * effects and the payment engine are the same ones the app uses — and the merchant can
 * see in their own audit trail that support made the change (PRD section 36).
 */

function adminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

function adminActor(req: Request): StockActor {
  const admin = adminContext(req);
  return { type: 'admin', id: admin.objectId, label: admin.name };
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

export async function getAdminOrders(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_ORDER_SORT_FIELDS, { orderDate: -1 });

  const filters: AdminOrderFilters = {
    merchantId: optionalString(req.query.merchantId),
    search: optionalString(req.query.search),
    customerId: optionalString(req.query.customerId),
    status: optionalString(req.query.status) as OrderStatus | undefined,
    paymentStatus: optionalString(req.query.paymentStatus),
    overdue: optionalBoolean(req.query.overdue),
    open: optionalBoolean(req.query.open),
    from: optionalDate(req.query.from),
    to: optionalDate(req.query.to),
  };

  const { items, total } = await adminListOrders(filters, pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((order) => order.merchantId));
  const now = new Date();

  sendList(
    res,
    items.map((order) => ({
      ...presentOrder(order, now),
      merchantId: String(order.merchantId),
      merchantName: merchantNames.get(String(order.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminOrderById(req: Request, res: Response): Promise<void> {
  const order = await adminLoadOrder(req.params.id!);
  const merchantNames = await loadMerchantNames([order.merchantId]);

  const { items } = await adminListPayments(
    { payableType: 'order', payableId: String(order._id) },
    { page: 1, limit: 100, skip: 0 },
    { paidAt: -1 },
  );

  sendData(res, {
    order: {
      ...presentOrder(order),
      merchantId: String(order.merchantId),
      merchantName: merchantNames.get(String(order.merchantId)) ?? null,
    },
    payments: items.map(presentPaymentEntry),
    allowedTransitions: ORDER_TRANSITIONS[order.status],
  });
}

export async function postAdminOrderStatus(req: Request, res: Response): Promise<void> {
  const order = await adminLoadOrder(req.params.id!);
  const body = req.body as Record<string, unknown>;
  const to = body.status as OrderStatus;

  // Cancelling has its own permission, so it has its own endpoint rather than a gate that
  // depends on the request body: a permission check that reads the body is a check that
  // can be forgotten on the next endpoint.
  if (to === 'cancelled') {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'status', message: 'Use the cancel endpoint to cancel an order.' },
    ]);
  }

  const updated = await transitionOrder({
    merchantId: order.merchantId,
    orderId: String(order._id),
    to,
    reason: optionalString(body.reason) ?? null,
    actor: adminActor(req),
    req,
  });

  sendData(res, {
    order: presentOrder(updated),
    allowedTransitions: ORDER_TRANSITIONS[updated.status],
  });
}

export async function postAdminOrderCancel(req: Request, res: Response): Promise<void> {
  const order = await adminLoadOrder(req.params.id!);
  const updated = await transitionOrder({
    merchantId: order.merchantId,
    orderId: String(order._id),
    to: 'cancelled',
    reason: optionalString((req.body as Record<string, unknown>).reason) ?? null,
    actor: adminActor(req),
    req,
  });

  sendData(res, { order: presentOrder(updated) });
}

export async function postAdminOrderPayment(req: Request, res: Response): Promise<void> {
  const order = await adminLoadOrder(req.params.id!);
  const body = req.body as Record<string, unknown>;

  const result = await recordPayment({
    merchantId: order.merchantId,
    payableType: 'order',
    payableId: String(order._id),
    amountMinor: Number(body.amountMinor),
    method: body.method as PaymentMethod,
    reference: optionalString(body.reference) ?? null,
    paidAt: optionalDate(body.paidAt) ?? null,
    notes: optionalString(body.notes) ?? null,
    installmentNumber: body.installmentNumber === undefined ? null : Number(body.installmentNumber),
    actor: adminActor(req),
    req,
  });

  const updated = await adminLoadOrder(String(order._id));
  sendData(res, { payment: presentPaymentEntry(result.entry), order: presentOrder(updated) }, 201);
}

/**
 * Corrects a payment entry's description, as support.
 *
 * The same engine call the merchant uses, so the same field is immutable for both: an
 * administrator cannot change an amount either, and the audit entry names them.
 */
export async function patchAdminPayment(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, unknown>;

  // Found without a merchant scope, then annotated with its own merchant's id: support
  // works from a payment id, and the entry carries the merchant it belongs to.
  const existing = await adminLoadPayment(req.params.id!);

  const entry = await annotatePayment({
    merchantId: existing.merchantId,
    paymentId: String(existing._id),
    ...('reference' in body ? { reference: optionalString(body.reference) ?? null } : {}),
    ...('notes' in body ? { notes: optionalString(body.notes) ?? null } : {}),
    ...(optionalDate(body.paidAt) ? { paidAt: optionalDate(body.paidAt)! } : {}),
    actor: adminActor(req),
    req,
  });

  sendData(res, { payment: presentPaymentEntry(entry) });
}

/* ------------------------------- installments ------------------------------ */

export async function putAdminInstallmentPlan(req: Request, res: Response): Promise<void> {
  const order = await adminLoadOrder(req.params.id!);
  const body = req.body as { installments: InstallmentInput[] };

  const updated = await setInstallmentPlan({
    merchantId: order.merchantId,
    orderId: String(order._id),
    installments: body.installments,
    actor: adminActor(req),
    req,
  });

  sendData(res, { order: presentOrder(updated) });
}

export async function getAdminInstallments(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);

  const { items, total } = await adminListInstallments(
    {
      merchantId: optionalString(req.query.merchantId),
      overdueOnly: optionalBoolean(req.query.overdue) ?? false,
      ...(req.query.withinDays ? { withinDays: Number(req.query.withinDays) } : {}),
    },
    pagination,
  );

  const merchantNames = await loadMerchantNames(
    items.map((row) => new Types.ObjectId(row.merchantId)),
  );

  sendList(
    res,
    items.map((row) => ({
      ...row,
      merchantName: merchantNames.get(row.merchantId) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

/* ------------------------------- receivables ------------------------------- */

export async function getAdminReceivables(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);

  const { items, total } = await adminReceivables(
    {
      merchantId: optionalString(req.query.merchantId),
      overdueOnly: optionalBoolean(req.query.overdue) ?? false,
    },
    pagination,
  );

  const merchantNames = await loadMerchantNames(
    items.map((row) => new Types.ObjectId(row.merchantId)),
  );

  sendList(
    res,
    items.map((row) => ({
      ...row,
      merchantName: merchantNames.get(row.merchantId) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminOrderSummary(req: Request, res: Response): Promise<void> {
  sendData(res, { summary: await adminOrderSummary(req.params.merchantId!) });
}
