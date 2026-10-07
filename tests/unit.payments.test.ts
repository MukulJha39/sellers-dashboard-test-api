import {
  derivePaymentState,
  derivePaymentStatus,
  outstandingMinor,
  overdueFilter,
} from '../src/modules/payments/paymentEngine';

/**
 * The payment engine's arithmetic and state derivation, tested without a database.
 *
 * These are the rules every payable depends on, so they are checked here in isolation
 * rather than only through the endpoints that happen to exercise them.
 */
describe('payment status derivation', () => {
  it('reports nothing paid as unpaid', () => {
    expect(derivePaymentStatus(10_000, 0)).toBe('unpaid');
  });

  it('reports a part payment as partially paid', () => {
    expect(derivePaymentStatus(10_000, 1)).toBe('partially_paid');
    expect(derivePaymentStatus(10_000, 9_999)).toBe('partially_paid');
  });

  it('reports the exact amount as fully paid', () => {
    expect(derivePaymentStatus(10_000, 10_000)).toBe('fully_paid');
  });

  it('treats an overpayment as fully paid rather than as a new state', () => {
    // The engine refuses overpayments, so this only matters as a safety net against
    // historical data; it must not read as "partially paid".
    expect(derivePaymentStatus(10_000, 12_000)).toBe('fully_paid');
  });

  it('treats a zero-total payable as fully paid', () => {
    // A purchase recorded at no cost — a free sample — is not owed for.
    expect(derivePaymentStatus(0, 0)).toBe('fully_paid');
  });
});

describe('outstanding amounts', () => {
  it('is the difference between the total and what was paid', () => {
    expect(outstandingMinor(10_000, 4_000)).toBe(6_000);
  });

  it('never goes below zero', () => {
    expect(outstandingMinor(10_000, 12_000)).toBe(0);
  });
});

describe('displayed payment state', () => {
  const past = new Date('2026-01-01T00:00:00.000Z');
  const future = new Date('2030-01-01T00:00:00.000Z');
  const now = new Date('2026-06-01T00:00:00.000Z');

  it('passes the stored status through when there is no due date', () => {
    expect(derivePaymentState({ paymentStatus: 'unpaid', dueDate: null, now })).toBe('unpaid');
    expect(derivePaymentState({ paymentStatus: 'partially_paid', dueDate: null, now })).toBe(
      'partially_paid',
    );
  });

  it('reports a past due date on an unsettled payable as overdue', () => {
    expect(derivePaymentState({ paymentStatus: 'unpaid', dueDate: past, now })).toBe('overdue');
    expect(derivePaymentState({ paymentStatus: 'partially_paid', dueDate: past, now })).toBe(
      'overdue',
    );
  });

  it('never calls a fully paid payable overdue, however late it was paid', () => {
    expect(derivePaymentState({ paymentStatus: 'fully_paid', dueDate: past, now })).toBe(
      'fully_paid',
    );
  });

  it('does not call a future due date overdue', () => {
    expect(derivePaymentState({ paymentStatus: 'unpaid', dueDate: future, now })).toBe('unpaid');
  });

  it('is computed from the clock, so the same row changes state as time passes', () => {
    const dueDate = new Date('2026-06-15T00:00:00.000Z');
    const before = new Date('2026-06-14T00:00:00.000Z');
    const after = new Date('2026-06-16T00:00:00.000Z');

    expect(derivePaymentState({ paymentStatus: 'unpaid', dueDate, now: before })).toBe('unpaid');
    expect(derivePaymentState({ paymentStatus: 'unpaid', dueDate, now: after })).toBe('overdue');
  });
});

describe('the overdue query', () => {
  it('matches unsettled payables with a due date in the past', () => {
    const now = new Date('2026-06-01T00:00:00.000Z');
    const filter = overdueFilter(now);

    expect(filter).toEqual({
      paymentStatus: { $ne: 'fully_paid' },
      dueDate: { $ne: null, $lt: now },
    });
  });
});
