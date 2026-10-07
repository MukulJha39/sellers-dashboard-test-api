import { AppError } from './AppError';

/**
 * Money convention for the whole product.
 *
 * Every monetary value is an integer in the currency's smallest unit — paise for INR,
 * cents for USD — and every such field is named with a `Minor` suffix. Nothing stores
 * money as a floating point number, so no rounding drift can accumulate across
 * purchases, orders and payments (PRD section 33).
 */
export const MAX_MONEY_MINOR = 1_000_000_000_000; // ten billion rupees, in paise

export function isValidMoneyMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MONEY_MINOR;
}

/** Validates a monetary amount coming from a request body. */
export function requireMoneyMinor(value: unknown, field: string): number {
  if (!isValidMoneyMinor(value)) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field, message: 'Enter an amount as a whole number of paise, for example 15000 for ₹150.' },
    ]);
  }
  return value;
}

/** Multiplies an amount by a quantity held in thousandths, rounding half away from zero. */
export function multiplyMoneyByQuantity(amountMinor: number, quantityThousandths: number): number {
  const product = amountMinor * quantityThousandths;
  // Round half away from zero rather than relying on Math.round's half-up bias, so a
  // refund and a charge of the same size always agree.
  const rounded = product >= 0
    ? Math.floor(product / 1000 + 0.5)
    : -Math.floor(-product / 1000 + 0.5);
  return rounded;
}

/** Applies a percentage (such as a tax rate) to an amount. */
export function applyPercent(amountMinor: number, percent: number): number {
  const product = amountMinor * percent;
  return Math.floor(product / 100 + 0.5);
}

/** Formats for logs and audit summaries only; clients format for their own locale. */
export function describeMoneyMinor(amountMinor: number, currency = 'INR'): string {
  const major = Math.floor(amountMinor / 100);
  const minor = Math.abs(amountMinor % 100);
  return `${currency} ${major}.${String(minor).padStart(2, '0')}`;
}
