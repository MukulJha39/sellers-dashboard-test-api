import { body, param, query, type ValidationChain } from 'express-validator';
import { STOCK_SUBJECT_TYPES } from '../../config/catalog';
import {
  CONTACT_CHANNELS,
  CONTACT_LANGUAGES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PURCHASE_STATUSES,
} from '../../config/commerce';
import { GENDERS } from '../../models/Merchant';
import { MAX_MONEY_MINOR } from '../../utils/money';
import { isValidQuantity, MAX_QUANTITY } from '../../utils/quantity';

/**
 * Validation for the Phase 3 endpoints.
 *
 * Deliberately a separate file from the catalog's rules rather than an import of its
 * private helpers: the two sets will keep diverging, and a shared private helper that
 * both must agree on is a worse coupling than two short local ones.
 */

function moneyField(field: string, { optional = true } = {}): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'null' }) : body(field);
  return chain
    .isInt({ min: 0, max: MAX_MONEY_MINOR })
    .withMessage('Enter an amount as a whole number of paise, for example 15000 for ₹150.')
    .toInt();
}

function quantityField(field: string, { optional = false } = {}): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'null' }) : body(field);
  return chain
    .isFloat({ min: 0, max: MAX_QUANTITY })
    .withMessage('Enter a quantity with up to three decimal places.')
    .bail()
    .toFloat()
    .custom((value: number) => {
      if (!isValidQuantity(value)) {
        throw new Error('Enter a quantity with up to three decimal places.');
      }
      return true;
    });
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

function optionalDateField(field: string): ValidationChain {
  return body(field)
    .optional({ values: 'null' })
    .isISO8601()
    .withMessage('Enter a valid date.');
}

/* -------------------------------- customers ------------------------------- */

export const customerIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That customer was not found.'),
];

const customerFieldRules = (optional: boolean): ValidationChain[] => [
  (optional ? body('countryCode').optional({ values: 'falsy' }) : body('countryCode'))
    .isString()
    .bail()
    .trim()
    .matches(/^\+?\d{1,4}$/)
    .withMessage('Choose a country code.'),
  (optional ? body('phone').optional({ values: 'falsy' }) : body('phone'))
    .isString()
    .bail()
    .trim()
    .isLength({ min: 4, max: 20 })
    .withMessage('Enter the phone number without the country code.'),
  (optional ? body('firstName').optional({ values: 'undefined' }) : body('firstName'))
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('First name is required.'),
  (optional ? body('lastName').optional({ values: 'undefined' }) : body('lastName'))
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('Last name is required.'),
  (optional ? body('gender').optional({ values: 'undefined' }) : body('gender'))
    .isIn(GENDERS)
    .withMessage('Select an option to continue.'),

  body('email')
    .optional({ values: 'null' })
    .isEmail()
    .withMessage('Enter a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  optionalTextField('addressLine1', 160),
  optionalTextField('addressLine2', 160),
  optionalTextField('city', 80),
  optionalTextField('state', 80),
  optionalTextField('postalCode', 20),
  optionalTextField('country', 80),
  optionalTextField('notes', 2000),
  optionalTextField('companyName', 160),
  optionalDateField('dateOfBirth'),
  body('tags')
    .optional({ values: 'null' })
    .isArray({ max: 20 })
    .withMessage('Use up to 20 tags.')
    .bail()
    .custom((tags: unknown[]) => {
      if (tags.some((tag) => typeof tag !== 'string' || tag.length > 40)) {
        throw new Error('Each tag must be text of 40 characters or fewer.');
      }
      return true;
    }),
  body('preferredChannel')
    .optional({ values: 'null' })
    .isIn(CONTACT_CHANNELS)
    .withMessage('Choose how this customer prefers to be contacted.'),
  body('language')
    .optional({ values: 'null' })
    .isIn(CONTACT_LANGUAGES)
    .withMessage('Choose a language.'),
];

export const customerCreateRules: ValidationChain[] = customerFieldRules(false);
export const customerUpdateRules: ValidationChain[] = [
  ...customerIdRules,
  ...customerFieldRules(true),
];

export const customerListRules: ValidationChain[] = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('tag').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
  query('archived').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('outstanding').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* -------------------------------- suppliers ------------------------------- */

export const supplierIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That supplier was not found.'),
];

const supplierFieldRules = (optional: boolean): ValidationChain[] => [
  (optional ? body('name').optional({ values: 'undefined' }) : body('name'))
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 160 })
    .withMessage('Enter a supplier name.'),
  optionalTextField('contactPerson', 120),
  body('countryCode')
    .optional({ values: 'null' })
    .isString()
    .bail()
    .trim()
    .matches(/^\+?\d{1,4}$/)
    .withMessage('Choose a country code.'),
  optionalTextField('phone', 20),
  body('email')
    .optional({ values: 'null' })
    .isEmail()
    .withMessage('Enter a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  optionalTextField('addressLine1', 160),
  optionalTextField('city', 80),
  optionalTextField('state', 80),
  optionalTextField('postalCode', 20),
  optionalTextField('country', 80),
  optionalTextField('taxNumber', 40),
  optionalTextField('notes', 2000),
];

export const supplierCreateRules: ValidationChain[] = supplierFieldRules(false);
export const supplierUpdateRules: ValidationChain[] = [
  ...supplierIdRules,
  ...supplierFieldRules(true),
];

export const supplierListRules: ValidationChain[] = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('archived').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('outstanding').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* -------------------------------- purchases ------------------------------- */

export const purchaseIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That purchase was not found.'),
];

export const purchaseCreateRules: ValidationChain[] = [
  body('supplierId').isMongoId().withMessage('Choose a supplier.'),
  body('lines')
    .isArray({ min: 1, max: 100 })
    .withMessage('Add at least one material or item.'),
  body('lines.*.subjectType')
    .isIn(STOCK_SUBJECT_TYPES)
    .withMessage('Choose an item or a raw material.'),
  body('lines.*.subjectId').isMongoId().withMessage('That record was not found.'),
  quantityField('lines.*.quantity'),
  moneyField('lines.*.unitCostMinor', { optional: false }),
  moneyField('additionalCostMinor'),
  optionalDateField('purchaseDate'),
  optionalDateField('dueDate'),
  optionalTextField('notes', 2000),
  body('receiveStock').optional({ values: 'null' }).isBoolean().toBoolean(),
];

export const purchaseUpdateRules: ValidationChain[] = [
  ...purchaseIdRules,
  optionalDateField('purchaseDate'),
  optionalDateField('dueDate'),
  optionalTextField('notes', 2000),
];

export const purchaseCancelRules: ValidationChain[] = [
  ...purchaseIdRules,
  optionalTextField('reason', 300),
];

export const purchaseListRules: ValidationChain[] = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('supplierId').optional({ values: 'falsy' }).isMongoId(),
  query('subjectId').optional({ values: 'falsy' }).isMongoId(),
  query('status').optional({ values: 'falsy' }).isIn(PURCHASE_STATUSES),
  query('paymentStatus').optional({ values: 'falsy' }).isIn(PAYMENT_STATUSES),
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('received').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('from').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('to').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* --------------------------------- payments -------------------------------- */

export const paymentCreateRules: ValidationChain[] = [
  ...purchaseIdRules,
  moneyField('amountMinor', { optional: false }),
  body('method').isIn(PAYMENT_METHODS).withMessage('Choose how the payment was made.'),
  optionalTextField('reference', 80),
  optionalDateField('paidAt'),
  optionalTextField('notes', 500),
];

/**
 * Correcting a payment entry's description.
 *
 * The amount and the method are refused rather than ignored: a client that sends one has
 * misunderstood something, and silently dropping it would let them believe the correction
 * was applied. A wrong amount is corrected by a further entry.
 */
export const paymentAnnotateRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That payment was not found.'),
  body('amountMinor')
    .not()
    .exists()
    .withMessage('A payment amount cannot be changed. Record a further payment instead.'),
  body('method')
    .not()
    .exists()
    .withMessage('A payment method cannot be changed once the entry is written.'),
  body('reference').optional({ values: 'null' }).isString().bail().trim().isLength({ max: 80 }),
  body('paidAt').optional({ values: 'null' }).isISO8601().withMessage('Enter a valid date.'),
  body('notes').optional({ values: 'null' }).isString().bail().trim().isLength({ max: 500 }),
];

export const paymentListRules: ValidationChain[] = [
  query('payableType').optional({ values: 'falsy' }).isIn(['purchase', 'order']),
  query('payableId').optional({ values: 'falsy' }).isMongoId(),
  query('method').optional({ values: 'falsy' }).isIn(PAYMENT_METHODS),
  query('direction').optional({ values: 'falsy' }).isIn(['in', 'out']),
  query('installmentNumber').optional({ values: 'falsy' }).isInt({ min: 1 }).toInt(),
  query('from').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('to').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];
