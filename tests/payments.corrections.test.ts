import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { PaymentEntry } from '../src/models/PaymentEntry';
import { recomputePaidFromEntries } from '../src/modules/payments/paymentEngine';
import { Types } from 'mongoose';
import {
  API,
  app,
  auth,
  createCustomer,
  createMaterial,
  createOrder,
  createPurchase,
  createService,
  createSupplier,
  daysFromNow,
  payOrder,
  payPurchase,
  readOrder,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

const PASSWORD = 'TestAdminPass#123';

/** A ₹100.00 order for a customer, with no payments yet. */
async function orderFixture() {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 5_000 });
  const customer = await createCustomer(token);
  const order = await createOrder(token, {
    customerId: customer.id,
    lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
  });
  expect(order.totalMinor).toBe(10_000);
  return { merchant, token, customer, order };
}

async function pay(token: string, orderId: string, amountMinor: number, extra: Record<string, unknown> = {}) {
  const response = await payOrder(token, orderId, { amountMinor, ...extra });
  expect(response.status).toBe(201);
  return response.body.data.payment as { id: string; balanceAfterMinor: number };
}

async function entriesFor(token: string, orderId: string) {
  const response = await request(app())
    .get(`${API}/payments`)
    .query({ payableType: 'order', payableId: orderId, sort: 'createdAt' })
    .set(...auth(token));
  return response.body.data.items as Array<{ id: string; amountMinor: number; balanceAfterMinor: number }>;
}

async function customerOutstanding(token: string, customerId: string): Promise<number> {
  const response = await request(app()).get(`${API}/customers/${customerId}`).set(...auth(token));
  return response.body.data.customer.outstandingMinor;
}

describe('changing a wrong payment amount', () => {
  it('lowers the amount and rebuilds the order, the balances and the customer', async () => {
    const { token, order, customer } = await orderFixture();
    const first = await pay(token, order.id, 4_000);
    await pay(token, order.id, 2_000);
    expect(await customerOutstanding(token, customer.id)).toBe(4_000);

    const response = await request(app())
      .patch(`${API}/payments/${first.id}`)
      .set(...auth(token))
      .send({ amountMinor: 1_500, reason: 'Entered 4000 by mistake' });

    expect(response.status).toBe(200);
    expect(response.body.data.payment.amountMinor).toBe(1_500);
    expect(response.body.data.payable).toEqual({
      type: 'order',
      id: order.id,
      reference: order.reference,
      totalMinor: 10_000,
      paidMinor: 3_500,
      outstandingMinor: 6_500,
      paymentStatus: 'partially_paid',
    });

    const after = await readOrder(token, order.id);
    expect(after.paidMinor).toBe(3_500);
    expect(after.paymentStatus).toBe('partially_paid');

    // Every row's "balance after" is recomputed in the order the payments were recorded.
    const entries = await entriesFor(token, order.id);
    expect(entries.map((entry) => [entry.amountMinor, entry.balanceAfterMinor])).toEqual([
      [1_500, 8_500],
      [2_000, 6_500],
    ]);
    expect(await recomputePaidFromEntries('order', new Types.ObjectId(order.id))).toBe(3_500);
    expect(await customerOutstanding(token, customer.id)).toBe(6_500);
  });

  it('raises the amount up to what is still owed, and marks the order paid', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 6_000);

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ amountMinor: 10_000 });

    expect(response.status).toBe(200);
    expect((await readOrder(token, order.id)).paymentStatus).toBe('fully_paid');
  });

  it('refuses an amount that would take the order past its total', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 6_000);
    await pay(token, order.id, 1_000);

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ amountMinor: 9_500 });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.maxAmountMinor).toBe(9_000);
    expect((await readOrder(token, order.id)).paidMinor).toBe(7_000);
  });

  it('refuses a zero amount and still refuses a method change', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 1_000);

    for (const body of [{ amountMinor: 0 }, { method: 'upi' }]) {
      const response = await request(app())
        .patch(`${API}/payments/${payment.id}`)
        .set(...auth(token))
        .send(body);
      expect(response.status).toBe(422);
    }
  });

  it('replays an instalment plan after the change', async () => {
    const { token, order } = await orderFixture();
    const plan = await request(app())
      .post(`${API}/orders/${order.id}/installments/even`)
      .set(...auth(token))
      .send({ count: 2, firstDueDate: daysFromNow(7), everyDays: 30 });
    expect(plan.status).toBe(200);

    const payment = await pay(token, order.id, 7_000);
    let current = await readOrder(token, order.id);
    expect(current.installments.map((entry) => [entry.paidMinor, entry.status])).toEqual([
      [5_000, 'paid'],
      [2_000, 'partially_paid'],
    ]);

    await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ amountMinor: 3_000 })
      .expect(200);

    current = await readOrder(token, order.id);
    expect(current.installments.map((entry) => [entry.paidMinor, entry.status])).toEqual([
      [3_000, 'partially_paid'],
      [0, 'pending'],
    ]);
  });

  it('records the old and new amounts with the reason in the order activity', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 4_000);

    await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(token))
      .send({ amountMinor: 3_000, reason: 'Wrong amount' })
      .expect(200);

    const activity = await request(app()).get(`${API}/orders/${order.id}/activity`).set(...auth(token));
    const entry = activity.body.data.activity.find(
      (row: { action: string }) => row.action === 'payment.corrected',
    );
    expect(entry.summary).toContain('from INR 40.00 to INR 30.00');
    expect(entry.summary).toContain('Reason: Wrong amount');
    expect(entry.changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'amountMinor', from: 4_000, to: 3_000 })]),
    );
  });

  it("never touches another merchant's payment", async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 1_000);
    const other = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/payments/${payment.id}`)
      .set(...auth(other.accessToken))
      .send({ amountMinor: 500 });

    expect(response.status).toBe(404);
  });
});

describe('deleting a payment recorded by mistake', () => {
  it('removes it and rebuilds the order from the payments that remain', async () => {
    const { token, order, customer } = await orderFixture();
    const duplicate = await pay(token, order.id, 3_000);
    await pay(token, order.id, 3_000);

    const response = await request(app())
      .delete(`${API}/payments/${duplicate.id}`)
      .set(...auth(token))
      .send({ reason: 'Recorded twice' });

    expect(response.status).toBe(200);
    expect(response.body.data.deleted).toBe(true);
    expect(response.body.data.payable).toMatchObject({ paidMinor: 3_000, outstandingMinor: 7_000 });
    expect(await PaymentEntry.countDocuments({ _id: duplicate.id })).toBe(0);

    const entries = await entriesFor(token, order.id);
    expect(entries.map((entry) => [entry.amountMinor, entry.balanceAfterMinor])).toEqual([[3_000, 7_000]]);
    expect(await customerOutstanding(token, customer.id)).toBe(7_000);
  });

  it('puts a fully paid order back to unpaid when its only payment goes', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 10_000);

    await request(app()).delete(`${API}/payments/${payment.id}`).set(...auth(token)).expect(200);

    const after = await readOrder(token, order.id);
    expect(after.paidMinor).toBe(0);
    expect(after.paymentStatus).toBe('unpaid');
  });

  it('accepts the reason in the query and keeps a full copy in the audit trail', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 2_500, { reference: 'UPI-123' });

    await request(app())
      .delete(`${API}/payments/${payment.id}`)
      .query({ reason: 'Wrong order' })
      .set(...auth(token))
      .expect(200);

    const audit = await AuditLog.findOne({ action: 'payment.deleted' });
    expect(audit?.summary).toContain('Reason: Wrong order');
    expect(audit?.metadata).toMatchObject({
      reason: 'Wrong order',
      payment: { id: payment.id, amountMinor: 2_500, reference: 'UPI-123' },
    });
  });

  it('returns 404 for a payment that is already gone', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 1_000);
    await request(app()).delete(`${API}/payments/${payment.id}`).set(...auth(token)).expect(200);

    const again = await request(app()).delete(`${API}/payments/${payment.id}`).set(...auth(token));
    expect(again.status).toBe(404);
  });
});

describe('purchase payments', () => {
  async function purchaseFixture() {
    const merchant = await registerMerchant();
    const token = merchant.accessToken;
    const supplier = await createSupplier(token);
    const material = await createMaterial(token, { unit: 'kilogram' });
    const purchase = await createPurchase(token, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'material', subjectId: material.id, quantity: 10, unitCostMinor: 1_000 }],
    });
    return { token, supplier, purchase };
  }

  async function supplierOutstanding(token: string, supplierId: string): Promise<number> {
    const response = await request(app()).get(`${API}/suppliers/${supplierId}`).set(...auth(token));
    return response.body.data.supplier.outstandingMinor;
  }

  it('corrects and deletes a purchase payment, keeping the supplier in step', async () => {
    const { token, supplier, purchase } = await purchaseFixture();
    const recorded = await payPurchase(token, purchase.id, { amountMinor: 8_000 });
    expect(recorded.status).toBe(201);
    const paymentId = recorded.body.data.payment.id as string;

    const corrected = await request(app())
      .patch(`${API}/payments/${paymentId}`)
      .set(...auth(token))
      .send({ amountMinor: 5_000 });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.payable).toMatchObject({ type: 'purchase', paidMinor: 5_000, outstandingMinor: 5_000 });
    expect(await supplierOutstanding(token, supplier.id)).toBe(5_000);

    await request(app()).delete(`${API}/payments/${paymentId}`).set(...auth(token)).expect(200);
    expect(await supplierOutstanding(token, supplier.id)).toBe(10_000);
  });
});

describe('admin payment corrections', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('lets support change an amount and delete a payment, marked as admin', async () => {
    const { token, order } = await orderFixture();
    const admin = await signInAdmin();
    const first = await pay(token, order.id, 4_000);
    const second = await pay(token, order.id, 1_000);

    const corrected = await request(app())
      .patch(`${API}/admin/payments/${first.id}`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 2_000, reason: 'Merchant called in' });
    expect(corrected.status).toBe(200);
    expect(corrected.body.data.payable.paidMinor).toBe(3_000);

    const deleted = await request(app())
      .delete(`${API}/admin/payments/${second.id}`)
      .set(...auth(admin.accessToken));
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.payable.paidMinor).toBe(2_000);
    expect((await readOrder(token, order.id)).paidMinor).toBe(2_000);

    const audit = await AuditLog.find({ action: { $in: ['payment.corrected', 'payment.deleted'] } });
    expect(audit.map((row) => row.actorType)).toEqual(['admin', 'admin']);
  });

  it('requires the payment.manage permission', async () => {
    const { token, order } = await orderFixture();
    const payment = await pay(token, order.id, 1_000);
    const readOnly = await signInAdmin('readonly@sellersdash.local', PASSWORD);

    const patch = await request(app())
      .patch(`${API}/admin/payments/${payment.id}`)
      .set(...auth(readOnly.accessToken))
      .send({ amountMinor: 500 });
    const remove = await request(app())
      .delete(`${API}/admin/payments/${payment.id}`)
      .set(...auth(readOnly.accessToken));

    expect(patch.status).toBe(403);
    expect(remove.status).toBe(403);
    expect((await readOrder(token, order.id)).paidMinor).toBe(1_000);
  });
});
