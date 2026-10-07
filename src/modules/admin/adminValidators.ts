import { body, param, query, type ValidationChain } from 'express-validator';
import { STOCK_SUBJECT_TYPES } from '../../config/catalog';
import {
  PAYABLE_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  PURCHASE_STATUSES,
} from '../../config/commerce';
import { ORDER_STATUSES } from '../../config/orders';
import { ADMIN_STATUSES } from '../../models/Admin';
import { GENDERS, MERCHANT_STATUSES } from '../../models/Merchant';

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;

export const adminLoginRules = [
  body('email')
    .exists({ values: 'falsy' })
    .withMessage('Enter your email address.')
    .bail()
    .isEmail()
    .withMessage('Enter a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body('password')
    .exists({ values: 'falsy' })
    .withMessage('Enter your password.')
    .bail()
    .isString()
    .isLength({ min: 8, max: 128 })
    .withMessage('Enter your password.'),
];

export const merchantListRules = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  query('status').optional({ values: 'falsy' }).isIn(MERCHANT_STATUSES).withMessage('Choose a valid status filter.'),
  query('gender').optional({ values: 'falsy' }).isIn(GENDERS).withMessage('Choose a valid gender filter.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Page must be a positive number.'),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100.'),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

export const merchantIdRules = [param('id').isMongoId().withMessage('That merchant was not found.')];

export const merchantUpdateRules = [
  ...merchantIdRules,
  body('firstName')
    .optional({ values: 'undefined' })
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('First name must be 1 to 60 characters.')
    .bail()
    .matches(NAME_PATTERN)
    .withMessage('First name contains characters that are not allowed.'),
  body('lastName')
    .optional({ values: 'undefined' })
    .isString()
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('Last name must be 1 to 60 characters.')
    .bail()
    .matches(NAME_PATTERN)
    .withMessage('Last name contains characters that are not allowed.'),
  body('gender').optional({ values: 'undefined' }).isIn(GENDERS).withMessage('Select one of the available options.'),
  body().custom((value: Record<string, unknown>) => {
    const editable = ['firstName', 'lastName', 'gender'];
    if (editable.every((key) => value?.[key] === undefined)) {
      throw new Error('Change at least one detail before saving.');
    }
    return true;
  }),
];

export const merchantStatusRules = [
  ...merchantIdRules,
  body('status').isIn(MERCHANT_STATUSES).withMessage('Choose a valid status.'),
  body('reason')
    .optional({ values: 'falsy' })
    .isString()
    .bail()
    .trim()
    .isLength({ min: 3, max: 300 })
    .withMessage('Give a reason of 3 to 300 characters.'),
];

export const auditListRules = [
  query('targetType').optional({ values: 'falsy' }).isString().trim().isLength({ max: 60 }),
  query('targetId').optional({ values: 'falsy' }).isMongoId().withMessage('That record was not found.'),
  query('actorType').optional({ values: 'falsy' }).isIn(['merchant', 'admin', 'system']),
  query('actorId').optional({ values: 'falsy' }).isMongoId().withMessage('That account was not found.'),
  query('action').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* --------------------------- Phase 2: catalog rules -------------------------- */

/** For routes nested under a merchant, such as that merchant's business profile. */
export const merchantIdParamRules: ValidationChain[] = [
  param('merchantId').isMongoId().withMessage('That merchant was not found.'),
];

/** For catalog routes addressed by the record's own id. */
export const itemIdParamRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That record was not found.'),
];

export const adminCatalogListRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId().withMessage('That merchant was not found.'),
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 80 }),
  query('archived').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('lowStock').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }).withMessage('Page must be a positive number.'),
  query('limit')
    .optional({ values: 'falsy' })
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100.'),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

export const adminStockHistoryRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId().withMessage('That merchant was not found.'),
  query('subjectType').optional({ values: 'falsy' }).isIn(STOCK_SUBJECT_TYPES),
  query('subjectId').optional({ values: 'falsy' }).isMongoId().withMessage('That record was not found.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

/* ------------------------ Phase 3: relationship rules ------------------------ */

export const adminRelationshipListRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId().withMessage('That merchant was not found.'),
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('archived').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('outstanding').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

export const adminPurchaseListRules: ValidationChain[] = [
  ...adminRelationshipListRules,
  query('supplierId').optional({ values: 'falsy' }).isMongoId(),
  query('status').optional({ values: 'falsy' }).isIn(PURCHASE_STATUSES),
  query('paymentStatus').optional({ values: 'falsy' }).isIn(PAYMENT_STATUSES),
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('received').optional({ values: 'falsy' }).isBoolean().toBoolean(),
];

export const adminPaymentListRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId(),
  query('payableType').optional({ values: 'falsy' }).isIn(PAYABLE_TYPES),
  query('payableId').optional({ values: 'falsy' }).isMongoId(),
  query('method').optional({ values: 'falsy' }).isIn(PAYMENT_METHODS),
  query('from').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('to').optional({ values: 'falsy' }).isISO8601().withMessage('Enter a valid date.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

/* ------------------------------- Phase 4: orders ------------------------------- */

export const adminOrderListRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId().withMessage('That merchant was not found.'),
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('customerId').optional({ values: 'falsy' }).isMongoId(),
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

export const adminOrderStatusRules: ValidationChain[] = [
  body('status').isIn(ORDER_STATUSES).withMessage('Choose a valid order status.'),
  body('reason').optional({ values: 'null' }).isString().bail().trim().isLength({ max: 300 }),
];

export const adminReceivablesListRules: ValidationChain[] = [
  query('merchantId').optional({ values: 'falsy' }).isMongoId(),
  query('overdue').optional({ values: 'falsy' }).isBoolean().toBoolean(),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
];

export const adminInstallmentListRules: ValidationChain[] = [
  ...adminReceivablesListRules,
  query('withinDays').optional({ values: 'falsy' }).isInt({ min: 1, max: 365 }).toInt(),
];

/* ------------------- roles, the admin team and passwords ------------------- */

/**
 * What a password has to be to be accepted here.
 *
 * Length does most of the work, so the floor is 12 rather than 8, with a mixed-character
 * rule to stop "password1234" clearing the bar. The same chain is reused for creating a
 * member, resetting someone's password and changing your own, so the three can never
 * drift apart.
 */
function passwordRule(field: string, label: string): ValidationChain {
  return body(field)
    .exists({ values: 'falsy' })
    .withMessage(`Enter ${label}.`)
    .bail()
    .isString()
    .isLength({ min: 12, max: 128 })
    .withMessage('Use at least 12 characters.')
    .bail()
    .matches(/[a-z]/)
    .withMessage('Include a lower-case letter.')
    .bail()
    .matches(/[A-Z]/)
    .withMessage('Include an upper-case letter.')
    .bail()
    .matches(/[0-9]/)
    .withMessage('Include a number.');
}

export const roleCreateRules: ValidationChain[] = [
  body('name')
    .exists({ values: 'falsy' })
    .withMessage('Enter a name for this role.')
    .bail()
    .isString()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('A role name is between 2 and 80 characters.'),
  body('description')
    .exists({ values: 'falsy' })
    .withMessage('Say what this role is for.')
    .bail()
    .isString()
    .trim()
    .isLength({ min: 2, max: 300 })
    .withMessage('A description is between 2 and 300 characters.'),
  body('permissions')
    .isArray({ min: 1 })
    .withMessage('Choose at least one permission.')
    .bail()
    .custom((values: unknown[]) => values.every((value) => typeof value === 'string'))
    .withMessage('Permissions must be a list of permission keys.'),
];

export const roleUpdateRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That role was not found.'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }),
  body('description').optional().isString().trim().isLength({ min: 2, max: 300 }),
  body('permissions')
    .optional()
    .isArray({ min: 1 })
    .withMessage('Choose at least one permission.')
    .bail()
    .custom((values: unknown[]) => values.every((value) => typeof value === 'string'))
    .withMessage('Permissions must be a list of permission keys.'),
];

export const roleIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That role was not found.'),
];

export const adminListRules: ValidationChain[] = [
  query('search').optional({ values: 'falsy' }).isString().trim().isLength({ max: 120 }),
  query('status').optional({ values: 'falsy' }).isIn(ADMIN_STATUSES).withMessage('Choose a valid status filter.'),
  query('roleId').optional({ values: 'falsy' }).isMongoId().withMessage('That role was not found.'),
  query('page').optional({ values: 'falsy' }).isInt({ min: 1 }),
  query('limit').optional({ values: 'falsy' }).isInt({ min: 1, max: 100 }),
  query('sort').optional({ values: 'falsy' }).isString().trim().isLength({ max: 40 }),
];

export const adminCreateRules: ValidationChain[] = [
  body('name')
    .exists({ values: 'falsy' })
    .withMessage('Enter their name.')
    .bail()
    .isString()
    .trim()
    .isLength({ min: 2, max: 80 })
    .bail()
    .matches(NAME_PATTERN)
    .withMessage('Enter a valid name.'),
  body('email')
    .exists({ values: 'falsy' })
    .withMessage('Enter their email address.')
    .bail()
    .isEmail()
    .withMessage('Enter a valid email address.')
    .bail()
    .normalizeEmail({ gmail_remove_dots: false }),
  body('roleId').isMongoId().withMessage('Choose a role.'),
  passwordRule('password', 'a starting password'),
];

export const adminUpdateRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That admin was not found.'),
  body('name').optional().isString().trim().isLength({ min: 2, max: 80 }).bail().matches(NAME_PATTERN).withMessage('Enter a valid name.'),
  body('email').optional().isEmail().withMessage('Enter a valid email address.').bail().normalizeEmail({ gmail_remove_dots: false }),
  body('roleId').optional().isMongoId().withMessage('Choose a role.'),
];

export const adminStatusRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That admin was not found.'),
  body('status').isIn(ADMIN_STATUSES).withMessage('Choose a valid status.'),
  body('reason').optional({ values: 'null' }).isString().bail().trim().isLength({ max: 300 }),
];

export const adminPasswordResetRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That admin was not found.'),
  passwordRule('password', 'a new password'),
];

export const ownProfileRules: ValidationChain[] = [
  body('name')
    .exists({ values: 'falsy' })
    .withMessage('Enter your name.')
    .bail()
    .isString()
    .trim()
    .isLength({ min: 2, max: 80 })
    .withMessage('A name is between 2 and 80 characters.')
    .bail()
    .matches(NAME_PATTERN)
    .withMessage('Enter a valid name.'),
];

export const changeOwnPasswordRules: ValidationChain[] = [
  body('currentPassword')
    .exists({ values: 'falsy' })
    .withMessage('Enter your current password.')
    .bail()
    .isString(),
  passwordRule('newPassword', 'a new password'),
];
