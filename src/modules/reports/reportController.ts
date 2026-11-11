import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AppError } from '../../utils/AppError';
import { parsePagination } from '../../utils/pagination';
import { buildPageMeta, sendData } from '../../utils/response';
import { resolvePeriod, type ReportPeriod } from './reportPeriod';
import {
  customerSalesReport,
  moneyInOutReport,
  moneyToCollectReport,
  notSellingReport,
  productSalesReport,
  profitLossReport,
  salesReport,
  stockReport,
  type CollectSort,
  type CustomerSort,
  type IdleSort,
  type ProductSort,
  type StockSort,
  type StockStatus,
} from './reportService';

function merchantId(req: Request): Types.ObjectId {
  if (!req.merchant) throw AppError.unauthenticated('Sign in to continue.');
  return req.merchant.objectId;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function flag(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function period(req: Request, fallback: ReportPeriod = 'this_month') {
  return resolvePeriod(
    {
      period: text(req.query.period) as ReportPeriod | undefined,
      from: text(req.query.from),
      to: text(req.query.to),
      tz: text(req.query.tz),
    },
    fallback,
  );
}

/** `-name` → { field: 'name', descending: true }; nothing → the report's default. */
function sortOf<T extends string>(req: Request, fallback: T, descendingByDefault: boolean) {
  const raw = text(req.query.sort);
  if (!raw) return { field: fallback, descending: descendingByDefault };
  return { field: raw.replace(/^-/, '') as T, descending: raw.startsWith('-') };
}

/** A paged report: the report's own fields, plus `items` and the usual `meta`. */
function sendPaged<T extends { total: number; items: unknown[] }>(
  res: Response,
  report: T,
  page: { page: number; limit: number },
) {
  const { total, ...rest } = report;
  sendData(res, { ...rest, meta: buildPageMeta(page.page, page.limit, total) });
}

export async function getSalesReport(req: Request, res: Response): Promise<void> {
  sendData(res, await salesReport(merchantId(req), period(req)));
}

export async function getProfitLossReport(req: Request, res: Response): Promise<void> {
  sendData(res, await profitLossReport(merchantId(req), period(req)));
}

export async function getMoneyInOutReport(req: Request, res: Response): Promise<void> {
  sendData(res, await moneyInOutReport(merchantId(req), period(req)));
}

export async function getMoneyToCollectReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const customerId = text(req.query.customerId);
  const view = customerId ? 'order' : ((text(req.query.view) as 'customer' | 'order' | undefined) ?? 'customer');

  const report = await moneyToCollectReport(merchantId(req), {
    view,
    customerId: customerId ? new Types.ObjectId(customerId) : null,
    overdueOnly: flag(req.query.overdue) ?? false,
    sort: (text(req.query.sort)?.replace(/^-/, '') as CollectSort | undefined) ?? 'outstanding',
    paging: page,
  });
  sendPaged(res, report, page);
}

export async function getStockReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const sort = sortOf<StockSort>(req, 'status', false);

  const report = await stockReport(merchantId(req), {
    type: (text(req.query.type) as 'item' | 'material' | 'all' | undefined) ?? 'item',
    status: text(req.query.status) as StockStatus | undefined,
    search: text(req.query.q),
    sort: sort.field,
    descending: sort.descending,
    paging: page,
  });
  sendPaged(res, report, page);
}

/** Best sellers: most sold first, goods only unless asked otherwise. */
export async function getBestSellersReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const report = await productSalesReport(merchantId(req), period(req), {
    lineType: (text(req.query.lineType) as 'item' | 'service' | 'all' | undefined) ?? 'item',
    sort: (text(req.query.sort)?.replace(/^-/, '') as ProductSort | undefined) ?? 'quantity',
    paging: page,
  });
  sendPaged(res, report, page);
}

/** By product: which product (or service) made how much, biggest earner first. */
export async function getSalesByProductReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const report = await productSalesReport(merchantId(req), period(req), {
    lineType: (text(req.query.lineType) as 'item' | 'service' | 'all' | undefined) ?? 'all',
    sort: (text(req.query.sort)?.replace(/^-/, '') as ProductSort | undefined) ?? 'revenue',
    paging: page,
  });
  sendPaged(res, report, page);
}

/** Not selling: least sold first. Defaults to the last 30 days. */
export async function getNotSellingReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const sort = sortOf<IdleSort>(req, 'sold', false);
  const report = await notSellingReport(merchantId(req), period(req, 'last_30_days'), {
    sort: sort.field,
    descending: sort.descending,
    unsoldOnly: flag(req.query.unsold) ?? false,
    inStockOnly: flag(req.query.inStock) ?? false,
    paging: page,
  });
  sendPaged(res, report, page);
}

export async function getSalesByCustomerReport(req: Request, res: Response): Promise<void> {
  const page = parsePagination(req);
  const report = await customerSalesReport(merchantId(req), period(req), {
    sort: (text(req.query.sort)?.replace(/^-/, '') as CustomerSort | undefined) ?? 'spent',
    includeWalkIn: flag(req.query.walkIn) ?? false,
    paging: page,
  });
  sendPaged(res, report, page);
}
