import { Types, type PipelineStage } from 'mongoose';
import { DUE_SOON_DAYS } from '../../config/commerce';
import { UNPAID_INSTALLMENT_STATUSES } from '../../config/orders';
import { Order } from '../../models/Order';
import { PaymentEntry } from '../../models/PaymentEntry';
import { Purchase } from '../../models/Purchase';
import { AppError } from '../../utils/AppError';

/**
 * The aggregations behind the receivables screen and the dashboard.
 *
 * Every figure here is counted from the merchant's own records by an indexed aggregation,
 * never estimated and never computed by scanning in application code. A dashboard that
 * invents a number is worse than one that shows none (PRD section 6.1).
 */

const CLOSED_STATUSES = ['cancelled', 'returned'] as const;

function startOfDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export interface SalesSummary {
  todayMinor: number;
  todayOrders: number;
  thisMonthMinor: number;
  thisMonthOrders: number;
  openOrders: number;
  draftOrders: number;
}

export interface ReceivablesSummary {
  outstandingMinor: number;
  overdueMinor: number;
  overdueOrders: number;
  dueSoonMinor: number;
  dueSoonOrders: number;
  customersOwing: number;
}

export interface DashboardSummary {
  sales: SalesSummary;
  receivables: ReceivablesSummary;
  /** Money that came in today, which is not the same as what was sold today. */
  collectedTodayMinor: number;
  payablesMinor: number;
}

/**
 * Sales and receivables in one pass each.
 *
 * `$facet` keeps this to two round trips rather than eight: the dashboard is the first
 * screen a merchant sees every morning, and its latency is the product's first
 * impression (PRD section 30).
 */
export async function dashboardSummary(
  merchantId: Types.ObjectId,
  now: Date = new Date(),
): Promise<DashboardSummary> {
  const dayStart = startOfDay(now);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const dueSoonEnd = new Date(now.getTime() + DUE_SOON_DAYS * 24 * 60 * 60 * 1000);

  const liveOrders = { merchantId, status: { $nin: CLOSED_STATUSES } };

  const [orderFacets] = await Order.aggregate<{
    today: Array<{ total: number; count: number }>;
    month: Array<{ total: number; count: number }>;
    open: Array<{ count: number }>;
    drafts: Array<{ count: number }>;
    outstanding: Array<{ total: number }>;
    overdue: Array<{ total: number; count: number }>;
    dueSoon: Array<{ total: number; count: number }>;
    customersOwing: Array<{ count: number }>;
  }>([
    { $match: liveOrders },
    {
      $facet: {
        today: [
          { $match: { orderDate: { $gte: dayStart } } },
          { $group: { _id: null, total: { $sum: '$totalMinor' }, count: { $sum: 1 } } },
        ],
        month: [
          { $match: { orderDate: { $gte: monthStart } } },
          { $group: { _id: null, total: { $sum: '$totalMinor' }, count: { $sum: 1 } } },
        ],
        // Open means still to be worked on: not completed, not closed.
        open: [
          { $match: { status: { $nin: [...CLOSED_STATUSES, 'completed'] } } },
          { $group: { _id: null, count: { $sum: 1 } } },
        ],
        drafts: [{ $match: { status: 'draft' } }, { $group: { _id: null, count: { $sum: 1 } } }],
        outstanding: [
          { $match: { paymentStatus: { $ne: 'fully_paid' } } },
          { $group: { _id: null, total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } } } },
        ],
        overdue: [
          {
            $match: {
              paymentStatus: { $ne: 'fully_paid' },
              dueDate: { $ne: null, $lt: now },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } },
              count: { $sum: 1 },
            },
          },
        ],
        dueSoon: [
          {
            $match: {
              paymentStatus: { $ne: 'fully_paid' },
              dueDate: { $ne: null, $gte: now, $lte: dueSoonEnd },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } },
              count: { $sum: 1 },
            },
          },
        ],
        customersOwing: [
          { $match: { paymentStatus: { $ne: 'fully_paid' }, customerId: { $ne: null } } },
          { $group: { _id: '$customerId' } },
          { $count: 'count' },
        ],
      },
    },
  ]);

  const [collected] = await PaymentEntry.aggregate<{ total: number }>([
    { $match: { merchantId, direction: 'in', paidAt: { $gte: dayStart } } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]);

  const [payables] = await Purchase.aggregate<{ total: number }>([
    { $match: { merchantId, status: 'recorded', paymentStatus: { $ne: 'fully_paid' } } },
    { $group: { _id: null, total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } } } },
  ]);

  const first = <T>(rows: T[] | undefined): T | undefined => rows?.[0];

  return {
    sales: {
      todayMinor: first(orderFacets?.today)?.total ?? 0,
      todayOrders: first(orderFacets?.today)?.count ?? 0,
      thisMonthMinor: first(orderFacets?.month)?.total ?? 0,
      thisMonthOrders: first(orderFacets?.month)?.count ?? 0,
      openOrders: first(orderFacets?.open)?.count ?? 0,
      draftOrders: first(orderFacets?.drafts)?.count ?? 0,
    },
    receivables: {
      outstandingMinor: Math.max(0, first(orderFacets?.outstanding)?.total ?? 0),
      overdueMinor: Math.max(0, first(orderFacets?.overdue)?.total ?? 0),
      overdueOrders: first(orderFacets?.overdue)?.count ?? 0,
      dueSoonMinor: Math.max(0, first(orderFacets?.dueSoon)?.total ?? 0),
      dueSoonOrders: first(orderFacets?.dueSoon)?.count ?? 0,
      customersOwing: first(orderFacets?.customersOwing)?.count ?? 0,
    },
    collectedTodayMinor: collected?.total ?? 0,
    payablesMinor: Math.max(0, payables?.total ?? 0),
  };
}

export interface ReceivableRow {
  customerId: string | null;
  customerName: string;
  orderCount: number;
  outstandingMinor: number;
  overdueMinor: number;
  /** The soonest unpaid due date across this customer's orders. */
  nextDueDate: string | null;
  isOverdue: boolean;
}

/**
 * What is owed, grouped by customer and due-soonest first.
 *
 * Grouped rather than listed order by order, because a merchant chasing money thinks in
 * people: "who owes me, and who is late" (PRD section 9). Anonymous sales are grouped
 * together under a null customer, since there is nobody to chase.
 */
export async function receivablesByCustomer(
  merchantId: Types.ObjectId,
  options: { overdueOnly?: boolean; skip: number; limit: number },
  now: Date = new Date(),
): Promise<{ items: ReceivableRow[]; total: number }> {
  const match: Record<string, unknown> = {
    merchantId,
    status: { $nin: CLOSED_STATUSES },
    paymentStatus: { $ne: 'fully_paid' },
  };
  if (options.overdueOnly) match.dueDate = { $ne: null, $lt: now };

  // Typed as a pipeline so the sort direction literals survive inference: a bare array
  // widens them to `number`, which Mongoose's Sort type will not accept.
  const pipeline: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: '$customerId',
        customerName: { $first: '$customerName' },
        orderCount: { $sum: 1 },
        outstandingMinor: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } },
        overdueMinor: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] },
              { $subtract: ['$totalMinor', '$paidMinor'] },
              0,
            ],
          },
        },
        nextDueDate: { $min: '$dueDate' },
      },
    },
    // Whoever is late comes first, then whoever is due soonest. A null due date sorts
    // last, because nothing has been promised about it.
    { $sort: { overdueMinor: -1, nextDueDate: 1, outstandingMinor: -1 } },
  ];

  const [rows, counted] = await Promise.all([
    Order.aggregate<{
      _id: Types.ObjectId | null;
      customerName: string | null;
      orderCount: number;
      outstandingMinor: number;
      overdueMinor: number;
      nextDueDate: Date | null;
    }>([...pipeline, { $skip: options.skip }, { $limit: options.limit }]),
    Order.aggregate<{ count: number }>([...pipeline, { $count: 'count' }]),
  ]);

  return {
    items: rows.map((row) => ({
      customerId: row._id ? String(row._id) : null,
      // An anonymous sale has nobody to name, and saying so is better than an empty cell.
      customerName: row.customerName ?? 'Walk-in sale',
      orderCount: row.orderCount,
      outstandingMinor: Math.max(0, row.outstandingMinor),
      overdueMinor: Math.max(0, row.overdueMinor),
      nextDueDate: row.nextDueDate ? row.nextDueDate.toISOString() : null,
      isOverdue: row.overdueMinor > 0,
    })),
    total: counted[0]?.count ?? 0,
  };
}

export interface UpcomingInstallment {
  orderId: string;
  reference: string;
  customerName: string | null;
  number: number;
  amountMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  dueDate: string;
  isOverdue: boolean;
}

/**
 * The installments still owed, soonest first.
 *
 * Feeds the receivables screen's schedule and the reminders Phase 5 sends. Overdue is
 * derived here from the date rather than read from a stored flag, for the same reason it
 * is everywhere else: a flag needs a job to maintain, and a row the job has not reached
 * is wrong.
 */
export async function upcomingInstallments(
  merchantId: Types.ObjectId,
  options: { overdueOnly?: boolean; withinDays?: number; limit: number },
  now: Date = new Date(),
): Promise<UpcomingInstallment[]> {
  const horizon = options.withinDays
    ? new Date(now.getTime() + options.withinDays * 24 * 60 * 60 * 1000)
    : null;

  const rows = await Order.aggregate<{
    _id: Types.ObjectId;
    reference: string;
    customerName: string | null;
    installment: {
      number: number;
      amountMinor: number;
      paidMinor: number;
      dueDate: Date;
    };
  }>([
    {
      $match: {
        merchantId,
        status: { $nin: CLOSED_STATUSES },
        // `$in` rather than `$ne: 'paid'`: against an array, `$ne` matches only documents
        // where no element equals the value, which would drop every plan that has had one
        // instalment settled. After the `$unwind` below the field is a scalar, so the
        // second match can use `$ne` safely.
        'installments.status': { $in: UNPAID_INSTALLMENT_STATUSES },
      },
    },
    { $unwind: '$installments' },
    {
      $match: {
        'installments.status': { $ne: 'paid' },
        ...(options.overdueOnly ? { 'installments.dueDate': { $lt: now } } : {}),
        ...(horizon ? { 'installments.dueDate': { $lte: horizon } } : {}),
      },
    },
    { $sort: { 'installments.dueDate': 1 } },
    { $limit: options.limit },
    {
      $project: {
        reference: 1,
        customerName: 1,
        installment: '$installments',
      },
    },
  ]);

  return rows.map((row) => ({
    orderId: String(row._id),
    reference: row.reference,
    customerName: row.customerName,
    number: row.installment.number,
    amountMinor: row.installment.amountMinor,
    paidMinor: row.installment.paidMinor,
    outstandingMinor: Math.max(0, row.installment.amountMinor - row.installment.paidMinor),
    dueDate: row.installment.dueDate.toISOString(),
    isOverdue: row.installment.dueDate.getTime() < now.getTime(),
  }));
}

/** Guards an id coming from a path or query before it reaches an aggregation. */
export function requireObjectId(value: string, message: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw AppError.notFound(message);
  return new Types.ObjectId(value);
}
