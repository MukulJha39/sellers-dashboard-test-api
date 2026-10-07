import { Types, type PipelineStage } from 'mongoose';
import { DUE_SOON_DAYS } from '../../config/commerce';
import type { OrderStatus } from '../../config/orders';
import { UNPAID_INSTALLMENT_STATUSES } from '../../config/orders';
import { Order, type OrderDocument } from '../../models/Order';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';

/**
 * Admin-side reads for orders, instalments and receivables.
 *
 * These span every merchant, with an optional `merchantId` to drill into one, which is
 * what support and finance actually ask: "show me every overdue order" and "show me this
 * merchant's receivables" are both real questions.
 *
 * Writes are not duplicated here. An administrator transitioning an order or recording a
 * payment goes through the merchant-side service with `actorType: 'admin'`, so there is
 * one lifecycle and one payment engine rather than two that can drift apart.
 */

const CLOSED_STATUSES = ['cancelled', 'returned'] as const;

function requireMerchantId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw AppError.notFound('That merchant was not found.');
  return new Types.ObjectId(value);
}

export const ADMIN_ORDER_SORT_FIELDS = ['orderDate', 'createdAt', 'totalMinor', 'dueDate'] as const;

export interface AdminOrderFilters {
  merchantId?: string;
  search?: string;
  customerId?: string;
  status?: OrderStatus;
  paymentStatus?: string;
  overdue?: boolean;
  open?: boolean;
  from?: Date;
  to?: Date;
}

export function adminOrderQuery(
  filters: AdminOrderFilters,
  now: Date = new Date(),
): Record<string, unknown> {
  const query: Record<string, unknown> = {};

  if (filters.merchantId) query.merchantId = requireMerchantId(filters.merchantId);
  if (filters.customerId) {
    if (!Types.ObjectId.isValid(filters.customerId)) {
      throw AppError.notFound('That customer was not found.');
    }
    query.customerId = new Types.ObjectId(filters.customerId);
  }

  if (filters.status) query.status = filters.status;
  if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
  if (filters.open) query.status = { $nin: [...CLOSED_STATUSES, 'completed'] };

  // Derived from the clock rather than stored, so it is expressed as a query the index can
  // serve — the same shape the merchant-side listing uses.
  if (filters.overdue) {
    query.status = { $nin: CLOSED_STATUSES };
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

export async function adminListOrders(
  filters: AdminOrderFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: OrderDocument[]; total: number }> {
  const query = adminOrderQuery(filters);

  const [items, total] = await Promise.all([
    Order.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Order.countDocuments(query),
  ]);

  return { items, total };
}

/** One order, found without a merchant scope: support works from an id. */
export async function adminLoadOrder(orderId: string): Promise<OrderDocument> {
  if (!Types.ObjectId.isValid(orderId)) throw AppError.notFound('That order was not found.');

  const order = await Order.findById(orderId);
  if (!order) throw AppError.notFound('That order was not found.');
  return order;
}

export interface AdminReceivableRow {
  merchantId: string;
  orderCount: number;
  outstandingMinor: number;
  overdueMinor: number;
  overdueOrders: number;
  dueSoonMinor: number;
  nextDueDate: string | null;
}

/**
 * What is owed, rolled up per merchant and worst first.
 *
 * Grouped by merchant rather than by customer, because that is the unit an administrator
 * acts on: a merchant whose receivables are slipping is the one support calls. Drilling
 * into one merchant's own customers is the merchant-side `receivablesByCustomer`.
 */
export async function adminReceivables(
  filters: { merchantId?: string; overdueOnly?: boolean },
  pagination: Pagination,
  now: Date = new Date(),
): Promise<{ items: AdminReceivableRow[]; total: number }> {
  const dueSoonEnd = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);

  const match: Record<string, unknown> = {
    status: { $nin: CLOSED_STATUSES },
    paymentStatus: { $ne: 'fully_paid' },
  };
  if (filters.merchantId) match.merchantId = requireMerchantId(filters.merchantId);
  if (filters.overdueOnly) match.dueDate = { $ne: null, $lt: now };

  const outstanding = { $subtract: ['$totalMinor', '$paidMinor'] };
  const overdue = { $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] };
  const dueSoon = {
    $and: [
      { $ne: ['$dueDate', null] },
      { $gte: ['$dueDate', now] },
      { $lte: ['$dueDate', dueSoonEnd] },
    ],
  };

  // Typed as a pipeline so the sort direction literals survive inference: a bare array
  // widens them to `number`, which Mongoose's Sort type will not accept.
  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: '$merchantId',
        orderCount: { $sum: 1 },
        outstandingMinor: { $sum: outstanding },
        overdueMinor: { $sum: { $cond: [overdue, outstanding, 0] } },
        overdueOrders: { $sum: { $cond: [overdue, 1, 0] } },
        dueSoonMinor: { $sum: { $cond: [dueSoon, outstanding, 0] } },
        nextDueDate: { $min: '$dueDate' },
      },
    },
    // Whoever is furthest behind comes first: that is who support calls today.
    { $sort: { overdueMinor: -1, outstandingMinor: -1 } },
  ];

  const [rows, counted] = await Promise.all([
    Order.aggregate<{
      _id: Types.ObjectId;
      orderCount: number;
      outstandingMinor: number;
      overdueMinor: number;
      overdueOrders: number;
      dueSoonMinor: number;
      nextDueDate: Date | null;
    }>([...pipeline, { $skip: pagination.skip }, { $limit: pagination.limit }]),
    Order.aggregate<{ count: number }>([...pipeline, { $count: 'count' }]),
  ]);

  return {
    items: rows.map((row) => ({
      merchantId: String(row._id),
      orderCount: row.orderCount,
      outstandingMinor: Math.max(0, row.outstandingMinor),
      overdueMinor: Math.max(0, row.overdueMinor),
      overdueOrders: row.overdueOrders,
      dueSoonMinor: Math.max(0, row.dueSoonMinor),
      nextDueDate: row.nextDueDate ? row.nextDueDate.toISOString() : null,
    })),
    total: counted[0]?.count ?? 0,
  };
}

export interface AdminInstallmentRow {
  orderId: string;
  merchantId: string;
  reference: string;
  customerName: string | null;
  number: number;
  amountMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  dueDate: string;
  status: string;
  isOverdue: boolean;
}

/**
 * Unpaid instalments across every merchant, soonest first.
 *
 * This is what finance works from, and what Phase 5's reminders will be checked against.
 * Overdue is derived from the date here too, for the same reason it is everywhere else: a
 * stored flag needs a job to maintain, and a row the job has not reached is wrong.
 */
export async function adminListInstallments(
  filters: { merchantId?: string; overdueOnly?: boolean; withinDays?: number },
  pagination: Pagination,
  now: Date = new Date(),
): Promise<{ items: AdminInstallmentRow[]; total: number }> {
  const horizon = filters.withinDays
    ? new Date(now.getTime() + filters.withinDays * 24 * 60 * 60 * 1000)
    : null;

  const match: Record<string, unknown> = {
    status: { $nin: CLOSED_STATUSES },
    // `$in` rather than `$ne: 'paid'`: against an array, `$ne` matches only documents where
    // no element equals the value, which would drop every plan that has had one instalment
    // settled. After the `$unwind` below the field is a scalar, so `$ne` is safe there.
    'installments.status': { $in: UNPAID_INSTALLMENT_STATUSES },
  };
  if (filters.merchantId) match.merchantId = requireMerchantId(filters.merchantId);

  const dueDateFilter: Record<string, unknown> = {};
  if (filters.overdueOnly) dueDateFilter.$lt = now;
  if (horizon) dueDateFilter.$lte = horizon;

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $unwind: '$installments' },
    {
      $match: {
        'installments.status': { $ne: 'paid' },
        ...(Object.keys(dueDateFilter).length > 0
          ? { 'installments.dueDate': dueDateFilter }
          : {}),
      },
    },
    { $sort: { 'installments.dueDate': 1 } },
  ];

  const [rows, counted] = await Promise.all([
    Order.aggregate<{
      _id: Types.ObjectId;
      merchantId: Types.ObjectId;
      reference: string;
      customerName: string | null;
      installments: {
        number: number;
        amountMinor: number;
        paidMinor: number;
        dueDate: Date;
        status: string;
      };
    }>([...pipeline, { $skip: pagination.skip }, { $limit: pagination.limit }]),
    Order.aggregate<{ count: number }>([...pipeline, { $count: 'count' }]),
  ]);

  return {
    items: rows.map((row) => ({
      orderId: String(row._id),
      merchantId: String(row.merchantId),
      reference: row.reference,
      customerName: row.customerName ?? null,
      number: row.installments.number,
      amountMinor: row.installments.amountMinor,
      paidMinor: row.installments.paidMinor,
      outstandingMinor: Math.max(0, row.installments.amountMinor - row.installments.paidMinor),
      dueDate: row.installments.dueDate.toISOString(),
      status: row.installments.status,
      isOverdue: row.installments.dueDate.getTime() < now.getTime(),
    })),
    total: counted[0]?.count ?? 0,
  };
}

export interface AdminOrderSummary {
  orders: Record<OrderStatus | 'total', number>;
  salesMinor: number;
  outstandingMinor: number;
  overdueMinor: number;
  overdueOrders: number;
  installments: { pending: number; overdue: number };
}

/**
 * Counts for one merchant's order drill-down.
 *
 * Counted from the merchant's own records by indexed aggregations, never estimated: a
 * support screen that invents a number is worse than one that shows none.
 */
export async function adminOrderSummary(merchantIdValue: string): Promise<AdminOrderSummary> {
  const merchantId = requireMerchantId(merchantIdValue);
  const now = new Date();

  // One `$cond` shared by both overdue figures, so the money and the count can never be
  // counted against different definitions of late.
  const isOverdue = {
    $and: [
      { $ne: ['$paymentStatus', 'fully_paid'] },
      { $ne: ['$dueDate', null] },
      { $lt: ['$dueDate', now] },
    ],
  };
  const outstanding = { $subtract: ['$totalMinor', '$paidMinor'] };

  const [byStatus, money, installments] = await Promise.all([
    Order.aggregate<{ _id: OrderStatus; count: number }>([
      { $match: { merchantId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.aggregate<{
      salesMinor: number;
      outstandingMinor: number;
      overdueMinor: number;
      overdueOrders: number;
    }>([
      { $match: { merchantId, status: { $nin: CLOSED_STATUSES } } },
      {
        $group: {
          _id: null,
          salesMinor: { $sum: '$totalMinor' },
          outstandingMinor: { $sum: outstanding },
          overdueMinor: { $sum: { $cond: [isOverdue, outstanding, 0] } },
          overdueOrders: { $sum: { $cond: [isOverdue, 1, 0] } },
        },
      },
    ]),
    Order.aggregate<{ pending: number; overdue: number }>([
      { $match: { merchantId, status: { $nin: CLOSED_STATUSES } } },
      { $unwind: '$installments' },
      { $match: { 'installments.status': { $ne: 'paid' } } },
      {
        $group: {
          _id: null,
          pending: { $sum: 1 },
          overdue: { $sum: { $cond: [{ $lt: ['$installments.dueDate', now] }, 1, 0] } },
        },
      },
    ]),
  ]);

  // Every status is present with a zero rather than absent, so a client can render the
  // whole lifecycle without having to know which keys might be missing.
  const orders: Record<OrderStatus | 'total', number> = {
    total: 0,
    draft: 0,
    confirmed: 0,
    in_progress: 0,
    ready: 0,
    completed: 0,
    cancelled: 0,
    returned: 0,
  };

  for (const row of byStatus) {
    orders[row._id] = row.count;
    orders.total += row.count;
  }

  return {
    orders,
    salesMinor: money[0]?.salesMinor ?? 0,
    outstandingMinor: Math.max(0, money[0]?.outstandingMinor ?? 0),
    overdueMinor: Math.max(0, money[0]?.overdueMinor ?? 0),
    overdueOrders: money[0]?.overdueOrders ?? 0,
    installments: {
      pending: installments[0]?.pending ?? 0,
      overdue: installments[0]?.overdue ?? 0,
    },
  };
}
