import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { Customer } from '../src/models/Customer';
import { recomputePaidFromEntries } from '../src/modules/payments/paymentEngine';
import { Types } from 'mongoose';
import {
  API,
  app,
  auth,
  createCustomer,
  createOrder,
  createService,
  readOrder,
  registerMerchant,
  transitionOrder,
} from './helpers';

/** A ₹100.00 order, for a customer unless told otherwise, with no payments yet. */
async function orderFixture(options: { withCustomer?: boolean } = {}) {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 5_000 });
  const customer = await createCustomer(token);
  const order = await createOrder(token, {
    customerId: options.withCustomer === false ? null : customer.id,
    lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
  });
  expect(order.totalMinor).toBe(10_000);
  return { token, customer, order };
}

function postPayment(token: string, orderId: string, body: Record<string, unknown>) {
  return request(app())
    .post(`${API}/orders/${orderId}/payments`)
    .set(...auth(token))
    .send({ method: 'cash', ...body });
}

function patchPayment(token: string, paymentId: string, body: Record<string, unknown>) {
  return request(app())
    .patch(`${API}/payments/${paymentId}`)
    .set(...auth(token))
    .send(body);
}

async function customerAdvance(token: string, customerId: string): Promise<number> {
  const response = await request(app()).get(`${API}/customers/${customerId}`).set(...auth(token));
  return response.body.data.customer.advanceMinor;
}

describe('keeping an overpayment as advance', () => {
  it('settles the order and credits the rest to the customer', async () => {
    const { token, customer, order } = await orderFixture();

    const response = await postPayment(token, order.id, {
      amountMinor: 12_500,
      keepExtraAsAdvance: true,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.payment).toMatchObject({
      amountMinor: 10_000,
      advanceMinor: 2_500,
      receivedMinor: 12_500,
      balanceAfterMinor: 0,
    });
    expect(response.body.data.order.paidMinor).toBe(10_000);
    expect(response.body.data.order.paymentStatus).toBe('fully_paid');
    expect(await customerAdvance(token, customer.id)).toBe(2_500);
    expect(await recomputePaidFromEntries('order', new Types.ObjectId(order.id))).toBe(10_000);

    const audits = await AuditLog.find({ action: 'customer.advance_credited' });
    expect(audits).toHaveLength(1);
    expect(String(audits[0]!.targetId)).toBe(customer.id);
    const recorded = await AuditLog.findOne({ action: 'payment.recorded', targetId: order.id });
    expect(recorded!.metadata).toMatchObject({ receivedMinor: 12_500, advanceMinor: 2_500 });
  });

  it('applies only the remaining balance when the order is partly paid', async () => {
    const { token, customer, order } = await orderFixture();
    expect((await postPayment(token, order.id, { amountMinor: 6_000 })).status).toBe(201);

    const response = await postPayment(token, order.id, {
      amountMinor: 5_000,
      keepExtraAsAdvance: true,
    });
    expect(response.status).toBe(201);
    expect(response.body.data.payment).toMatchObject({ amountMinor: 4_000, advanceMinor: 1_000 });
    expect((await readOrder(token, order.id)).paidMinor).toBe(10_000);
    expect(await customerAdvance(token, customer.id)).toBe(1_000);
  });

  it('still refuses an overpayment without the flag', async () => {
    const { token, customer, order } = await orderFixture();
    const response = await postPayment(token, order.id, { amountMinor: 12_500 });
    expect(response.status).toBe(409);
    expect(await customerAdvance(token, customer.id)).toBe(0);
  });

  it('refuses to keep an advance on an order with no customer', async () => {
    const { token, order } = await orderFixture({ withCustomer: false });
    const response = await postPayment(token, order.id, {
      amountMinor: 12_500,
      keepExtraAsAdvance: true,
    });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('no customer');
  });

  it('refuses a payment against a cancelled order even with the flag', async () => {
    const { token, order } = await orderFixture();
    expect((await transitionOrder(token, order.id, 'cancelled', 'Customer changed mind')).status).toBe(200);
    const response = await postPayment(token, order.id, {
      amountMinor: 12_500,
      keepExtraAsAdvance: true,
    });
    expect(response.status).toBe(409);
  });
});

describe('correcting a payment that kept an advance', () => {
  it('sends the extra of a raised payment to advance', async () => {
    const { token, customer, order } = await orderFixture();
    const created = await postPayment(token, order.id, { amountMinor: 8_000 });
    const paymentId = created.body.data.payment.id as string;

    // Without the flag, raising past the total is refused as before.
    expect((await patchPayment(token, paymentId, { amountMinor: 11_000 })).status).toBe(409);

    const response = await patchPayment(token, paymentId, {
      amountMinor: 11_000,
      keepExtraAsAdvance: true,
    });
    expect(response.status).toBe(200);
    expect(response.body.data.payment).toMatchObject({ amountMinor: 10_000, advanceMinor: 1_000 });
    expect(response.body.data.payable.paidMinor).toBe(10_000);
    expect(await customerAdvance(token, customer.id)).toBe(1_000);
  });

  it('takes a lowered amount out of the advance first, then the order', async () => {
    const { token, customer, order } = await orderFixture();
    const created = await postPayment(token, order.id, {
      amountMinor: 13_000,
      keepExtraAsAdvance: true,
    });
    const paymentId = created.body.data.payment.id as string;

    const lowered = await patchPayment(token, paymentId, { amountMinor: 11_000 });
    expect(lowered.status).toBe(200);
    expect(lowered.body.data.payment).toMatchObject({ amountMinor: 10_000, advanceMinor: 1_000 });
    expect(await customerAdvance(token, customer.id)).toBe(1_000);

    const further = await patchPayment(token, paymentId, { amountMinor: 7_000 });
    expect(further.status).toBe(200);
    expect(further.body.data.payment).toMatchObject({ amountMinor: 7_000, advanceMinor: 0 });
    expect(further.body.data.payable.paidMinor).toBe(7_000);
    expect(await customerAdvance(token, customer.id)).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'customer.advance_reversed' })).toBe(2);
  });

  it('removes the advance when the payment is deleted', async () => {
    const { token, customer, order } = await orderFixture();
    const created = await postPayment(token, order.id, {
      amountMinor: 12_000,
      keepExtraAsAdvance: true,
    });

    const response = await request(app())
      .delete(`${API}/payments/${created.body.data.payment.id}`)
      .set(...auth(token));
    expect(response.status).toBe(200);
    expect(response.body.data.payable.paidMinor).toBe(0);
    expect(await customerAdvance(token, customer.id)).toBe(0);
  });

  it('refuses to lower or delete when the advance was already used', async () => {
    const { token, customer, order } = await orderFixture();
    const created = await postPayment(token, order.id, {
      amountMinor: 12_000,
      keepExtraAsAdvance: true,
    });
    const paymentId = created.body.data.payment.id as string;

    // Simulates the advance having been spent elsewhere.
    await Customer.updateOne({ _id: customer.id }, { $set: { advanceMinor: 500 } });

    const lowered = await patchPayment(token, paymentId, { amountMinor: 10_000 });
    expect(lowered.status).toBe(409);
    const deleted = await request(app()).delete(`${API}/payments/${paymentId}`).set(...auth(token));
    expect(deleted.status).toBe(409);

    // Nothing moved.
    expect(await customerAdvance(token, customer.id)).toBe(500);
    expect((await readOrder(token, order.id)).paidMinor).toBe(10_000);
  });
});
