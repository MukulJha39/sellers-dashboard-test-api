import { body } from 'express-validator';
import { GENDERS } from '../../models/Merchant';

/** Letters (any script), marks, spaces and the punctuation that occurs in real names. */
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;

export const otpRequestRules = [
  body('countryCode')
    .exists({ values: 'falsy' })
    .withMessage('Select your country code.')
    .bail()
    .isString()
    .withMessage('Select your country code.')
    .bail()
    .trim()
    .isLength({ min: 1, max: 6 })
    .withMessage('Select a valid country code.'),
  body('phone')
    .exists({ values: 'falsy' })
    .withMessage('Enter your phone number.')
    .bail()
    .isString()
    .withMessage('Enter your phone number.')
    .bail()
    .trim()
    .isLength({ min: 4, max: 20 })
    .withMessage('Enter a valid phone number.'),
];

export const otpVerifyRules = [
  body('otpId').isMongoId().withMessage('Request a new verification code.'),
  body('code')
    .exists({ values: 'falsy' })
    .withMessage('Enter the code we sent you.')
    .bail()
    .isString()
    .withMessage('Enter the code we sent you.')
    .bail()
    .trim()
    .matches(/^\d{4,8}$/)
    .withMessage('Enter the numeric code we sent you.'),
];

export const registerRules = [
  body('registrationToken')
    .exists({ values: 'falsy' })
    .withMessage('Verify your phone number again to continue.')
    .bail()
    .isString()
    .withMessage('Verify your phone number again to continue.'),
  body('firstName')
    .exists({ values: 'falsy' })
    .withMessage('First name is required.')
    .bail()
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
    .exists({ values: 'falsy' })
    .withMessage('Last name is required.')
    .bail()
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
    .exists({ values: 'falsy' })
    .withMessage('Gender is required.')
    .bail()
    .isIn(GENDERS)
    .withMessage('Select one of the available options.'),
  body('locale').optional({ values: 'falsy' }).isString().trim().isLength({ min: 2, max: 10 }),
  // Phone number is taken from the verification token and must never come from the body.
  body(['phone', 'countryCode', 'phoneE164'])
    .not()
    .exists()
    .withMessage('The verified phone number cannot be supplied or changed here.'),
];

export const refreshRules = [
  body('refreshToken')
    .exists({ values: 'falsy' })
    .withMessage('Sign in to continue.')
    .bail()
    .isString()
    .withMessage('Sign in to continue.'),
];
