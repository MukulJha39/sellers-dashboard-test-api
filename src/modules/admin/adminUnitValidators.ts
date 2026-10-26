import { body, param, type ValidationChain } from 'express-validator';
import { UNIT_APPLIES_TO, UNIT_CODE_PATTERN, UNIT_GROUP_VALUES, UNIT_ICON_PATTERN } from '../../config/catalog';

export const unitIdRules: ValidationChain[] = [
  param('id').isMongoId().withMessage('That unit was not found.'),
];

const unitFieldRules = (optional: boolean): ValidationChain[] => {
  const field = (name: string) => (optional ? body(name).optional({ values: 'undefined' }) : body(name));
  return [
    field('name')
      .isString()
      .trim()
      .isLength({ min: 1, max: 40 })
      .withMessage('Enter a name of 1 to 40 characters.'),
    field('symbol')
      .isString()
      .trim()
      .isLength({ min: 1, max: 12 })
      .withMessage('Enter a short label of 1 to 12 characters, for example "kg" or "pieces".'),
    body('icon')
      .optional({ values: 'falsy' })
      .isString()
      .trim()
      .matches(UNIT_ICON_PATTERN)
      .withMessage('Use a Material icon name, for example "scale" or "water_drop".'),
    body('group')
      .optional({ values: 'null' })
      .isIn(UNIT_GROUP_VALUES)
      .withMessage('Choose which section this unit appears under.'),
    body('wholeNumbersOnly')
      .optional({ values: 'null' })
      .isBoolean()
      .withMessage('Whole numbers only must be true or false.')
      .toBoolean(),
    body('appliesTo')
      .optional({ values: 'null' })
      .isArray({ min: 1 })
      .withMessage('Choose whether this unit is for items, raw materials or both.')
      .bail()
      .custom((values: unknown[]) => values.every((value) => (UNIT_APPLIES_TO as readonly unknown[]).includes(value)))
      .withMessage('Choose whether this unit is for items, raw materials or both.'),
    body('isActive').optional({ values: 'null' }).isBoolean().withMessage('Active must be true or false.').toBoolean(),
    body('sortOrder')
      .optional({ values: 'null' })
      .isInt({ min: 0, max: 100_000 })
      .withMessage('Enter a display order as a whole number.')
      .toInt(),
  ];
};

export const unitCreateRules: ValidationChain[] = [
  body('code')
    .isString()
    .trim()
    .toLowerCase()
    .matches(UNIT_CODE_PATTERN)
    .withMessage('Use lowercase letters, numbers and underscores, starting with a letter (for example "square_metre").'),
  ...unitFieldRules(false),
];

export const unitUpdateRules: ValidationChain[] = [
  ...unitIdRules,
  // Records store the code, so it can never change after creation.
  body('code').not().exists().withMessage('A unit code cannot be changed once created.'),
  ...unitFieldRules(true),
];
