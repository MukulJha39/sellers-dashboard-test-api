import { body, param, query, type ValidationChain } from 'express-validator';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../../config/commerce';
import {
  DISCOUNT_TYPES,
  MAX_INSTALLMENTS,
  MAX_ORDER_LINES,
  ORDER_LINE_TYPES,
  ORDER_STATUSES,
} from '../../config/orders';
import { MAX_MONEY_MINOR } from '../../utils/money';
import { isValidQuantity, MAX_QUANTITY } from '../../utils/quantity';

/** Validation for the order, installment and receivables endpoints. */

function moneyField(field: string, { optional = true } = {}): ValidationChain {
  const chain = optional ? body(field).optional({ values: 'null' }) : body(field);
  return chain
    .isInt({ min: 0, max: MAX_MONEY_MINOR })
    .withMessage('Enter an amount as a whole number of paise, for example 15000 for ₹150.')
    .toInt();
}

function quantityField(field: string): ValidationChain {
  return body(field)
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

function percentField(field: string): ValidationChain {
  return body(field)
    .optional({ values: 'null' })
    .isFloat({ min: 0, max: 100 })
    .withMessage('Enter a percentage between 0 and 100.')
    .toFloat();
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
  return body(field).optional({ values: 'null' }).isISO8601().withMessage('Enter a valid date.');
}

export const orderIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That order was not found.'),
];

const orderFieldRules: ValidationChain[] = [
  // Null is meaningful here: it is how a client records an anonymous counter sale.
  body('customerId').optional({ values: 'null' }).isMongoId().withMessage('That customer was not found.'),
  body('discountType').optional({ values: 'null' }).isIn(DISCOUNT_TYPES),
  moneyField('discountMinor'),
  percentField('discountPercent'),
  percentField('taxPercent'),
  optionalDateField('orderDate'),
  optionalDateField('dueDate'),
  optionalTextField('notes', 2000),
];

const lineRules: ValidationChain[] = [
  body('lines.*.lineType').isIn(ORDER_LINE_TYPES).withMessage('Choose an item or a service.'),
  body('lines.*.subjectId').isMongoId().withMessage('That record was not found.'),
  quantityField('lines.*.quantity'),
  moneyField('lines.*.unitRateMinor'),
  body('lines.*.durationMinutes')
    .optional({ values: 'null' })
    .isInt({ min: 0, max: 100000 })
    .withMessage('Enter a whole number of minutes.')
    .toInt(),
];

export const orderCreateRules: ValidationChain[] = [
  body('lines')
    .isArray({ min: 1, max: MAX_ORDER_LINES })
    .withMessage('Add at least one item or service.'),
  ...lineRules,
  body('status')
    .optional({ values: 'null' })
    .isIn(ORDER_STATUSES)
    .withMessage('Choose a valid order status.'),
  ...orderFieldRules,
];

export const orderUpdateRules: ValidationChain[] = [
  ...orderIdRules,
  body('lines')
    .optional({ values: 'null' })
    .isArray({ min: 1, max: MAX_ORDER_LINES })
    .withMessage('An order needs at least one line.'),
  ...lineRules.map((chain) => chain.optional({ values: 'null' })),
  ...orderFieldRules,
];

export const orderTransitionRules: ValidationChain[] = [
  ...orderIdRules,
  body('status').isIn(ORDER_STATUSES).withMessage('Choose a valid order status.'),
  optionalTextField('reason', 300),
];

export const orderListRules: ValidationChain[] = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('customerId').optional({ values: 'falsy' }).isMongoId(),
  query('subjectId').optional({ values: 'falsy' }).isMongoId(),
  query('status').optional({ values: 'falsy' }).isIn(ORDER_STATUSES),
  query('paymentStatus').optional({ values: 'falsy' }).isIn(PAYMENT_STATUSES),
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('open').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('from').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('to').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

export const orderPaymentRules: ValidationChain[] = [
  ...orderIdRules,
  moneyField('amountMinor', { optional: false }),
  body('method').isIn(PAYMENT_METHODS).withMessage('Choose how the payment was made.'),
  optionalTextField('reference', 80),
  optionalDateField('paidAt'),
  optionalTextField('notes', 500),
  body('installmentNumber')
    .optional({ values: 'null' })
    .isInt({ min: 1, max: MAX_INSTALLMENTS })
    .withMessage('Choose an instalment on this plan.')
    .toInt(),
];

export const installmentPlanRules: ValidationChain[] = [
  ...orderIdRules,
  body('installments')
    .isArray({ min: 1, max: MAX_INSTALLMENTS })
    .withMessage('Add at least one instalment.'),
  body('installments.*.amountMinor')
    .isInt({ min: 1, max: MAX_MONEY_MINOR })
    .withMessage('Enter an amount as a whole number of paise.')
    .toInt(),
  body('installments.*.dueDate').isISO8601().withMessage('Enter when this instalment is due.'),
  body('installments.*.notes').optional({ values: 'null' }).isString().trim().isLength({ max: 300 }),
];

export const evenPlanRules: ValidationChain[] = [
  ...orderIdRules,
  body('count')
    .isInt({ min: 1, max: MAX_INSTALLMENTS })
    .withMessage(`Enter between 1 and ${MAX_INSTALLMENTS} instalments.`)
    .toInt(),
  body('firstDueDate').isISO8601().withMessage('Enter when the first instalment is due.'),
  body('everyDays')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 365 })
    .withMessage('Enter how many days apart the instalments are.')
    .toInt(),
];

export const receivablesListRules: ValidationChain[] = [
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

export const installmentListRules: ValidationChain[] = [
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('withinDays').optional({ values: 'falsy' }).isInt({ min: 1, max: 365 }).toInt(),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).toInt(),
];
