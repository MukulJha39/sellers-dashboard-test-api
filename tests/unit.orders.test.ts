import { canTransition, holdsStock, ORDER_STATUSES, ORDER_TRANSITIONS } from '../src/config/orders';
import {
  assertPlanMatchesTotal,
  computeTotals,
  splitIntoInstallments,
} from '../src/modules/orders/orderTotals';
import { AppError } from '../src/utils/AppError';
import { toThousandths } from '../src/utils/quantity';

/**
 * The order arithmetic and the lifecycle map, tested without a database.
 *
 * These are the two things every order screen depends on, and the two that are cheapest
 * to get wrong in a way no integration test would notice: a total that is a paisa out and
 * a transition that should have been refused.
 */

function line(quantity: number, unitRateMinor: number) {
  return { quantityThousandths: toThousandths(quantity), unitRateMinor };
}

describe('order totals', () => {
  it('sums the lines into a subtotal', () => {
    const totals = computeTotals({
      lines: [line(2, 4500), line(1, 5000)],
      discountType: 'none',
    });

    expect(totals.lineTotalsMinor).toEqual([9000, 5000]);
    expect(totals.subtotalMinor).toBe(14000);
    expect(totals.discountMinor).toBe(0);
    expect(totals.taxMinor).toBe(0);
    expect(totals.totalMinor).toBe(14000);
  });

  it('prices a fractional quantity without losing a paisa', () => {
    const totals = computeTotals({ lines: [line(2.5, 5500)], discountType: 'none' });

    expect(totals.subtotalMinor).toBe(13750);
    expect(totals.totalMinor).toBe(13750);
  });

  it('applies tax after the discount, not before', () => {
    const totals = computeTotals({
      lines: [line(1, 100000)],
      discountType: 'percent',
      discountPercent: 10,
      taxPercent: 18,
    });

    expect(totals.discountMinor).toBe(10000);
    // Tax is charged on what was actually billed: 90,000 rather than 100,000.
    expect(totals.taxableMinor).toBe(90000);
    expect(totals.taxMinor).toBe(16200);
    expect(totals.totalMinor).toBe(106200);
  });

  it('keeps a flat discount exactly as entered', () => {
    const totals = computeTotals({
      lines: [line(3, 4000)],
      discountType: 'amount',
      discountMinor: 1500,
      taxPercent: 5,
    });

    expect(totals.subtotalMinor).toBe(12000);
    expect(totals.discountMinor).toBe(1500);
    expect(totals.taxMinor).toBe(525);
    expect(totals.totalMinor).toBe(11025);
  });

  it('ignores a percentage when the discount is a flat amount', () => {
    const totals = computeTotals({
      lines: [line(1, 10000)],
      discountType: 'amount',
      discountMinor: 2000,
      discountPercent: 50,
    });

    expect(totals.discountMinor).toBe(2000);
  });

  it('refuses a discount larger than the order rather than capping it', () => {
    expect(() =>
      computeTotals({ lines: [line(1, 5000)], discountType: 'amount', discountMinor: 50000 }),
    ).toThrow(AppError);

    try {
      computeTotals({ lines: [line(1, 5000)], discountType: 'amount', discountMinor: 50000 });
      throw new Error('expected the discount to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(422);
      expect((error as AppError).details?.[0]?.field).toBe('discountMinor');
    }
  });

  it('names the percentage field when a percentage discount overshoots', () => {
    try {
      computeTotals({ lines: [line(1, 5000)], discountType: 'percent', discountPercent: 150 });
      throw new Error('expected the discount to be refused');
    } catch (error) {
      expect((error as AppError).details?.[0]?.field).toBe('discountPercent');
    }
  });

  it('allows a discount of exactly the order total', () => {
    const totals = computeTotals({
      lines: [line(1, 5000)],
      discountType: 'amount',
      discountMinor: 5000,
      taxPercent: 18,
    });

    expect(totals.totalMinor).toBe(0);
    expect(totals.taxMinor).toBe(0);
  });
});

describe('installment splitting', () => {
  it('splits evenly when the total divides', () => {
    expect(splitIntoInstallments(30000, 3)).toEqual([10000, 10000, 10000]);
  });

  it('puts the remainder on the first instalment, so the last one is the round number', () => {
    const amounts = splitIntoInstallments(100000, 3);

    expect(amounts).toEqual([33334, 33333, 33333]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(100000);
  });

  it('always sums back to the total', () => {
    for (const total of [1, 7, 99, 10001, 123457]) {
      for (const count of [1, 2, 3, 7, 12]) {
        if (total < count) continue;
        const amounts = splitIntoInstallments(total, count);
        expect(amounts.reduce((sum, amount) => sum + amount, 0)).toBe(total);
        expect(amounts).toHaveLength(count);
        expect(amounts.every((amount) => amount > 0)).toBe(true);
      }
    }
  });

  it('refuses more instalments than there is money to split', () => {
    expect(() => splitIntoInstallments(200, 300)).toThrow(AppError);
  });

  it('refuses a plan with no instalments', () => {
    expect(() => splitIntoInstallments(10000, 0)).toThrow(AppError);
  });
});

describe('plan validation', () => {
  it('accepts a plan that adds up', () => {
    expect(() => assertPlanMatchesTotal([5000, 5000], 10000)).not.toThrow();
  });

  it('refuses a plan that is short, and says so', () => {
    try {
      assertPlanMatchesTotal([5000, 4000], 10000);
      throw new Error('expected the plan to be refused');
    } catch (error) {
      expect((error as AppError).details?.[0]?.message).toContain('less than');
    }
  });

  it('refuses a plan that overshoots, and says so', () => {
    try {
      assertPlanMatchesTotal([6000, 5000], 10000);
      throw new Error('expected the plan to be refused');
    } catch (error) {
      expect((error as AppError).details?.[0]?.message).toContain('more than');
    }
  });
});

describe('the order lifecycle map', () => {
  it('lists a next status for every status, terminal ones included', () => {
    for (const status of ORDER_STATUSES) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('never allows a status to transition to itself', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, status)).toBe(false);
    }
  });

  it('lets nothing follow a cancellation or a return', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition('cancelled', status)).toBe(false);
      expect(canTransition('returned', status)).toBe(false);
    }
  });

  it('only allows a return from a completed order', () => {
    const canReturn = ORDER_STATUSES.filter((status) => canTransition(status, 'returned'));
    expect(canReturn).toEqual(['completed']);
  });

  it('never lets an order go backwards into a draft', () => {
    for (const status of ORDER_STATUSES) {
      expect(canTransition(status, 'draft')).toBe(false);
    }
  });

  it('holds stock from confirmation until the order is closed', () => {
    expect(holdsStock('draft')).toBe(false);
    expect(holdsStock('confirmed')).toBe(true);
    expect(holdsStock('in_progress')).toBe(true);
    expect(holdsStock('ready')).toBe(true);
    expect(holdsStock('completed')).toBe(true);
    expect(holdsStock('cancelled')).toBe(false);
    expect(holdsStock('returned')).toBe(false);
  });

  it('names only real statuses as reachable', () => {
    for (const status of ORDER_STATUSES) {
      for (const next of ORDER_TRANSITIONS[status]) {
        expect(ORDER_STATUSES).toContain(next);
      }
    }
  });
});
