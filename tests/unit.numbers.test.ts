import { AppError } from '../src/utils/AppError';
import {
  applyPercent,
  describeMoneyMinor,
  isValidMoneyMinor,
  multiplyMoneyByQuantity,
  requireMoneyMinor,
} from '../src/utils/money';
import {
  describeQuantity,
  fromThousandths,
  isValidQuantity,
  requireQuantityThousandths,
  toThousandths,
} from '../src/utils/quantity';
import { computeIsLowStock } from '../src/models/stockFields';
import { isWholeNumberUnit } from '../src/config/catalog';

describe('money is held in whole minor units', () => {
  it('accepts whole amounts and rejects fractions', () => {
    expect(isValidMoneyMinor(0)).toBe(true);
    expect(isValidMoneyMinor(4500)).toBe(true);
    expect(isValidMoneyMinor(45.5)).toBe(false);
    expect(isValidMoneyMinor(-100)).toBe(false);
    expect(isValidMoneyMinor('4500')).toBe(false);
  });

  it('rejects an absurd amount, so a typo cannot create one', () => {
    expect(isValidMoneyMinor(10 ** 15)).toBe(false);
  });

  it('reports the offending field when validating a request value', () => {
    expect(() => requireMoneyMinor(12.5, 'sellingPriceMinor')).toThrow(AppError);
    try {
      requireMoneyMinor(12.5, 'sellingPriceMinor');
    } catch (error) {
      expect((error as AppError).details?.[0]?.field).toBe('sellingPriceMinor');
    }
    expect(requireMoneyMinor(1250, 'sellingPriceMinor')).toBe(1250);
  });

  it('multiplies by a fractional quantity without drifting', () => {
    // ₹45.00 for 2.5 kg is ₹112.50.
    expect(multiplyMoneyByQuantity(4500, toThousandths(2.5))).toBe(11250);
    // A third of a unit rounds to the nearest paisa rather than accumulating error.
    expect(multiplyMoneyByQuantity(100, toThousandths(0.333))).toBe(33);
    expect(multiplyMoneyByQuantity(0, toThousandths(5))).toBe(0);
  });

  it('rounds half away from zero, so a charge and a refund agree', () => {
    expect(multiplyMoneyByQuantity(5, toThousandths(0.1))).toBe(1);
    expect(multiplyMoneyByQuantity(-5, toThousandths(0.1))).toBe(-1);
  });

  it('applies a percentage to a whole-unit amount', () => {
    expect(applyPercent(10000, 18)).toBe(1800);
    expect(applyPercent(4500, 5)).toBe(225);
    expect(applyPercent(333, 18)).toBe(60);
  });

  it('describes an amount for logs and audit summaries', () => {
    expect(describeMoneyMinor(4500)).toBe('INR 45.00');
    expect(describeMoneyMinor(4505)).toBe('INR 45.05');
    expect(describeMoneyMinor(100000, 'USD')).toBe('USD 1000.00');
  });
});

describe('quantities are held in thousandths', () => {
  it('converts both ways without losing precision', () => {
    expect(toThousandths(1)).toBe(1000);
    expect(toThousandths(12.5)).toBe(12500);
    expect(toThousandths(0.001)).toBe(1);
    expect(toThousandths(0.07)).toBe(70);

    expect(fromThousandths(12500)).toBe(12.5);
    expect(fromThousandths(1)).toBe(0.001);
    expect(fromThousandths(0)).toBe(0);
  });

  it('survives a round trip for values that trouble floating point', () => {
    for (const value of [0.07, 0.29, 1.005, 2.675, 999.999, 0.1 + 0.2]) {
      expect(fromThousandths(toThousandths(value))).toBeCloseTo(value, 3);
    }
  });

  it('accepts at most three decimal places', () => {
    expect(isValidQuantity(1.5)).toBe(true);
    expect(isValidQuantity(1.005)).toBe(true);
    expect(isValidQuantity(1.0005)).toBe(false);
    expect(isValidQuantity(-1)).toBe(false);
    expect(isValidQuantity(-1, { allowNegative: true })).toBe(true);
    expect(isValidQuantity(Number.NaN)).toBe(false);
    expect(isValidQuantity(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidQuantity('5')).toBe(false);
  });

  it('rejects an absurd quantity', () => {
    expect(isValidQuantity(10 ** 9)).toBe(false);
  });

  it('reports the offending field, and can require a non-zero value', () => {
    expect(requireQuantityThousandths(2.5, 'quantity')).toBe(2500);

    try {
      requireQuantityThousandths(0, 'quantity', { allowZero: false });
      throw new Error('expected a validation error');
    } catch (error) {
      expect((error as AppError).details?.[0]?.field).toBe('quantity');
    }

    expect(() => requireQuantityThousandths(1.00005, 'quantity')).toThrow(AppError);
  });

  it('describes a quantity for audit summaries', () => {
    expect(describeQuantity(2000)).toBe('2');
    expect(describeQuantity(2500)).toBe('2.5');
    expect(describeQuantity(0)).toBe('0');
  });
});

describe('units', () => {
  it('knows which units only make sense as whole numbers', () => {
    expect(isWholeNumberUnit('piece')).toBe(true);
    expect(isWholeNumberUnit('bottle')).toBe(true);
    expect(isWholeNumberUnit('kilogram')).toBe(false);
    expect(isWholeNumberUnit('litre')).toBe(false);
    expect(isWholeNumberUnit('unknown')).toBe(false);
  });
});

describe('the low-stock flag', () => {
  it('is true at or below the threshold', () => {
    const base = { trackStock: true, lowStockThresholdThousandths: 5000 };
    expect(computeIsLowStock({ ...base, quantityThousandths: 6000 })).toBe(false);
    expect(computeIsLowStock({ ...base, quantityThousandths: 5000 })).toBe(true);
    expect(computeIsLowStock({ ...base, quantityThousandths: 0 })).toBe(true);
  });

  it('treats an empty record with no threshold as needing attention', () => {
    expect(
      computeIsLowStock({
        trackStock: true,
        quantityThousandths: 0,
        lowStockThresholdThousandths: 0,
      }),
    ).toBe(true);
  });

  it('is never true when stock is not tracked', () => {
    expect(
      computeIsLowStock({
        trackStock: false,
        quantityThousandths: 0,
        lowStockThresholdThousandths: 100,
      }),
    ).toBe(false);
  });
});
