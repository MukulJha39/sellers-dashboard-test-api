import { AppError } from './AppError';

/**
 * Quantity convention for the whole product.
 *
 * Quantities can be fractional — 1.5 kg, 0.25 litre — so they are stored as integers
 * in thousandths of the unit. Ledger arithmetic is then exact integer addition, which
 * is what lets a derived stock balance be trusted after thousands of movements
 * (PRD section 6.3).
 *
 * The API speaks in decimal quantities; conversion happens at the boundary.
 */
export const QUANTITY_SCALE = 1000;
export const QUANTITY_DECIMALS = 3;

/** Largest quantity we accept, to keep a typo from creating absurd stock. */
export const MAX_QUANTITY = 1_000_000;

export function toThousandths(quantity: number): number {
  // Add a tiny epsilon before truncating so values such as 0.07 * 1000 = 69.999...
  // land on 70 rather than 69.
  return Math.round(quantity * QUANTITY_SCALE + Number.EPSILON * QUANTITY_SCALE);
}

export function fromThousandths(thousandths: number): number {
  return Number((thousandths / QUANTITY_SCALE).toFixed(QUANTITY_DECIMALS));
}

export function isValidQuantity(value: unknown, { allowNegative = false } = {}): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  if (!allowNegative && value < 0) return false;
  if (Math.abs(value) > MAX_QUANTITY) return false;

  // At most three decimal places, so nothing is silently rounded away.
  const scaled = value * QUANTITY_SCALE;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Validates a quantity from a request body and returns it in thousandths. */
export function requireQuantityThousandths(
  value: unknown,
  field: string,
  { allowNegative = false, allowZero = true } = {},
): number {
  if (!isValidQuantity(value, { allowNegative })) {
    throw AppError.validation('Please correct the highlighted fields.', [
      {
        field,
        message: allowNegative
          ? 'Enter a quantity with up to three decimal places.'
          : 'Enter a quantity of zero or more, with up to three decimal places.',
      },
    ]);
  }

  if (!allowZero && value === 0) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field, message: 'Enter a quantity other than zero.' },
    ]);
  }

  return toThousandths(value);
}

/** Formats a quantity for audit summaries. */
export function describeQuantity(thousandths: number): string {
  const quantity = fromThousandths(thousandths);
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(QUANTITY_DECIMALS).replace(/0+$/, '');
}
