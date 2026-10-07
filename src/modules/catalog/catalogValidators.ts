import type { NextFunction, Request, Response } from 'express';
import { PAYMENT_METHODS } from '../../config/commerce';
import { body, param, query, type ValidationChain } from 'express-validator';
import {
  BILLING_UNITS,
  BUSINESS_CATEGORIES,
  CATEGORY_KINDS,
  CURRENCIES,
  STOCK_ADJUSTMENT_REASONS,
  STOCK_MOVEMENT_TYPES,
  STOCK_SUBJECT_TYPES,
  UNITS,
} from '../../config/catalog';
import { AppError, ErrorCode } from '../../utils/AppError';
import { MAX_MONEY_MINOR } from '../../utils/money';
import { isValidQuantity, MAX_QUANTITY } from '../../utils/quantity';

const NAME_MESSAGE = 'Enter a name of 1 to 120 characters.';

/** A monetary field: a whole number of the currency's smallest unit. */
function moneyField(field: string, { optional = true } = {}): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'null' }) : body(field);
  return chain
    .isInt({ min: 0, max: MAX_MONEY_MINOR })
    .withMessage('Enter an amount as a whole number of paise, for example 15000 for ₹150.')
    .toInt();
}

/** A quantity field: a number with at most three decimal places. */
function quantityField(
  field: string,
  { optional = true, allowNegative = false } = {},
): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'null' }) : body(field);
  return chain
    .isFloat({ min: allowNegative ? -MAX_QUANTITY : 0, max: MAX_QUANTITY })
    .withMessage('Enter a quantity with up to three decimal places.')
    .bail()
    .toFloat()
    .custom((value: number) => {
      if (!isValidQuantity(value, { allowNegative })) {
        throw new Error('Enter a quantity with up to three decimal places.');
      }
      return true;
    });
}

function nameField(field = 'name', { optional = false } = {}): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'undefined' }) : body(field);
  return chain
    .isString()
    .withMessage(NAME_MESSAGE)
    .bail()
    .trim()
    .isLength({ min: 1, max: 120 })
    .withMessage(NAME_MESSAGE);
}

function optionalTextField(field: string, max: number): ValidationChain {
  return body(field)
    .optional({ values: 'null' })
    .isString()
    .bail()
    .trim()
    .isLength({ max })
    .withMessage(`Use ${max} characters or fewer.`);
}

/* ------------------------------ shared guards ------------------------------ */

const STOCK_WRITE_KEYS = [
  'quantity',
  'quantityThousandths',
  'totalReceived',
  'totalReceivedThousandths',
  'isLowStock',
] as const;

/**
 * Refuses any attempt to set a stock quantity through a details update.
 *
 * Stock moves only through the ledger endpoints, which is what guarantees that every
 * quantity can be explained (PRD section 6.3). Rejected with its own code so the
 * client can say something accurate rather than showing a generic validation error.
 */
export function rejectDirectStockWrite(req: Request, _res: Response, next: NextFunction): void {
  const attempted = STOCK_WRITE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(req.body ?? {}, key),
  );

  if (attempted.length > 0) {
    next(
      new AppError(409, ErrorCode.CONFLICT, 'Stock can only be changed through a stock adjustment.', {
        details: attempted.map((field) => ({
          field,
          message: 'Record a stock adjustment instead, so the change has a reason and a history.',
        })),
      }),
    );
    return;
  }

  next();
}

/* ---------------------------------- lists ---------------------------------- */

const paginationRules: ValidationChain[] = [
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Page must be a positive number.'),
  query('limit')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100.'),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  query('categoryId').optional({ values: 'falsy' }).isMongoId().withMessage('That category was not found.'),
  query('archived').optional({ values: 'falsy' }).isBoolean().withMessage('Archived must be true or false.').toBoolean(),
];

export const itemListRules: ValidationChain[] = [
  ...paginationRules,
  query('lowStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('outOfStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
];

export const serviceListRules: ValidationChain[] = [
  ...paginationRules,
  query('isActive').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('billingUnit').optional({ values: 'falsy' }).isIn(BILLING_UNITS).withMessage('Choose a valid billing unit.'),
];

export const materialListRules: ValidationChain[] = [
  ...paginationRules,
  query('lowStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('outOfStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('expiringWithinDays')
    .optional({ values: 'falsy' })
    .isInt({ min: 0, max: 365 })
    .withMessage('Enter a number of days between 0 and 365.')
    .toInt(),
];

/* ---------------------------------- items ---------------------------------- */

export const itemIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That item was not found.'),
];

const itemFieldRules = (optional: boolean): ValidationChain[] => [
  nameField('name', { optional }),
  body('categoryId').optional({ values: 'null' }).isMongoId().withMessage('Choose a category from your list.'),
  optionalTextField('description', 1000),
  optionalTextField('sku', 60),
  optionalTextField('barcode', 60),
  body('unit').optional({ values: 'falsy' }).isIn(UNITS).withMessage('Choose a unit of measurement.'),
  body('trackStock').optional({ values: 'null' }).isBoolean().withMessage('Track stock must be true or false.').toBoolean(),
  moneyField('sellingPriceMinor'),
  moneyField('costPriceMinor'),
  quantityField('lowStockThreshold'),
  body('taxRatePercent')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 100 })
    .withMessage('Enter a tax rate between 0 and 100.')
    .toFloat(),
];

export const itemCreateRules: ValidationChain[] = [
  ...itemFieldRules(false),
  // Only a create may state an opening quantity; after that, stock moves via the ledger.
  quantityField('openingQuantity'),
];

export const itemUpdateRules: ValidationChain[] = [...itemIdRules, ...itemFieldRules(true)];

/* --------------------------------- services -------------------------------- */

export const serviceIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That service was not found.'),
];

const serviceFieldRules = (optional: boolean): ValidationChain[] => [
  nameField('name', { optional }),
  body('categoryId').optional({ values: 'null' }).isMongoId().withMessage('Choose a category from your list.'),
  optionalTextField('description', 1000),
  body('billingUnit').optional({ values: 'falsy' }).isIn(BILLING_UNITS).withMessage('Choose how this service is billed.'),
  moneyField('rateMinor'),
  body('durationMinutes')
    .optional({ values: 'null' })
    .isInt({ min: 1, max: 60 * 24 * 30 })
    .withMessage('Enter a duration in minutes.')
    .toInt(),
  body('taxRatePercent')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 100 })
    .withMessage('Enter a tax rate between 0 and 100.')
    .toFloat(),
  body('isActive').optional({ values: 'null' }).isBoolean().toBoolean(),
  // Stated explicitly: a service has no stock, so these are never accepted.
  body(['quantity', 'unit', 'lowStockThreshold', 'trackStock'])
    .not()
    .exists()
    .withMessage('Services do not carry stock.'),
];

export const serviceCreateRules: ValidationChain[] = serviceFieldRules(false);
export const serviceUpdateRules: ValidationChain[] = [...serviceIdRules, ...serviceFieldRules(true)];

/* -------------------------------- materials -------------------------------- */

export const materialIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That material was not found.'),
];

const materialFieldRules = (optional: boolean): ValidationChain[] => [
  nameField('name', { optional }),
  body('categoryId').optional({ values: 'null' }).isMongoId().withMessage('Choose a category from your list.'),
  optionalTextField('notes', 1000),
  body('unit').optional({ values: 'falsy' }).isIn(UNITS).withMessage('Choose a unit of measurement.'),
  body('trackStock').optional({ values: 'null' }).isBoolean().toBoolean(),
  moneyField('purchaseCostMinor'),
  quantityField('lowStockThreshold'),
  optionalTextField('batchReference', 60),
  optionalTextField('supplierName', 120),
  body('expiryDate')
    .optional({ values: 'null' })
    .isISO8601()
    .withMessage('Enter a valid date.')
    .toDate(),
];

export const materialCreateRules: ValidationChain[] = [
  ...materialFieldRules(false),
  quantityField('openingQuantity'),
];

export const materialUpdateRules: ValidationChain[] = [
  ...materialIdRules,
  ...materialFieldRules(true),
];

/* -------------------------------- categories ------------------------------- */

export const categoryIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That category was not found.'),
];

export const categoryListRules: ValidationChain[] = [
  query('kind').optional({ values: 'falsy' }).isIn(CATEGORY_KINDS).withMessage('Choose items, services or materials.'),
  query('includeArchived').optional({ values: 'falsy' }).isBoolean().toBoolean(),
];

export const categoryCreateRules: ValidationChain[] = [
  body('kind').isIn(CATEGORY_KINDS).withMessage('Choose items, services or materials.'),
  body('name')
    .isString()
    .withMessage('Enter a category name.')
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('Enter a category name of 1 to 60 characters.'),
];

export const categoryRenameRules: ValidationChain[] = [
  ...categoryIdRules,
  body('name')
    .isString()
    .withMessage('Enter a category name.')
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('Enter a category name of 1 to 60 characters.'),
];

/* ---------------------------------- stock ---------------------------------- */

export const stockSubjectRules: ValidationChain[] = [
  param('subjectType').isIn(STOCK_SUBJECT_TYPES).withMessage('That record was not found.'),
  param('subjectId').isMongoId().withMessage('That record was not found.'),
];

export const stockAdjustRules: ValidationChain[] = [
  ...stockSubjectRules,
  // A signed change: negative removes stock.
  quantityField('change', { optional: false, allowNegative: true }),
  body('reason')
    .isIn(STOCK_ADJUSTMENT_REASONS)
    .withMessage('Choose a reason so the change has a record.'),
  optionalTextField('note', 300),
];

export const stockSetRules: ValidationChain[] = [
  ...stockSubjectRules,
  quantityField('quantity', { optional: false }),
  body('reason')
    .optional({ values: 'falsy' })
    .isIn(STOCK_ADJUSTMENT_REASONS)
    .withMessage('Choose a reason so the change has a record.'),
  optionalTextField('note', 300),
];

export const stockHistoryRules: ValidationChain[] = [
  query('subjectType').optional({ values: 'falsy' }).isIn(STOCK_SUBJECT_TYPES),
  query('subjectId').optional({ values: 'falsy' }).isMongoId().withMessage('That record was not found.'),
  query('type').optional({ values: 'falsy' }).isIn(STOCK_MOVEMENT_TYPES),
  query('reason').optional({ values: 'falsy' }).isIn(STOCK_ADJUSTMENT_REASONS),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* --------------------------------- business -------------------------------- */

export const businessUpdateRules: ValidationChain[] = [
  body('name').optional({ values: 'null' }).isString().bail().trim().isLength({ max: 120 }),
  body('category')
    .optional({ values: 'null' })
    .isIn(BUSINESS_CATEGORIES)
    .withMessage('Choose a business category from the list.'),
  optionalTextField('taxNumber', 40),
  optionalTextField('addressLine1', 160),
  optionalTextField('addressLine2', 160),
  optionalTextField('city', 80),
  optionalTextField('state', 80),
  optionalTextField('postalCode', 20),
  optionalTextField('country', 80),
  body('contactEmail')
    .optional({ values: 'null' })
    .isEmail()
    .withMessage('Enter a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  optionalTextField('contactCountryCode', 6),
  optionalTextField('contactPhone', 20),
  body('website')
    .optional({ values: 'null' })
    .isString()
    .bail()
    .trim()
    .isLength({ max: 200 })
    .bail()
    .matches(/^https?:\/\/.+/i)
    .withMessage('Enter a web address starting with http:// or https://'),
  body('currency').optional({ values: 'falsy' }).isIn(CURRENCIES).withMessage('Choose a supported currency.'),
  body('invoiceShowLogo').optional({ values: 'null' }).isBoolean().toBoolean(),
  body('invoiceShowAddress').optional({ values: 'null' }).isBoolean().toBoolean(),
  body('invoiceShowTaxNumber').optional({ values: 'null' }).isBoolean().toBoolean(),
  optionalTextField('invoiceFooterNote', 300),
  body('defaultPaymentTermsDays')
    .optional({ values: 'null' })
    .isInt({ min: 0, max: 365 })
    .withMessage('Enter a number of days between 0 and 365.')
    .toInt(),
  body('lowStockAlertsEnabled').optional({ values: 'null' }).isBoolean().toBoolean(),

  // Order and payment preferences. The method list is checked against the server's own,
  // because a stored method the engine has never heard of could not be rendered or reported
  // on; an empty array is allowed and means "all of them".
  body('enabledPaymentMethods').optional({ values: 'null' }).isArray({ max: 20 }),
  body('enabledPaymentMethods.*')
    .isIn(PAYMENT_METHODS)
    .withMessage('Choose payment methods the system understands.'),
  body('defaultOrderStatus')
    .optional({ values: 'null' })
    .isIn(['draft', 'confirmed'])
    .withMessage('A new order can start as a draft or as confirmed.'),
  body('defaultTaxPercent')
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 100 })
    .withMessage('Enter a percentage between 0 and 100.')
    .toFloat(),
];
