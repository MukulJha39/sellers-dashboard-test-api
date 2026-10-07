import type { NextFunction, Request, Response } from 'express';
import { body } from 'express-validator';
import { GENDERS, THEME_MODES } from '../../models/Merchant';
import { AppError, ErrorCode } from '../../utils/AppError';

const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;

const IMMUTABLE_KEYS = ['phone', 'countryCode', 'phoneE164', 'phoneVerifiedAt'] as const;

/**
 * The verified phone number is the merchant's identity anchor and can never change
 * (PRD section 4). An attempt to send it is refused with its own error code so the
 * client can show an accurate message instead of a generic validation failure.
 */
export function rejectPhoneMutation(req: Request, _res: Response, next: NextFunction): void {
  const attempted = IMMUTABLE_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(req.body ?? {}, key));
  if (attempted.length > 0) {
    next(
      new AppError(409, ErrorCode.PHONE_IMMUTABLE, 'A verified phone number cannot be changed.', {
        details: attempted.map((field) => ({
          field,
          message: 'This value is fixed once your phone number is verified.',
        })),
      }),
    );
    return;
  }
  next();
}

export const profileUpdateRules = [
  body('firstName')
    .optional({ values: 'undefined' })
    .isString()
    .withMessage('First name is required.')
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
    .withMessage('Last name is required.')
    .bail()
    .trim()
    .isLength({ min: 1, max: 60 })
    .withMessage('Last name must be 1 to 60 characters.')
    .bail()
    .matches(NAME_PATTERN)
    .withMessage('Last name contains characters that are not allowed.'),
  body('gender')
    .optional({ values: 'undefined' })
    .isIn(GENDERS)
    .withMessage('Select one of the available options.'),
  body('locale')
    .optional({ values: 'undefined' })
    .isString()
    .bail()
    .trim()
    .isLength({ min: 2, max: 10 })
    .withMessage('Select a supported language.'),
  body('themeMode')
    .optional({ values: 'undefined' })
    .isIn(THEME_MODES)
    .withMessage('Select a supported appearance option.'),
  body().custom((value: Record<string, unknown>) => {
    const editable = ['firstName', 'lastName', 'gender', 'locale', 'themeMode'];
    const provided = editable.filter((key) => value?.[key] !== undefined);
    if (provided.length === 0) throw new Error('Change at least one detail before saving.');
    return true;
  }),
];
