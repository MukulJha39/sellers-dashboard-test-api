import type { DiscountType } from '../../config/orders';
import { AppError } from '../../utils/AppError';
import { applyPercent, multiplyMoneyByQuantity } from '../../utils/money';

/**
 * Order arithmetic, kept pure so it can be tested without a database and reused by the
 * order service, the installment validator and the reports in Phase 5.
 *
 * Every amount is a whole number of minor units throughout. The one rule that matters:
 * a total is built once, from the resolved amounts, and stored. Nothing recomputes it
 * from a percentage at read time, because two readers rounding independently is how a
 * total starts disagreeing with the sum of its lines.
 */

export interface LineInput {
  quantityThousandths: number;
  unitRateMinor: number;
}

export interface TotalsInput {
  lines: readonly LineInput[];
  discountType: DiscountType;
  /** Used when `discountType` is `amount`. */
  discountMinor?: number;
  /** Used when `discountType` is `percent`. */
  discountPercent?: number;
  taxPercent?: number;
}

export interface Totals {
  lineTotalsMinor: number[];
  subtotalMinor: number;
  discountMinor: number;
  /** The base tax is charged on: the subtotal after any discount. */
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
}

/**
 * Prices an order.
 *
 * Tax is applied **after** the discount, on the discounted subtotal. That is the common
 * expectation and the one a merchant can check by hand: discount what you sold, then tax
 * what you charged.
 */
export function computeTotals(input: TotalsInput): Totals {
  const lineTotalsMinor = input.lines.map((line) =>
    multiplyMoneyByQuantity(line.unitRateMinor, line.quantityThousandths),
  );
  const subtotalMinor = lineTotalsMinor.reduce((total, line) => total + line, 0);

  let discountMinor = 0;
  if (input.discountType === 'amount') {
    discountMinor = input.discountMinor ?? 0;
  } else if (input.discountType === 'percent') {
    discountMinor = applyPercent(subtotalMinor, input.discountPercent ?? 0);
  }

  // A discount larger than the order is refused rather than clamped: a merchant who
  // typed 5000 instead of 500 needs telling, and a silently capped discount would make
  // the printed total disagree with what they entered.
  if (discountMinor > subtotalMinor) {
    throw AppError.validation('Please correct the highlighted fields.', [
      {
        field: input.discountType === 'percent' ? 'discountPercent' : 'discountMinor',
        message: 'The discount is more than the order total.',
      },
    ]);
  }

  const taxableMinor = subtotalMinor - discountMinor;
  const taxMinor = input.taxPercent ? applyPercent(taxableMinor, input.taxPercent) : 0;

  return {
    lineTotalsMinor,
    subtotalMinor,
    discountMinor,
    taxableMinor,
    taxMinor,
    totalMinor: taxableMinor + taxMinor,
  };
}

/**
 * Splits an amount into `count` installments that sum back to it exactly.
 *
 * The remainder goes on the **first** installment rather than the last, so the final
 * payment is never the odd one out: a merchant reading a plan expects the last amount to
 * be the round one they agreed, and ₹3,333.34 as a closing payment looks like a mistake.
 */
export function splitIntoInstallments(totalMinor: number, count: number): number[] {
  if (count < 1) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'count', message: 'Enter how many instalments the plan has.' },
    ]);
  }
  if (totalMinor < count) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'count', message: 'That is more instalments than there is money to split.' },
    ]);
  }

  const base = Math.floor(totalMinor / count);
  const remainder = totalMinor - base * count;

  return Array.from({ length: count }, (_, index) => (index === 0 ? base + remainder : base));
}

/**
 * Checks a plan against the order it belongs to.
 *
 * A plan that does not add up to the order is refused: the whole point of a schedule is
 * that paying all of it settles the order, and a plan short by a rupee leaves a balance
 * nobody can explain.
 */
export function assertPlanMatchesTotal(
  amountsMinor: readonly number[],
  orderTotalMinor: number,
): void {
  const planned = amountsMinor.reduce((total, amount) => total + amount, 0);
  if (planned === orderTotalMinor) return;

  throw AppError.validation('Please correct the highlighted fields.', [
    {
      field: 'installments',
      message:
        planned > orderTotalMinor
          ? 'The instalments add up to more than the order total.'
          : 'The instalments add up to less than the order total.',
    },
  ]);
}
