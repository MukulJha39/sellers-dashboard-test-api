import request from 'supertest';
import { PaymentEntry, type PaymentEntryDocument } from '../src/models/PaymentEntry';
import { Types } from 'mongoose';
import { recomputePaidFromEntries } from '../src/modules/payments/paymentEngine';
import {
  API,
  app,
  auth,
  createItem,
  createPurchase,
  createSupplier,
  payPurchase,
  registerMerchant,
} from './helpers';

/** A purchase for a round ₹100.00, ready to be paid against. */
async function purchaseFor(token: string, totalMinor = 10_000) {
  const supplier = await createSupplier(token);
  const item = await createItem(token, { unit: 'piece' });

  const purchase = await createPurchase(token, {
    supplierId: supplier.id,
    lines: [{ subjectType: 'item', subjectId: item.id, quantity: 1, unitCostMinor: totalMinor }],
    receiveStock: false,
  });

  return { supplier, item, purchase };
}

describe('purchase payments', () => {
  it('records one payment and reports what is left', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    const response = await payPurchase(merchant.accessToken, purchase.id, {
      amountMinor: 4_000,
      method: 'upi',
      reference: 'UPI-8842',
      notes: 'Paid from the counter phone',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.payment.amountMinor).toBe(4_000);
    expect(response.body.data.payment.method).toBe('upi');
    expect(response.body.data.payment.reference).toBe('UPI-8842');
    expect(response.body.data.payment.direction).toBe('out');
    // Readable on its own: the row says what was left after it.
    expect(response.body.data.payment.balanceAfterMinor).toBe(6_000);

    // The purchase comes back with it, so the caller need not refetch.
    expect(response.body.data.purchase.paidMinor).toBe(4_000);
    expect(response.body.data.purchase.outstandingMinor).toBe(6_000);
    expect(response.body.data.purchase.paymentStatus).toBe('partially_paid');
  });

  it('settles a purchase over three payments, exactly as the PRD describes', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    const first = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 2_000 });
    expect(first.body.data.purchase.paymentStatus).toBe('partially_paid');
    expect(first.body.data.purchase.outstandingMinor).toBe(8_000);

    const second = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 3_000 });
    expect(second.body.data.purchase.paymentStatus).toBe('partially_paid');
    expect(second.body.data.purchase.outstandingMinor).toBe(5_000);

    const third = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 5_000 });
    expect(third.body.data.purchase.paymentStatus).toBe('fully_paid');
    expect(third.body.data.purchase.outstandingMinor).toBe(0);

    // Each payment is kept separately, with its own date and amount.
    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken));

    const payments = read.body.data.payments as Array<{ amountMinor: number }>;
    expect(payments).toHaveLength(3);
    expect(payments.map((p) => p.amountMinor).sort((a, b) => a - b)).toEqual([2_000, 3_000, 5_000]);
  });

  it('keeps the stored total equal to the sum of its entries', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken, 50_000);

    for (const amount of [5_000, 12_500, 7_500, 25_000]) {
      const response = await payPurchase(merchant.accessToken, purchase.id, {
        amountMinor: amount,
      });
      expect(response.status).toBe(201);
    }

    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken));

    // The stored figure is a projection of the entries, so summing them must agree.
    const summed = await recomputePaidFromEntries('purchase', new Types.ObjectId(purchase.id));
    expect(summed).toBe(50_000);
    expect(read.body.data.purchase.paidMinor).toBe(summed);
    expect(read.body.data.purchase.paymentStatus).toBe('fully_paid');
  });

  it('refuses more than the outstanding amount, and says what it is', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);
    await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 7_000 });

    const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 5_000 });

    // Refused rather than capped: a merchant who typed an extra zero needs telling.
    expect(response.status).toBe(409);
    expect(response.body.error.meta.outstanding).toBe(3_000);
    expect(response.body.error.meta.total).toBe(10_000);
    expect(response.body.error.meta.paid).toBe(7_000);

    // And nothing was written.
    const summed = await recomputePaidFromEntries('purchase', new Types.ObjectId(purchase.id));
    expect(summed).toBe(7_000);
  });

  it('refuses a payment against a fully paid purchase', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);
    await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 10_000 });

    const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 100 });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('already fully paid');
  });

  it('refuses a zero or negative amount', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    for (const amountMinor of [0, -500]) {
      const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor });
      expect(response.status).toBe(422);
    }
  });

  it('refuses a fractional amount', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 150.5 });

    // Money is whole minor units everywhere, so a fraction is not a valid amount.
    expect(response.status).toBe(422);
  });

  it('requires a payment method from the served list', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    const missing = await request(app())
      .post(`${API}/purchases/${purchase.id}/payments`)
      .set(...auth(merchant.accessToken))
      .send({ amountMinor: 1_000 });
    expect(missing.status).toBe(422);

    const unknown = await payPurchase(merchant.accessToken, purchase.id, {
      amountMinor: 1_000,
      method: 'barter',
    });
    expect(unknown.status).toBe(422);
  });

  it('refuses a payment against a cancelled purchase', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);

    await request(app())
      .post(`${API}/purchases/${purchase.id}/cancel`)
      .set(...auth(merchant.accessToken))
      .send({ reason: 'Not needed' });

    const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 1_000 });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('cancelled');
  });

  it('refuses to modify a payment entry once written', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken);
    const response = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 1_000 });

    const { PaymentEntry } = await import('../src/models/PaymentEntry');
    const entry = await PaymentEntry.findById(response.body.data.payment.id);
    expect(entry).not.toBeNull();

    entry!.amountMinor = 9_999;
    // A payment history that can be edited is not a history.
    await expect(entry!.save()).rejects.toThrow('cannot be modified');
  });

  it('lists payments across the business, newest first', async () => {
    const merchant = await registerMerchant();
    const one = await purchaseFor(merchant.accessToken);
    const two = await purchaseFor(merchant.accessToken);

    await payPurchase(merchant.accessToken, one.purchase.id, {
      amountMinor: 1_000,
      method: 'cash',
      paidAt: '2026-05-01T00:00:00.000Z',
    });
    await payPurchase(merchant.accessToken, two.purchase.id, {
      amountMinor: 2_000,
      method: 'upi',
      paidAt: '2026-06-01T00:00:00.000Z',
    });

    const response = await request(app())
      .get(`${API}/payments`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const items = response.body.data.items as Array<{ amountMinor: number; method: string }>;
    expect(items).toHaveLength(2);
    expect(items[0]!.amountMinor).toBe(2_000);

    const byMethod = await request(app())
      .get(`${API}/payments`)
      .query({ method: 'cash' })
      .set(...auth(merchant.accessToken));
    expect(byMethod.body.data.items).toHaveLength(1);
    expect(byMethod.body.data.items[0].amountMinor).toBe(1_000);
  });

  it('filters payments by date range', async () => {
    const merchant = await registerMerchant();
    const { purchase } = await purchaseFor(merchant.accessToken, 20_000);

    await payPurchase(merchant.accessToken, purchase.id, {
      amountMinor: 5_000,
      paidAt: '2026-03-10T00:00:00.000Z',
    });
    await payPurchase(merchant.accessToken, purchase.id, {
      amountMinor: 5_000,
      paidAt: '2026-07-10T00:00:00.000Z',
    });

    const response = await request(app())
      .get(`${API}/payments`)
      .query({ from: '2026-06-01T00:00:00.000Z' })
      .set(...auth(merchant.accessToken));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].paidAt).toBe('2026-07-10T00:00:00.000Z');
  });

  it('keeps one merchant payments out of another merchant list', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const { purchase } = await purchaseFor(one.accessToken);
    await payPurchase(one.accessToken, purchase.id, { amountMinor: 1_000 });

    const response = await request(app())
      .get(`${API}/payments`)
      .set(...auth(two.accessToken));

    expect(response.body.data.items).toHaveLength(0);

    const paying = await payPurchase(two.accessToken, purchase.id, { amountMinor: 500 });
    expect(paying.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/payments`);
    expect(response.status).toBe(401);
  });
});

describe('the append-only guarantee at the model level', () => {
  /**
   * The route refuses an amount change, but the guard that matters is on the model: a
   * future caller that bypassed the route would still be stopped. Tested directly for
   * that reason.
   */
  it('refuses a changed amount even written straight to the document', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 },
      ],
    });
    const recorded = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 4_000 });
    expect(recorded.status).toBe(201);

    const entry = await PaymentEntry.findById(recorded.body.data.payment.id);
    expect(entry).not.toBeNull();

    entry!.amountMinor = 99_999;
    await expect(entry!.save()).rejects.toThrow(/cannot be modified once written/);

    // And the stored amount is still what was recorded.
    const unchanged = await PaymentEntry.findById(recorded.body.data.payment.id);
    expect(unchanged!.amountMinor).toBe(4_000);
  });

  it('refuses a changed method, payable or balance', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 },
      ],
    });
    const recorded = await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 4_000 });

    for (const mutate of [
      (doc: PaymentEntryDocument) => {
        doc.method = 'card';
      },
      (doc: PaymentEntryDocument) => {
        doc.balanceAfterMinor = 0;
      },
      (doc: PaymentEntryDocument) => {
        doc.actorLabel = 'Someone else';
      },
    ]) {
      const entry = await PaymentEntry.findById(recorded.body.data.payment.id);
      mutate(entry!);
      await expect(entry!.save()).rejects.toThrow(/cannot be modified once written/);
    }
  });

  it('allows a correction to what the entry says about itself', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'item', subjectId: item.id, quantity: 2, unitCostMinor: 5_000 },
      ],
    });
    const recorded = await payPurchase(merchant.accessToken, purchase.id, {
      amountMinor: 4_000,
      reference: 'CHQ-1',
    });

    const entry = await PaymentEntry.findById(recorded.body.data.payment.id);
    entry!.reference = 'CHQ-2';
    entry!.notes = 'Corrected';
    // Not money, so not guarded — and the amount beside it is untouched.
    await expect(entry!.save()).resolves.toBeDefined();

    const saved = await PaymentEntry.findById(recorded.body.data.payment.id);
    expect(saved!.reference).toBe('CHQ-2');
    expect(saved!.amountMinor).toBe(4_000);
  });
});
