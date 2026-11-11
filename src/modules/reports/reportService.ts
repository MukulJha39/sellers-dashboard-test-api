import type { PipelineStage, Types } from 'mongoose';
import { STOCK_HOLDING_ORDER_STATUSES } from '../../config/orders';
import { Customer } from '../../models/Customer';
import { Item } from '../../models/Item';
import { Order } from '../../models/Order';
import { PaymentEntry } from '../../models/PaymentEntry';
import { Purchase } from '../../models/Purchase';
import { RawMaterial } from '../../models/RawMaterial';
import { escapeRegex } from '../../utils/pagination';
import { fromThousandths } from '../../utils/quantity';
import {
  bucketExpression,
  bucketKeys,
  percentChange,
  presentPeriod,
  wholeDaysSince,
  type ResolvedPeriod,
} from './reportPeriod';

/**
 * The merchant's reports (the "Reports" screen in the app).
 *
 * Every figure is counted from the merchant's own records by an aggregation scoped to
 * their `merchantId`. The rules that decide what counts are kept here, in one place:
 *
 * - **Sold** means an order the merchant committed to: confirmed, in progress, ready or
 *   completed. Drafts are quotes, and cancelled or returned orders were undone.
 * - **Profit** counts completed orders only, on the day they were completed.
 * - **Money to collect** counts completed orders that are not fully paid.
 * - **Money in and out** is cash: payments received from customers, and payments made
 *   to suppliers for purchases (raw materials and goods), on the day they were paid.
 */

const SOLD_STATUSES = [...STOCK_HOLDING_ORDER_STATUSES];
const WALK_IN = 'Walk-in sale';

type Paging = { skip: number; limit: number };

/** A `$round` that works on every MongoDB version the app supports. */
function roundExpr(expression: unknown): Record<string, unknown> {
  return { $toLong: { $floor: { $add: [expression, 0.5] } } };
}

/** Joins series rows onto every bucket of the window, so empty days still appear. */
function fillSeries<T extends Record<string, number>>(
  period: ResolvedPeriod,
  rows: Array<{ _id: string } & Partial<T>>,
  empty: T,
): Array<{ date: string } & T> {
  const byKey = new Map(rows.map((row) => [row._id, row]));
  return bucketKeys(period).map((key) => {
    const row = byKey.get(key);
    const filled = { ...empty };
    for (const field of Object.keys(empty) as Array<keyof T>) {
      const value = row?.[field];
      if (typeof value === 'number') filled[field] = value as T[keyof T];
    }
    return { date: key, ...filled };
  });
}

/* ---------------------------------- sales ---------------------------------- */

/** How much was sold in a window, compared with the window before it, and day by day. */
export async function salesReport(merchantId: Types.ObjectId, period: ResolvedPeriod) {
  const inWindow = (start: Date, end: Date) => ({
    merchantId,
    status: { $in: SOLD_STATUSES },
    orderDate: { $gte: start, $lt: end },
  });

  const [facets] = await Order.aggregate<{
    totals: Array<{
      orderCount: number;
      grossMinor: number;
      discountMinor: number;
      taxMinor: number;
      totalMinor: number;
      paidMinor: number;
      customers: unknown[];
      walkInOrders: number;
    }>;
    byPayment: Array<{ _id: string; count: number; totalMinor: number }>;
    series: Array<{ _id: string; totalMinor: number; orderCount: number }>;
  }>([
    { $match: inWindow(period.start, period.end) },
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              orderCount: { $sum: 1 },
              grossMinor: { $sum: '$subtotalMinor' },
              discountMinor: { $sum: '$discountMinor' },
              taxMinor: { $sum: '$taxMinor' },
              totalMinor: { $sum: '$totalMinor' },
              paidMinor: { $sum: '$paidMinor' },
              customers: { $addToSet: '$customerId' },
              walkInOrders: { $sum: { $cond: [{ $eq: ['$customerId', null] }, 1, 0] } },
            },
          },
        ],
        byPayment: [
          { $group: { _id: '$paymentStatus', count: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' } } },
        ],
        series: [
          {
            $group: {
              _id: bucketExpression('$orderDate', period),
              totalMinor: { $sum: '$totalMinor' },
              orderCount: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  const [previous] = await Order.aggregate<{ totalMinor: number; orderCount: number }>([
    { $match: inWindow(period.previous.start, period.previous.end) },
    { $group: { _id: null, totalMinor: { $sum: '$totalMinor' }, orderCount: { $sum: 1 } } },
  ]);

  const totals = facets?.totals[0];
  const totalMinor = totals?.totalMinor ?? 0;
  const orderCount = totals?.orderCount ?? 0;
  const paidMinor = totals?.paidMinor ?? 0;
  const payment = (status: string) => facets?.byPayment.find((row) => row._id === status);

  return {
    period: presentPeriod(period),
    summary: {
      totalMinor,
      orderCount,
      averageOrderMinor: orderCount > 0 ? Math.round(totalMinor / orderCount) : 0,
      grossMinor: totals?.grossMinor ?? 0,
      discountMinor: totals?.discountMinor ?? 0,
      taxMinor: totals?.taxMinor ?? 0,
      collectedMinor: Math.min(paidMinor, totalMinor),
      outstandingMinor: Math.max(0, totalMinor - paidMinor),
      customerCount: (totals?.customers ?? []).filter((id) => id !== null).length,
      walkInOrders: totals?.walkInOrders ?? 0,
    },
    byPaymentStatus: (['fully_paid', 'partially_paid', 'unpaid'] as const).map((status) => ({
      paymentStatus: status,
      orderCount: payment(status)?.count ?? 0,
      totalMinor: payment(status)?.totalMinor ?? 0,
    })),
    comparison: {
      totalMinor: previous?.totalMinor ?? 0,
      orderCount: previous?.orderCount ?? 0,
      totalChangePercent: percentChange(totalMinor, previous?.totalMinor ?? 0),
      orderChangePercent: percentChange(orderCount, previous?.orderCount ?? 0),
    },
    series: fillSeries(period, facets?.series ?? [], { totalMinor: 0, orderCount: 0 }),
  };
}

/* ------------------------------- profit / loss ------------------------------ */

/**
 * Cost of the item lines on completed orders. Uses the cost price saved on the line when
 * the order was made; an older order falls back to the item's current cost price. A line
 * with neither is counted as costing nothing and reported, so the app can say the
 * profit is overstated until those cost prices are filled in.
 */
function costPipeline(match: Record<string, unknown>, period: ResolvedPeriod): PipelineStage[] {
  return [
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.lineType': 'item' } },
    {
      $lookup: {
        from: Item.collection.name,
        localField: 'lines.subjectId',
        foreignField: '_id',
        as: 'item',
        pipeline: [{ $project: { costPriceMinor: 1 } }],
      },
    },
    {
      $addFields: {
        unitCost: {
          $ifNull: ['$lines.unitCostMinor', { $first: '$item.costPriceMinor' }],
        },
      },
    },
    {
      $group: {
        _id: bucketExpression('$completedAt', period),
        costMinor: {
          $sum: {
            $cond: [
              { $eq: ['$unitCost', null] },
              0,
              roundExpr({ $divide: [{ $multiply: ['$unitCost', '$lines.quantityThousandths'] }, 1000] }),
            ],
          },
        },
        linesWithoutCost: { $sum: { $cond: [{ $eq: ['$unitCost', null] }, 1, 0] } },
        productsWithoutCost: {
          $addToSet: { $cond: [{ $eq: ['$unitCost', null] }, '$lines.subjectId', '$$REMOVE'] },
        },
      },
    },
  ];
}

/** What the merchant earned on the orders they completed in a window. */
export async function profitLossReport(merchantId: Types.ObjectId, period: ResolvedPeriod) {
  const completedIn = (start: Date, end: Date) => ({
    merchantId,
    status: 'completed',
    completedAt: { $gte: start, $lt: end },
  });

  const revenue = (start: Date, end: Date, by: ResolvedPeriod | null) =>
    Order.aggregate<{
      _id: string | null;
      orderCount: number;
      totalMinor: number;
      taxMinor: number;
      discountMinor: number;
      itemSalesMinor: number;
      serviceSalesMinor: number;
    }>([
      { $match: completedIn(start, end) },
      {
        $group: {
          _id: by ? bucketExpression('$completedAt', by) : null,
          orderCount: { $sum: 1 },
          totalMinor: { $sum: '$totalMinor' },
          taxMinor: { $sum: '$taxMinor' },
          discountMinor: { $sum: '$discountMinor' },
          itemSalesMinor: {
            $sum: {
              $sum: {
                $map: {
                  input: { $filter: { input: '$lines', cond: { $eq: ['$$this.lineType', 'item'] } } },
                  in: '$$this.lineTotalMinor',
                },
              },
            },
          },
          serviceSalesMinor: {
            $sum: {
              $sum: {
                $map: {
                  input: { $filter: { input: '$lines', cond: { $eq: ['$$this.lineType', 'service'] } } },
                  in: '$$this.lineTotalMinor',
                },
              },
            },
          },
        },
      },
    ]);

  const [byBucket, costByBucket, previousRevenue, previousCost] = await Promise.all([
    revenue(period.start, period.end, period),
    Order.aggregate<{ _id: string; costMinor: number; linesWithoutCost: number; productsWithoutCost: Types.ObjectId[] }>(
      costPipeline(completedIn(period.start, period.end), period),
    ),
    revenue(period.previous.start, period.previous.end, null),
    Order.aggregate<{ costMinor: number }>(
      costPipeline(completedIn(period.previous.start, period.previous.end), period),
    ),
  ]);

  const add = <K extends string>(rows: Array<Partial<Record<K, number>>>, key: K) =>
    rows.reduce((total, row) => total + (row[key] ?? 0), 0);

  const totalMinor = add(byBucket, 'totalMinor');
  const taxMinor = add(byBucket, 'taxMinor');
  const revenueMinor = totalMinor - taxMinor;
  const costMinor = add(costByBucket, 'costMinor');
  const profitMinor = revenueMinor - costMinor;
  const productsWithoutCost = new Set(
    costByBucket.flatMap((row) => row.productsWithoutCost.map((id) => String(id))),
  );

  const previousRevenueMinor =
    (previousRevenue[0]?.totalMinor ?? 0) - (previousRevenue[0]?.taxMinor ?? 0);
  const previousProfitMinor = previousRevenueMinor - add(previousCost, 'costMinor');

  const costByKey = new Map(costByBucket.map((row) => [row._id, row.costMinor]));
  const series = fillSeries(
    period,
    byBucket.map((row) => {
      const rowRevenue = row.totalMinor - row.taxMinor;
      const rowCost = costByKey.get(row._id ?? '') ?? 0;
      return {
        _id: row._id ?? '',
        revenueMinor: rowRevenue,
        costMinor: rowCost,
        profitMinor: rowRevenue - rowCost,
        orderCount: row.orderCount,
      };
    }),
    { revenueMinor: 0, costMinor: 0, profitMinor: 0, orderCount: 0 },
  );

  return {
    period: presentPeriod(period),
    summary: {
      orderCount: add(byBucket, 'orderCount'),
      /** What customers were billed, tax included. */
      totalMinor,
      /** Tax collected on behalf of the government; not the merchant's income. */
      taxMinor,
      discountMinor: add(byBucket, 'discountMinor'),
      /** Sales after discount, before tax: what the merchant earned from selling. */
      revenueMinor,
      itemSalesMinor: add(byBucket, 'itemSalesMinor'),
      serviceSalesMinor: add(byBucket, 'serviceSalesMinor'),
      /** What the goods sold cost the merchant. Services carry no cost. */
      costMinor,
      profitMinor,
      isLoss: profitMinor < 0,
      marginPercent: revenueMinor > 0 ? Math.round((profitMinor / revenueMinor) * 1000) / 10 : null,
    },
    /** Sold goods with no cost price: their cost is counted as zero, so profit is overstated. */
    missingCost: {
      lineCount: add(costByBucket, 'linesWithoutCost'),
      productCount: productsWithoutCost.size,
      productIds: [...productsWithoutCost].slice(0, 50),
    },
    comparison: {
      revenueMinor: previousRevenueMinor,
      profitMinor: previousProfitMinor,
      revenueChangePercent: percentChange(revenueMinor, previousRevenueMinor),
      profitChangePercent: percentChange(profitMinor, previousProfitMinor),
    },
    series,
  };
}

/* ------------------------------ money in and out ---------------------------- */

const receivedExpr = { $add: ['$amountMinor', { $ifNull: ['$advanceMinor', 0] }] };

/**
 * Cash that came in from customers and went out to suppliers in a window, by the day
 * it changed hands. Money in includes any part a customer paid as advance. Money out is
 * every payment made against a purchase; it is split between raw materials and goods in
 * the same proportion as that purchase's lines.
 */
export async function moneyInOutReport(merchantId: Types.ObjectId, period: ResolvedPeriod) {
  const window = (start: Date, end: Date) => ({ merchantId, paidAt: { $gte: start, $lt: end } });

  const [facets] = await PaymentEntry.aggregate<{
    in: Array<{ total: number; count: number; advance: number }>;
    out: Array<{ total: number; count: number; materials: number }>;
    inByMethod: Array<{ _id: string; total: number; count: number }>;
    outByMethod: Array<{ _id: string; total: number; count: number }>;
    series: Array<{ _id: string; inMinor: number; outMinor: number }>;
  }>([
    { $match: window(period.start, period.end) },
    {
      $facet: {
        in: [
          { $match: { direction: 'in' } },
          {
            $group: {
              _id: null,
              total: { $sum: receivedExpr },
              advance: { $sum: { $ifNull: ['$advanceMinor', 0] } },
              count: { $sum: 1 },
            },
          },
        ],
        out: [
          { $match: { direction: 'out', payableType: 'purchase' } },
          {
            $lookup: {
              from: Purchase.collection.name,
              localField: 'payableId',
              foreignField: '_id',
              as: 'purchase',
              pipeline: [{ $project: { lines: 1, subtotalMinor: 1 } }],
            },
          },
          {
            $addFields: {
              materialShare: {
                $let: {
                  vars: { purchase: { $first: '$purchase' } },
                  in: {
                    $cond: [
                      { $gt: [{ $ifNull: ['$$purchase.subtotalMinor', 0] }, 0] },
                      {
                        $divide: [
                          {
                            $sum: {
                              $map: {
                                input: {
                                  $filter: {
                                    input: '$$purchase.lines',
                                    cond: { $eq: ['$$this.subjectType', 'material'] },
                                  },
                                },
                                in: '$$this.lineTotalMinor',
                              },
                            },
                          },
                          '$$purchase.subtotalMinor',
                        ],
                      },
                      0,
                    ],
                  },
                },
              },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$amountMinor' },
              materials: { $sum: roundExpr({ $multiply: ['$amountMinor', '$materialShare'] }) },
              count: { $sum: 1 },
            },
          },
        ],
        inByMethod: [
          { $match: { direction: 'in' } },
          { $group: { _id: '$method', total: { $sum: receivedExpr }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        outByMethod: [
          { $match: { direction: 'out' } },
          { $group: { _id: '$method', total: { $sum: '$amountMinor' }, count: { $sum: 1 } } },
          { $sort: { total: -1 } },
        ],
        series: [
          {
            $group: {
              _id: bucketExpression('$paidAt', period),
              inMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, receivedExpr, 0] } },
              outMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountMinor', 0] } },
            },
          },
        ],
      },
    },
  ]);

  const [previous] = await PaymentEntry.aggregate<{ inMinor: number; outMinor: number }>([
    { $match: window(period.previous.start, period.previous.end) },
    {
      $group: {
        _id: null,
        inMinor: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, receivedExpr, 0] } },
        outMinor: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountMinor', 0] } },
      },
    },
  ]);

  const inMinor = facets?.in[0]?.total ?? 0;
  const outMinor = facets?.out[0]?.total ?? 0;
  const materialsMinor = Math.min(outMinor, facets?.out[0]?.materials ?? 0);
  const netMinor = inMinor - outMinor;
  const previousNet = (previous?.inMinor ?? 0) - (previous?.outMinor ?? 0);
  const byMethod = (rows: Array<{ _id: string; total: number; count: number }> | undefined) =>
    (rows ?? []).map((row) => ({ method: row._id, totalMinor: row.total, count: row.count }));

  return {
    period: presentPeriod(period),
    summary: {
      inMinor,
      outMinor,
      netMinor,
      /** True when more went out than came in. */
      isNegative: netMinor < 0,
    },
    in: {
      totalMinor: inMinor,
      paymentCount: facets?.in[0]?.count ?? 0,
      /** Part of `totalMinor` customers paid beyond their orders, kept as advance. */
      advanceMinor: facets?.in[0]?.advance ?? 0,
      byMethod: byMethod(facets?.inByMethod),
    },
    out: {
      totalMinor: outMinor,
      paymentCount: facets?.out[0]?.count ?? 0,
      rawMaterialsMinor: materialsMinor,
      goodsMinor: outMinor - materialsMinor,
      byMethod: byMethod(facets?.outByMethod),
    },
    comparison: {
      inMinor: previous?.inMinor ?? 0,
      outMinor: previous?.outMinor ?? 0,
      netMinor: previousNet,
      inChangePercent: percentChange(inMinor, previous?.inMinor ?? 0),
      outChangePercent: percentChange(outMinor, previous?.outMinor ?? 0),
    },
    series: fillSeries(
      period,
      (facets?.series ?? []).map((row) => ({ ...row, netMinor: row.inMinor - row.outMinor })),
      { inMinor: 0, outMinor: 0, netMinor: 0 },
    ),
  };
}

/* ------------------------------ money to collect ---------------------------- */

export const COLLECT_SORTS = ['outstanding', 'oldest', 'due', 'name'] as const;
export type CollectSort = (typeof COLLECT_SORTS)[number];

/**
 * What customers still owe on orders that are completed — the work is done and handed
 * over, and only the money is left. Open orders are not counted: nothing is owed on
 * them yet in the merchant's eyes.
 *
 * `view: 'customer'` groups by who owes (the default, since a merchant chases people);
 * `view: 'order'` lists each order, optionally for one customer.
 */
export async function moneyToCollectReport(
  merchantId: Types.ObjectId,
  options: {
    view: 'customer' | 'order';
    customerId?: Types.ObjectId | null;
    overdueOnly?: boolean;
    sort: CollectSort;
    paging: Paging;
  },
  now: Date = new Date(),
) {
  const owing: Record<string, unknown> = {
    merchantId,
    status: 'completed',
    paymentStatus: { $ne: 'fully_paid' },
  };
  const outstandingExpr = { $max: [0, { $subtract: ['$totalMinor', '$paidMinor'] }] };
  const overdueCond = { $and: [{ $ne: ['$dueDate', null] }, { $lt: ['$dueDate', now] }] };

  const [summary] = await Order.aggregate<{
    outstandingMinor: number;
    orderCount: number;
    customers: unknown[];
    overdueMinor: number;
    overdueOrders: number;
    oldestCompletedAt: Date | null;
  }>([
    { $match: owing },
    {
      $group: {
        _id: null,
        outstandingMinor: { $sum: outstandingExpr },
        orderCount: { $sum: 1 },
        customers: { $addToSet: '$customerId' },
        overdueMinor: { $sum: { $cond: [overdueCond, outstandingExpr, 0] } },
        overdueOrders: { $sum: { $cond: [overdueCond, 1, 0] } },
        oldestCompletedAt: { $min: '$completedAt' },
      },
    },
  ]);

  const match: Record<string, unknown> = { ...owing };
  if (options.customerId) match.customerId = options.customerId;
  if (options.overdueOnly) match.dueDate = { $ne: null, $lt: now };

  const summaryView = {
    outstandingMinor: summary?.outstandingMinor ?? 0,
    orderCount: summary?.orderCount ?? 0,
    customerCount: (summary?.customers ?? []).filter((id) => id !== null).length,
    walkInIncluded: (summary?.customers ?? []).some((id) => id === null),
    overdueMinor: summary?.overdueMinor ?? 0,
    overdueOrders: summary?.overdueOrders ?? 0,
    oldestPendingDays: wholeDaysSince(summary?.oldestCompletedAt, now),
  };

  if (options.view === 'order') {
    const sort: Record<string, 1 | -1> =
      options.sort === 'oldest'
        ? { completedAt: 1, _id: 1 }
        : options.sort === 'due'
          ? { dueDate: 1, completedAt: 1 }
          : options.sort === 'name'
            ? { customerName: 1, completedAt: 1 }
            : { outstanding: -1, completedAt: 1 };

    const [rows, total] = await Promise.all([
      Order.aggregate<{
        _id: Types.ObjectId;
        reference: string;
        customerId: Types.ObjectId | null;
        customerName: string | null;
        totalMinor: number;
        paidMinor: number;
        outstanding: number;
        completedAt: Date | null;
        orderDate: Date;
        dueDate: Date | null;
      }>([
        { $match: match },
        { $addFields: { outstanding: outstandingExpr } },
        { $sort: sort },
        { $skip: options.paging.skip },
        { $limit: options.paging.limit },
        {
          $project: {
            reference: 1,
            customerId: 1,
            customerName: 1,
            totalMinor: 1,
            paidMinor: 1,
            outstanding: 1,
            completedAt: 1,
            orderDate: 1,
            dueDate: 1,
          },
        },
      ]),
      Order.countDocuments(match),
    ]);

    return {
      summary: summaryView,
      view: 'order' as const,
      total,
      items: rows.map((row) => ({
        orderId: String(row._id),
        reference: row.reference,
        customerId: row.customerId ? String(row.customerId) : null,
        customerName: row.customerName ?? WALK_IN,
        totalMinor: row.totalMinor,
        paidMinor: row.paidMinor,
        outstandingMinor: row.outstanding,
        orderDate: row.orderDate.toISOString(),
        completedAt: row.completedAt ? row.completedAt.toISOString() : null,
        dueDate: row.dueDate ? row.dueDate.toISOString() : null,
        isOverdue: !!row.dueDate && row.dueDate.getTime() < now.getTime(),
        pendingDays: wholeDaysSince(row.completedAt, now),
      })),
    };
  }

  const sort: Record<string, 1 | -1> =
    options.sort === 'oldest'
      ? { oldestCompletedAt: 1, _id: 1 }
      : options.sort === 'due'
        ? { nextDueDate: 1, outstandingMinor: -1 }
        : options.sort === 'name'
          ? { customerName: 1, _id: 1 }
          : { outstandingMinor: -1, _id: 1 };

  const grouped: PipelineStage[] = [
    { $match: match },
    {
      $group: {
        _id: '$customerId',
        customerName: { $last: '$customerName' },
        orderCount: { $sum: 1 },
        totalMinor: { $sum: '$totalMinor' },
        paidMinor: { $sum: '$paidMinor' },
        outstandingMinor: { $sum: outstandingExpr },
        overdueMinor: { $sum: { $cond: [overdueCond, outstandingExpr, 0] } },
        oldestCompletedAt: { $min: '$completedAt' },
        nextDueDate: { $min: '$dueDate' },
      },
    },
  ];

  const [rows, counted] = await Promise.all([
    Order.aggregate<{
      _id: Types.ObjectId | null;
      customerName: string | null;
      orderCount: number;
      totalMinor: number;
      paidMinor: number;
      outstandingMinor: number;
      overdueMinor: number;
      oldestCompletedAt: Date | null;
      nextDueDate: Date | null;
      customer: Array<{ phoneE164?: string; advanceMinor?: number }>;
    }>([
      ...grouped,
      { $sort: sort },
      { $skip: options.paging.skip },
      { $limit: options.paging.limit },
      {
        $lookup: {
          from: Customer.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'customer',
          pipeline: [{ $project: { phoneE164: 1, advanceMinor: 1 } }],
        },
      },
    ]),
    Order.aggregate<{ count: number }>([...grouped, { $count: 'count' }]),
  ]);

  return {
    summary: summaryView,
    view: 'customer' as const,
    total: counted[0]?.count ?? 0,
    items: rows.map((row) => ({
      customerId: row._id ? String(row._id) : null,
      customerName: row.customerName ?? WALK_IN,
      phoneE164: row.customer[0]?.phoneE164 ?? null,
      orderCount: row.orderCount,
      totalMinor: row.totalMinor,
      paidMinor: row.paidMinor,
      outstandingMinor: row.outstandingMinor,
      overdueMinor: row.overdueMinor,
      isOverdue: row.overdueMinor > 0,
      /** Advance the customer has with the merchant, which could settle part of this. */
      advanceMinor: row.customer[0]?.advanceMinor ?? 0,
      oldestCompletedAt: row.oldestCompletedAt ? row.oldestCompletedAt.toISOString() : null,
      pendingDays: wholeDaysSince(row.oldestCompletedAt, now),
      nextDueDate: row.nextDueDate ? row.nextDueDate.toISOString() : null,
    })),
  };
}

/* ------------------------------- goods in shop ------------------------------ */

export const STOCK_STATUSES = ['in_stock', 'low', 'out', 'untracked'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];
export const STOCK_SORTS = ['name', 'quantity', 'value', 'status'] as const;
export type StockSort = (typeof STOCK_SORTS)[number];

interface StockRecord {
  _id: Types.ObjectId;
  name: string;
  unit: string;
  trackStock: boolean;
  quantityThousandths: number;
  lowStockThresholdThousandths: number;
  isLowStock: boolean;
  costPriceMinor?: number | null;
  sellingPriceMinor?: number | null;
  purchaseCostMinor?: number | null;
}

function stockStatusOf(record: StockRecord): StockStatus {
  if (!record.trackStock) return 'untracked';
  if (record.quantityThousandths <= 0) return 'out';
  if (record.isLowStock) return 'low';
  return 'in_stock';
}

const STATUS_ORDER: Record<StockStatus, number> = { out: 0, low: 1, in_stock: 2, untracked: 3 };

/**
 * How much of each product (and, on request, raw material) the merchant has, with its
 * worth. Each row carries what the app needs to open the stock update screen for it
 * (`POST /stock/:subjectType/:subjectId/adjust` or `/quantity`).
 */
export async function stockReport(
  merchantId: Types.ObjectId,
  options: {
    type: 'item' | 'material' | 'all';
    status?: StockStatus;
    search?: string;
    sort: StockSort;
    descending: boolean;
    paging: Paging;
  },
) {
  const filter: Record<string, unknown> = { merchantId, archived: false };
  if (options.search) filter.name = { $regex: escapeRegex(options.search), $options: 'i' };
  const fields =
    'name unit trackStock quantityThousandths lowStockThresholdThousandths isLowStock costPriceMinor sellingPriceMinor purchaseCostMinor';

  const [items, materials] = await Promise.all([
    options.type === 'material' ? [] : Item.find(filter).select(fields).lean<StockRecord[]>(),
    options.type === 'item' ? [] : RawMaterial.find(filter).select(fields).lean<StockRecord[]>(),
  ]);

  const rows = [
    ...items.map((record) => ({ record, subjectType: 'item' as const })),
    ...materials.map((record) => ({ record, subjectType: 'material' as const })),
  ].map(({ record, subjectType }) => {
    const status = stockStatusOf(record);
    const unitCost = subjectType === 'item' ? record.costPriceMinor ?? null : record.purchaseCostMinor ?? null;
    const counted = record.trackStock ? Math.max(0, record.quantityThousandths) : 0;
    return {
      subjectType,
      id: String(record._id),
      name: record.name,
      unit: record.unit,
      trackStock: record.trackStock,
      quantity: fromThousandths(record.quantityThousandths),
      lowStockThreshold: fromThousandths(record.lowStockThresholdThousandths),
      status,
      unitCostMinor: unitCost,
      sellingPriceMinor: subjectType === 'item' ? record.sellingPriceMinor ?? 0 : null,
      /** Stock on hand at cost. Null when no cost price is set. */
      stockValueMinor: unitCost === null ? null : Math.round((unitCost * counted) / 1000),
      /** Stock on hand at selling price, for products. */
      saleValueMinor:
        subjectType === 'item' ? Math.round(((record.sellingPriceMinor ?? 0) * counted) / 1000) : null,
    };
  });

  const summary = {
    productCount: rows.length,
    inStock: rows.filter((row) => row.status === 'in_stock').length,
    lowStock: rows.filter((row) => row.status === 'low').length,
    outOfStock: rows.filter((row) => row.status === 'out').length,
    untracked: rows.filter((row) => row.status === 'untracked').length,
    stockValueMinor: rows.reduce((total, row) => total + (row.stockValueMinor ?? 0), 0),
    saleValueMinor: rows.reduce((total, row) => total + (row.saleValueMinor ?? 0), 0),
    withoutCostPrice: rows.filter((row) => row.trackStock && row.unitCostMinor === null).length,
  };

  const filtered = options.status ? rows.filter((row) => row.status === options.status) : rows;
  const direction = options.descending ? -1 : 1;
  filtered.sort((a, b) => {
    let compared = 0;
    if (options.sort === 'quantity') compared = a.quantity - b.quantity;
    else if (options.sort === 'value') compared = (a.stockValueMinor ?? -1) - (b.stockValueMinor ?? -1);
    else if (options.sort === 'status') compared = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    return compared * direction || a.name.localeCompare(b.name);
  });

  return {
    summary,
    total: filtered.length,
    items: filtered.slice(options.paging.skip, options.paging.skip + options.paging.limit),
  };
}

/* ------------------------- best sellers / by product ------------------------ */

export const PRODUCT_SORTS = ['quantity', 'revenue', 'orders'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/**
 * What sold in a window, product by product: quantity, money made and how many orders
 * it was on. Backs both "Best sellers" (by quantity) and "By product" (by money).
 */
export async function productSalesReport(
  merchantId: Types.ObjectId,
  period: ResolvedPeriod,
  options: { lineType: 'item' | 'service' | 'all'; sort: ProductSort; paging: Paging },
) {
  const lineMatch = options.lineType === 'all' ? {} : { 'lines.lineType': options.lineType };
  const grouped: PipelineStage[] = [
    {
      $match: {
        merchantId,
        status: { $in: SOLD_STATUSES },
        orderDate: { $gte: period.start, $lt: period.end },
      },
    },
    { $unwind: '$lines' },
    ...(options.lineType === 'all' ? [] : [{ $match: lineMatch } as PipelineStage]),
    { $sort: { orderDate: 1 } },
    {
      $group: {
        _id: { lineType: '$lines.lineType', subjectId: '$lines.subjectId' },
        name: { $last: '$lines.name' },
        unit: { $last: '$lines.unit' },
        billingUnit: { $last: '$lines.billingUnit' },
        quantityThousandths: { $sum: '$lines.quantityThousandths' },
        revenueMinor: { $sum: '$lines.lineTotalMinor' },
        orderIds: { $addToSet: '$_id' },
        lastSoldAt: { $last: '$orderDate' },
      },
    },
    { $addFields: { orderCount: { $size: '$orderIds' } } },
  ];

  const sortField =
    options.sort === 'revenue' ? 'revenueMinor' : options.sort === 'orders' ? 'orderCount' : 'quantityThousandths';

  const [rows, totals] = await Promise.all([
    Order.aggregate<{
      _id: { lineType: 'item' | 'service'; subjectId: Types.ObjectId };
      name: string;
      unit: string | null;
      billingUnit: string | null;
      quantityThousandths: number;
      revenueMinor: number;
      orderCount: number;
      lastSoldAt: Date;
    }>([
      ...grouped,
      { $sort: { [sortField]: -1, revenueMinor: -1, name: 1 } },
      { $skip: options.paging.skip },
      { $limit: options.paging.limit },
      { $project: { orderIds: 0 } },
    ]),
    Order.aggregate<{ count: number; revenueMinor: number; quantityThousandths: number }>([
      ...grouped,
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          revenueMinor: { $sum: '$revenueMinor' },
          quantityThousandths: { $sum: '$quantityThousandths' },
        },
      },
    ]),
  ]);

  const totalRevenue = totals[0]?.revenueMinor ?? 0;

  return {
    period: presentPeriod(period),
    summary: {
      productCount: totals[0]?.count ?? 0,
      revenueMinor: totalRevenue,
    },
    total: totals[0]?.count ?? 0,
    items: rows.map((row, index) => ({
      rank: options.paging.skip + index + 1,
      lineType: row._id.lineType,
      subjectId: String(row._id.subjectId),
      name: row.name,
      unit: row.unit ?? null,
      billingUnit: row.billingUnit ?? null,
      quantity: fromThousandths(row.quantityThousandths),
      revenueMinor: row.revenueMinor,
      /** This product's part of all sales in the window. */
      revenueSharePercent: totalRevenue > 0 ? Math.round((row.revenueMinor / totalRevenue) * 1000) / 10 : 0,
      orderCount: row.orderCount,
      lastSoldAt: row.lastSoldAt.toISOString(),
    })),
  };
}

/* -------------------------------- not selling ------------------------------- */

export const IDLE_SORTS = ['sold', 'lastSold', 'lastPurchased', 'stock', 'value', 'name'] as const;
export type IdleSort = (typeof IDLE_SORTS)[number];

/**
 * Products that are just sitting: for each one, how much sold in the window, when it
 * last sold, when it was last bought, and how much is on the shelf. Least sold first
 * by default, so the slowest goods are at the top.
 */
export async function notSellingReport(
  merchantId: Types.ObjectId,
  period: ResolvedPeriod,
  options: {
    sort: IdleSort;
    descending: boolean;
    unsoldOnly: boolean;
    inStockOnly: boolean;
    paging: Paging;
  },
  now: Date = new Date(),
) {
  const [items, sales, purchases] = await Promise.all([
    Item.find({ merchantId, archived: false })
      .select('name unit trackStock quantityThousandths costPriceMinor sellingPriceMinor createdAt')
      .lean<Array<StockRecord & { createdAt: Date }>>(),
    Order.aggregate<{ _id: Types.ObjectId; lastSoldAt: Date; soldThousandths: number; revenueMinor: number }>([
      { $match: { merchantId, status: { $in: SOLD_STATUSES }, 'lines.lineType': 'item' } },
      { $unwind: '$lines' },
      { $match: { 'lines.lineType': 'item' } },
      {
        $group: {
          _id: '$lines.subjectId',
          lastSoldAt: { $max: '$orderDate' },
          soldThousandths: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$orderDate', period.start] }, { $lt: ['$orderDate', period.end] }] },
                '$lines.quantityThousandths',
                0,
              ],
            },
          },
          revenueMinor: {
            $sum: {
              $cond: [
                { $and: [{ $gte: ['$orderDate', period.start] }, { $lt: ['$orderDate', period.end] }] },
                '$lines.lineTotalMinor',
                0,
              ],
            },
          },
        },
      },
    ]),
    Purchase.aggregate<{ _id: Types.ObjectId; lastPurchasedAt: Date }>([
      { $match: { merchantId, status: 'recorded', 'lines.subjectType': 'item' } },
      { $unwind: '$lines' },
      { $match: { 'lines.subjectType': 'item' } },
      { $group: { _id: '$lines.subjectId', lastPurchasedAt: { $max: '$purchaseDate' } } },
    ]),
  ]);

  const salesById = new Map(sales.map((row) => [String(row._id), row]));
  const purchasesById = new Map(purchases.map((row) => [String(row._id), row]));

  let rows = items.map((item) => {
    const sold = salesById.get(String(item._id));
    const bought = purchasesById.get(String(item._id));
    const onHand = item.trackStock ? Math.max(0, item.quantityThousandths) : 0;
    const lastSoldAt = sold?.lastSoldAt ?? null;
    return {
      id: String(item._id),
      name: item.name,
      unit: item.unit,
      trackStock: item.trackStock,
      quantity: fromThousandths(item.quantityThousandths),
      soldQuantity: fromThousandths(sold?.soldThousandths ?? 0),
      revenueMinor: sold?.revenueMinor ?? 0,
      lastSoldAt: lastSoldAt ? lastSoldAt.toISOString() : null,
      daysSinceLastSale: wholeDaysSince(lastSoldAt, now),
      lastPurchasedAt: bought ? bought.lastPurchasedAt.toISOString() : null,
      daysSinceLastPurchase: wholeDaysSince(bought?.lastPurchasedAt, now),
      /** Money tied up in this product's stock, at cost. Null when no cost price is set. */
      stockValueMinor:
        item.costPriceMinor === null || item.costPriceMinor === undefined
          ? null
          : Math.round((item.costPriceMinor * onHand) / 1000),
      neverSold: !lastSoldAt,
      addedAt: item.createdAt.toISOString(),
    };
  });

  if (options.unsoldOnly) rows = rows.filter((row) => row.soldQuantity === 0);
  if (options.inStockOnly) rows = rows.filter((row) => row.trackStock && row.quantity > 0);

  const time = (value: string | null) => (value ? Date.parse(value) : 0);
  const direction = options.descending ? -1 : 1;
  rows.sort((a, b) => {
    let compared = 0;
    switch (options.sort) {
      case 'sold':
        compared = a.soldQuantity - b.soldQuantity || time(a.lastSoldAt) - time(b.lastSoldAt);
        break;
      case 'lastSold':
        compared = time(a.lastSoldAt) - time(b.lastSoldAt);
        break;
      case 'lastPurchased':
        compared = time(a.lastPurchasedAt) - time(b.lastPurchasedAt);
        break;
      case 'stock':
        compared = a.quantity - b.quantity;
        break;
      case 'value':
        compared = (a.stockValueMinor ?? -1) - (b.stockValueMinor ?? -1);
        break;
      case 'name':
        break;
    }
    return compared * direction || a.name.localeCompare(b.name);
  });

  return {
    period: presentPeriod(period),
    summary: {
      productCount: rows.length,
      unsoldCount: rows.filter((row) => row.soldQuantity === 0).length,
      neverSoldCount: rows.filter((row) => row.neverSold).length,
      /** Money tied up in stock that did not sell at all in the window. */
      idleStockValueMinor: rows
        .filter((row) => row.soldQuantity === 0)
        .reduce((total, row) => total + (row.stockValueMinor ?? 0), 0),
    },
    total: rows.length,
    items: rows.slice(options.paging.skip, options.paging.skip + options.paging.limit),
  };
}

/* -------------------------------- by customer ------------------------------- */

export const CUSTOMER_SORTS = ['spent', 'orders', 'outstanding', 'lastOrder'] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

/** Who bought what in a window: one row per customer, biggest spender first. */
export async function customerSalesReport(
  merchantId: Types.ObjectId,
  period: ResolvedPeriod,
  options: { sort: CustomerSort; includeWalkIn: boolean; paging: Paging },
) {
  const match: Record<string, unknown> = {
    merchantId,
    status: { $in: SOLD_STATUSES },
    orderDate: { $gte: period.start, $lt: period.end },
  };
  if (!options.includeWalkIn) match.customerId = { $ne: null };

  const grouped: PipelineStage[] = [
    { $match: match },
    { $sort: { orderDate: 1 } },
    {
      $group: {
        _id: '$customerId',
        customerName: { $last: '$customerName' },
        orderCount: { $sum: 1 },
        totalMinor: { $sum: '$totalMinor' },
        paidMinor: { $sum: '$paidMinor' },
        outstandingMinor: { $sum: { $max: [0, { $subtract: ['$totalMinor', '$paidMinor'] }] } },
        firstOrderAt: { $first: '$orderDate' },
        lastOrderAt: { $last: '$orderDate' },
      },
    },
  ];

  const sortField =
    options.sort === 'orders'
      ? 'orderCount'
      : options.sort === 'outstanding'
        ? 'outstandingMinor'
        : options.sort === 'lastOrder'
          ? 'lastOrderAt'
          : 'totalMinor';

  const [rows, totals] = await Promise.all([
    Order.aggregate<{
      _id: Types.ObjectId | null;
      customerName: string | null;
      orderCount: number;
      totalMinor: number;
      paidMinor: number;
      outstandingMinor: number;
      firstOrderAt: Date;
      lastOrderAt: Date;
      customer: Array<{ phoneE164?: string }>;
    }>([
      ...grouped,
      { $sort: { [sortField]: -1, totalMinor: -1, _id: 1 } },
      { $skip: options.paging.skip },
      { $limit: options.paging.limit },
      {
        $lookup: {
          from: Customer.collection.name,
          localField: '_id',
          foreignField: '_id',
          as: 'customer',
          pipeline: [{ $project: { phoneE164: 1 } }],
        },
      },
    ]),
    Order.aggregate<{ count: number; totalMinor: number }>([
      ...grouped,
      { $group: { _id: null, count: { $sum: 1 }, totalMinor: { $sum: '$totalMinor' } } },
    ]),
  ]);

  const totalSales = totals[0]?.totalMinor ?? 0;

  return {
    period: presentPeriod(period),
    summary: { customerCount: totals[0]?.count ?? 0, totalMinor: totalSales },
    total: totals[0]?.count ?? 0,
    items: rows.map((row, index) => ({
      rank: options.paging.skip + index + 1,
      customerId: row._id ? String(row._id) : null,
      customerName: row.customerName ?? WALK_IN,
      phoneE164: row.customer[0]?.phoneE164 ?? null,
      orderCount: row.orderCount,
      totalMinor: row.totalMinor,
      averageOrderMinor: Math.round(row.totalMinor / row.orderCount),
      paidMinor: row.paidMinor,
      outstandingMinor: row.outstandingMinor,
      sharePercent: totalSales > 0 ? Math.round((row.totalMinor / totalSales) * 1000) / 10 : 0,
      firstOrderAt: row.firstOrderAt.toISOString(),
      lastOrderAt: row.lastOrderAt.toISOString(),
    })),
  };
}
