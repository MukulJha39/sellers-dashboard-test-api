import { query, type ValidationChain } from 'express-validator';
import { isValidTimezone, REPORT_PERIODS } from './reportPeriod';
import {
  COLLECT_SORTS,
  CUSTOMER_SORTS,
  IDLE_SORTS,
  PRODUCT_SORTS,
  STOCK_SORTS,
  STOCK_STATUSES,
} from './reportService';

/** Accepts a field as `name` or `-name`, the convention the list endpoints use. */
function sortRule(allowed: readonly string[]): ValidationChain {
  return query('sort')
    .optional({ values: 'falsy' })
    .isString()
    .custom((value: string) => allowed.includes(value.replace(/^-/, '')))
    .withMessage(`Sort by one of: ${allowed.join(', ')}.`);
}

const paging: ValidationChain[] = [
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Enter a page number.'),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).withMessage('Choose 1 to 100 rows.'),
];

/** The window a report covers. Custom ranges are checked further when they are resolved. */
const periodRules: ValidationChain[] = [
  query('period').optional({ values: 'falsy' }).isIn(REPORT_PERIODS).withMessage('Choose a period.'),
  query('from').optional({ values: 'falsy' }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Enter the date as YYYY-MM-DD.'),
  query('to').optional({ values: 'falsy' }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('Enter the date as YYYY-MM-DD.'),
  query('tz')
    .optional({ values: 'falsy' })
    .isString()
    .custom((value: string) => isValidTimezone(value))
    .withMessage('Send a time zone such as Asia/Kolkata.'),
];

export const salesReportRules = periodRules;
export const profitLossReportRules = periodRules;
export const moneyInOutReportRules = periodRules;

export const moneyToCollectRules: ValidationChain[] = [
  query('view').optional({ values: 'falsy' }).isIn(['customer', 'order']).withMessage('Choose customer or order.'),
  query('customerId').optional({ values: 'falsy' }).isMongoId().withMessage('That customer was not found.'),
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  sortRule(COLLECT_SORTS),
  ...paging,
];

export const stockReportRules: ValidationChain[] = [
  query('type').optional({ values: 'falsy' }).isIn(['item', 'material', 'all']).withMessage('Choose item, material or all.'),
  query('status').optional({ values: 'falsy' }).isIn(STOCK_STATUSES).withMessage('Choose a stock status.'),
  query('q').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  sortRule(STOCK_SORTS),
  ...paging,
];

export const productSalesRules: ValidationChain[] = [
  ...periodRules,
  query('lineType').optional({ values: 'falsy' }).isIn(['item', 'service', 'all']).withMessage('Choose item, service or all.'),
  sortRule(PRODUCT_SORTS),
  ...paging,
];

export const notSellingRules: ValidationChain[] = [
  ...periodRules,
  query('unsold').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('inStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  sortRule(IDLE_SORTS),
  ...paging,
];

export const customerSalesRules: ValidationChain[] = [
  ...periodRules,
  query('walkIn').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  sortRule(CUSTOMER_SORTS),
  ...paging,
];
