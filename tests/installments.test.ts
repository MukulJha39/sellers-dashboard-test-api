import request from 'supertest';
import {
  API,
  app,
  auth,
  createCustomer,
  createOrder,
  createService,
  daysFromNow,
  payOrder,
  readOrder,
  registerMerchant,
  setEvenPlan,
  setInstallmentPlan,
  transitionOrder,
} from './helpers';

/**
 * Order payments, instalment plans and the overdue state.
 *
 * The rules under test are the ones a merchant's money depends on: a plan must add up to
 * the order, a payment is never silently capped, and overdue is worked out from the due
 * date at read time rather than stored — so no row can be stale.
 */

/** A merchant with a service priced so the totals in these tests are round numbers. */
async function fixture() {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;

  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 10_000 });
  const customer = await createCustomer(token);

  return { merchant, token, service, customer };
}

/** An order for exactly ₹300.00, which splits evenly three ways. */
async function orderFor300(token: string, serviceId: string, customerId?: string) {
  return createOrder(token, {
    ...(customerId ? { customerId } : {}),
    lines: [{ lineType: 'service', subjectId: serviceId, quantity: 3 }],
  });
}

describe('order payments', () => {
  it('records a payment, moves the status and reports the balance', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const response = await payOrder(token, order.id, { amountMinor: 10_000, method: 'upi' });

    expect(response.status).toBe(201);
    expect(response.body.data.payment.amountMinor).toBe(10_000);
    expect(response.body.data.payment.direction).toBe('in');
    expect(response.body.data.payment.balanceAfterMinor).toBe(20_000);
    expect(response.body.data.order.paidMinor).toBe(10_000);
    expect(response.body.data.order.outstandingMinor).toBe(20_000);
    expect(response.body.data.order.paymentStatus).toBe('partially_paid');
  });

  it('settles the order when the last payment lands', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await payOrder(token, order.id, { amountMinor: 12_000 });
    await payOrder(token, order.id, { amountMinor: 8_000, method: 'card' });
    const last = await payOrder(token, order.id, { amountMinor: 10_000, method: 'bank_transfer' });

    expect(last.status).toBe(201);
    expect(last.body.data.order.paymentStatus).toBe('fully_paid');
    expect(last.body.data.order.outstandingMinor).toBe(0);

    const entries = await request(app())
      .get(`${API}/payments`)
      .query({ payableType: 'order', payableId: order.id })
      .set(...auth(token));

    expect(entries.body.data.items).toHaveLength(3);
    // Newest first, and each entry carries the balance it left behind.
    expect(entries.body.data.items.map((entry: { amountMinor: number }) => entry.amountMinor)).toEqual([
      10_000, 8_000, 12_000,
    ]);
    expect(entries.body.data.items[0].balanceAfterMinor).toBe(0);
  });

  it('refuses an overpayment rather than capping it, and says what is outstanding', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await payOrder(token, order.id, { amountMinor: 25_000 });
    const response = await payOrder(token, order.id, { amountMinor: 9_000 });

    expect(response.status).toBe(409);
    expect(response.body.error.meta).toEqual({ outstanding: 5_000, total: 30_000, paid: 25_000 });
    // Nothing was recorded, so the order is exactly where it was.
    expect((await readOrder(token, order.id)).paidMinor).toBe(25_000);
  });

  it('refuses a second payment once the order is settled', async () => {
    const { token, service } = await fixture();
    const order = await orderFor300(token, service.id);

    await payOrder(token, order.id, { amountMinor: 30_000 });
    const response = await payOrder(token, order.id, { amountMinor: 100 });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('already fully paid');
  });

  it('refuses a payment against a cancelled order', async () => {
    const { token, service } = await fixture();
    const order = await orderFor300(token, service.id);
    await transitionOrder(token, order.id, 'cancelled');

    const response = await payOrder(token, order.id, { amountMinor: 5_000 });
    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('cancelled');
  });

  it('refuses a payment of zero or less', async () => {
    const { token, service } = await fixture();
    const order = await orderFor300(token, service.id);

    for (const amountMinor of [0, -500]) {
      const response = await payOrder(token, order.id, { amountMinor });
      expect(response.status).toBe(422);
    }
  });

  it("keeps a customer's outstanding balance in step with their orders", async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const owing = await request(app())
      .get(`${API}/customers/${customer.id}`)
      .set(...auth(token));
    expect(owing.body.data.customer.outstandingMinor).toBe(30_000);
    expect(owing.body.data.customer.orderCount).toBe(1);

    await payOrder(token, order.id, { amountMinor: 30_000 });

    const settled = await request(app())
      .get(`${API}/customers/${customer.id}`)
      .set(...auth(token));
    expect(settled.body.data.customer.outstandingMinor).toBe(0);
  });

  it('takes a cancelled order out of what the customer owes', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await transitionOrder(token, order.id, 'cancelled');

    const response = await request(app())
      .get(`${API}/customers/${customer.id}`)
      .set(...auth(token));

    expect(response.body.data.customer.outstandingMinor).toBe(0);
  });
});

describe('instalment plans', () => {
  it('builds an even plan whose amounts add back to the order total', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const response = await setEvenPlan(token, order.id, {
      count: 3,
      firstDueDate: daysFromNow(7),
      everyDays: 30,
    });

    expect(response.status).toBe(200);
    const plan = response.body.data.order.installments;
    expect(plan).toHaveLength(3);
    expect(plan.map((entry: { amountMinor: number }) => entry.amountMinor)).toEqual([
      10_000, 10_000, 10_000,
    ]);
    expect(plan[0].number).toBe(1);
    expect(plan.every((entry: { status: string }) => entry.status === 'pending')).toBe(true);
    // The order's due date follows the last instalment, so the two can never disagree.
    expect(response.body.data.order.dueDate).toBe(plan[2].dueDate);
  });

  it('puts the remainder on the first instalment, so the last one is the round number', async () => {
    const { token, service, customer } = await fixture();
    // ₹100.00 does not divide by three.
    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const response = await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });
    const amounts = response.body.data.order.installments.map(
      (entry: { amountMinor: number }) => entry.amountMinor,
    );

    expect(amounts).toEqual([3_334, 3_333, 3_333]);
    expect(amounts.reduce((sum: number, amount: number) => sum + amount, 0)).toBe(10_000);
  });

  it('accepts an explicit plan that adds up', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const response = await setInstallmentPlan(token, order.id, [
      { amountMinor: 15_000, dueDate: daysFromNow(7), notes: 'On delivery' },
      { amountMinor: 15_000, dueDate: daysFromNow(37) },
    ]);

    expect(response.status).toBe(200);
    expect(response.body.data.order.installments).toHaveLength(2);
    expect(response.body.data.order.installments[0].notes).toBe('On delivery');
  });

  it('refuses a plan that does not add up to the order', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const short = await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(7) },
      { amountMinor: 10_000, dueDate: daysFromNow(37) },
    ]);
    expect(short.status).toBe(422);
    expect(short.body.error.details[0].message).toContain('less than');

    const over = await setInstallmentPlan(token, order.id, [
      { amountMinor: 20_000, dueDate: daysFromNow(7) },
      { amountMinor: 20_000, dueDate: daysFromNow(37) },
    ]);
    expect(over.status).toBe(422);
    expect(over.body.error.details[0].message).toContain('more than');
  });

  it('refuses instalments whose dates run backwards', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    const response = await setInstallmentPlan(token, order.id, [
      { amountMinor: 15_000, dueDate: daysFromNow(37) },
      { amountMinor: 15_000, dueDate: daysFromNow(7) },
    ]);

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('installments[1].dueDate');
  });

  it('refuses to replace a plan that payments have already landed against', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });
    await payOrder(token, order.id, { amountMinor: 10_000, installmentNumber: 1 });

    const response = await setEvenPlan(token, order.id, { count: 2, firstDueDate: daysFromNow(7) });
    expect(response.status).toBe(409);
    expect(response.body.error.meta.paid).toBe(10_000);
  });

  it('spreads a deposit already taken across a plan agreed afterwards', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    // A deposit first, terms agreed after: the ordinary way this happens.
    await payOrder(token, order.id, { amountMinor: 12_000 });

    const response = await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });
    expect(response.status).toBe(200);

    const plan = response.body.data.order.installments;
    expect(plan[0].paidMinor).toBe(10_000);
    expect(plan[0].status).toBe('paid');
    expect(plan[1].paidMinor).toBe(2_000);
    expect(plan[1].status).toBe('partially_paid');
    expect(plan[2].paidMinor).toBe(0);
    // The plan and the order agree about what is still owed.
    const owed = plan.reduce(
      (sum: number, entry: { outstandingMinor: number }) => sum + entry.outstandingMinor,
      0,
    );
    expect(owed).toBe(response.body.data.order.outstandingMinor);
  });

  it('clears a plan when the draft it belongs to is repriced', async () => {
    const { token, service, customer } = await fixture();
    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 3 }],
      status: 'draft',
    });

    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });
    expect((await readOrder(token, order.id)).installments).toHaveLength(3);

    const repriced = await request(app())
      .patch(`${API}/orders/${order.id}`)
      .set(...auth(token))
      .send({ lines: [{ lineType: 'service', subjectId: service.id, quantity: 5 }] });

    expect(repriced.status).toBe(200);
    // A plan built against the old total no longer adds up, so it is cleared rather than
    // left to disagree with the order.
    expect(repriced.body.data.order.installments).toHaveLength(0);
  });

  it('refuses a plan on a closed order', async () => {
    const { token, service } = await fixture();
    const order = await orderFor300(token, service.id);
    await transitionOrder(token, order.id, 'cancelled');

    const response = await setEvenPlan(token, order.id, { count: 2, firstDueDate: daysFromNow(7) });
    expect(response.status).toBe(409);
  });

  it('refuses more instalments than the plan may hold', async () => {
    const { token, service } = await fixture();
    const order = await orderFor300(token, service.id);

    const response = await setEvenPlan(token, order.id, { count: 50, firstDueDate: daysFromNow(7) });
    expect(response.status).toBe(422);
  });
});

describe('paying instalments', () => {
  it('settles the named instalment and leaves the rest alone', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });

    const response = await payOrder(token, order.id, {
      amountMinor: 10_000,
      installmentNumber: 2,
    });

    expect(response.status).toBe(201);
    expect(response.body.data.payment.installmentNumber).toBe(2);

    const plan = response.body.data.order.installments;
    expect(plan[0].status).toBe('pending');
    expect(plan[1].status).toBe('paid');
    expect(plan[1].paidMinor).toBe(10_000);
    expect(plan[2].status).toBe('pending');
  });

  it('fills the earliest unpaid instalments in order when none is named', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });

    // ₹150 covers the first instalment and half of the second.
    const response = await payOrder(token, order.id, { amountMinor: 15_000 });

    const plan = response.body.data.order.installments;
    expect(plan[0].status).toBe('paid');
    expect(plan[1].status).toBe('partially_paid');
    expect(plan[1].paidMinor).toBe(5_000);
    expect(plan[1].outstandingMinor).toBe(5_000);
    expect(plan[2].status).toBe('pending');
  });

  it('points at the next instalment that still owes money', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });

    const start = await readOrder(token, order.id);
    expect(start.nextDueInstallment?.number).toBe(1);

    await payOrder(token, order.id, { amountMinor: 10_000 });
    const afterFirst = await readOrder(token, order.id);
    expect(afterFirst.nextDueInstallment?.number).toBe(2);
    expect(afterFirst.installments[1]!.isNextDue).toBe(true);
  });

  it('marks every instalment paid when the whole plan is settled', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });

    const response = await payOrder(token, order.id, { amountMinor: 30_000 });

    expect(response.body.data.order.paymentStatus).toBe('fully_paid');
    expect(
      response.body.data.order.installments.every((entry: { status: string }) => entry.status === 'paid'),
    ).toBe(true);
    expect(response.body.data.order.nextDueInstallment).toBeNull();
  });

  it('refuses a payment aimed at an instalment that is not on the plan', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 2, firstDueDate: daysFromNow(7) });

    const response = await payOrder(token, order.id, { amountMinor: 5_000, installmentNumber: 5 });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('installmentNumber');
    // Nothing was recorded.
    expect((await readOrder(token, order.id)).paidMinor).toBe(0);
  });

  it('lists the payments for one instalment', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);
    await setEvenPlan(token, order.id, { count: 3, firstDueDate: daysFromNow(7) });

    await payOrder(token, order.id, { amountMinor: 4_000, installmentNumber: 2 });
    await payOrder(token, order.id, { amountMinor: 6_000, installmentNumber: 2 });
    await payOrder(token, order.id, { amountMinor: 10_000, installmentNumber: 1 });

    const response = await request(app())
      .get(`${API}/payments`)
      .query({ payableType: 'order', payableId: order.id, installmentNumber: 2 })
      .set(...auth(token));

    expect(response.body.data.items).toHaveLength(2);
  });
});

describe('overdue', () => {
  it('reads as overdue once the due date has passed, without anything being written', async () => {
    const { token, service, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-5),
    });

    // The stored status still only says what has been settled.
    expect(order.paymentStatus).toBe('unpaid');
    // What a client displays folds in the clock.
    expect(order.paymentState).toBe('overdue');
  });

  it('is never overdue once it is fully paid, however late', async () => {
    const { token, service, customer } = await fixture();

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-30),
    });
    await payOrder(token, order.id, { amountMinor: 10_000 });

    const settled = await readOrder(token, order.id);
    expect(settled.paymentState).toBe('fully_paid');
  });

  it('is never overdue once the order is closed', async () => {
    const { token, service } = await fixture();

    const order = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-10),
    });
    await transitionOrder(token, order.id, 'cancelled');

    const cancelled = await readOrder(token, order.id);
    expect(cancelled.paymentState).toBe('unpaid');
  });

  it('filters the list down to what is actually late', async () => {
    const { token, service, customer } = await fixture();

    const late = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-3),
    });
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(10),
    });
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    const response = await request(app())
      .get(`${API}/orders?overdue=true`)
      .set(...auth(token));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].id).toBe(late.id);
  });

  it('marks the instalments that are late, and only those', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(-20) },
      { amountMinor: 10_000, dueDate: daysFromNow(-5) },
      { amountMinor: 10_000, dueDate: daysFromNow(25) },
    ]);

    const plan = (await readOrder(token, order.id)).installments;
    expect(plan[0]!.isOverdue).toBe(true);
    expect(plan[1]!.isOverdue).toBe(true);
    expect(plan[2]!.isOverdue).toBe(false);
  });

  it('stops counting an instalment as late once it is paid', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(-20) },
      { amountMinor: 20_000, dueDate: daysFromNow(25) },
    ]);
    await payOrder(token, order.id, { amountMinor: 10_000, installmentNumber: 1 });

    const plan = (await readOrder(token, order.id)).installments;
    expect(plan[0]!.isOverdue).toBe(false);
    expect(plan[0]!.status).toBe('paid');
  });
});

describe('receivables and the dashboard', () => {
  it('groups what is owed by customer, worst first', async () => {
    const { token, service } = await fixture();
    const late = await createCustomer(token, { firstName: 'Late', lastName: 'Payer' });
    const soon = await createCustomer(token, { firstName: 'Soon', lastName: 'Payer' });

    await createOrder(token, {
      customerId: late.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
      dueDate: daysFromNow(-9),
    });
    await createOrder(token, {
      customerId: soon.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(6),
    });

    const response = await request(app())
      .get(`${API}/receivables`)
      .set(...auth(token));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0].customerId).toBe(late.id);
    expect(response.body.data.items[0].overdueMinor).toBe(20_000);
    expect(response.body.data.items[0].isOverdue).toBe(true);
    expect(response.body.data.items[1].overdueMinor).toBe(0);
  });

  it('names an anonymous sale rather than leaving the cell empty', async () => {
    const { token, service } = await fixture();

    await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-2),
    });

    const response = await request(app())
      .get(`${API}/receivables`)
      .set(...auth(token));

    expect(response.body.data.items[0].customerId).toBeNull();
    expect(response.body.data.items[0].customerName).toBe('Walk-in sale');
  });

  it('narrows the receivables to what is overdue', async () => {
    const { token, service } = await fixture();
    const late = await createCustomer(token, { firstName: 'Late', lastName: 'Payer' });

    await createOrder(token, {
      customerId: late.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(-4),
    });
    await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(20),
    });

    const response = await request(app())
      .get(`${API}/receivables?overdue=true`)
      .set(...auth(token));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].customerId).toBe(late.id);
  });

  it('lists the instalments still owed, soonest first', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(-6) },
      { amountMinor: 10_000, dueDate: daysFromNow(10) },
      { amountMinor: 10_000, dueDate: daysFromNow(40) },
    ]);

    const response = await request(app())
      .get(`${API}/receivables/installments`)
      .set(...auth(token));

    expect(response.status).toBe(200);
    const rows = response.body.data.installments;
    expect(rows).toHaveLength(3);
    expect(rows[0].number).toBe(1);
    expect(rows[0].isOverdue).toBe(true);
    expect(rows[0].reference).toBe(order.reference);
    expect(rows[1].isOverdue).toBe(false);
  });

  it('still lists the unpaid instalments of a plan that has had one settled', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(-6) },
      { amountMinor: 10_000, dueDate: daysFromNow(10) },
      { amountMinor: 10_000, dueDate: daysFromNow(40) },
    ]);
    await payOrder(token, order.id, { amountMinor: 10_000, installmentNumber: 1 });

    const response = await request(app())
      .get(`${API}/receivables/installments`)
      .set(...auth(token));

    // The settled one drops out; the two still owed do not. A query written as
    // `$ne: 'paid'` against the array would have dropped the whole order.
    const rows = response.body.data.installments;
    expect(rows).toHaveLength(2);
    expect(rows.map((row: { number: number }) => row.number)).toEqual([2, 3]);
  });

  it('narrows the instalment schedule to a horizon', async () => {
    const { token, service, customer } = await fixture();
    const order = await orderFor300(token, service.id, customer.id);

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 10_000, dueDate: daysFromNow(3) },
      { amountMinor: 10_000, dueDate: daysFromNow(10) },
      { amountMinor: 10_000, dueDate: daysFromNow(90) },
    ]);

    const response = await request(app())
      .get(`${API}/receivables/installments?withinDays=30`)
      .set(...auth(token));

    expect(response.body.data.installments).toHaveLength(2);
  });

  it("counts the dashboard figures from the merchant's own records", async () => {
    const { token, service, customer } = await fixture();

    // Sold today and settled.
    const settled = await orderFor300(token, service.id, customer.id);
    await payOrder(token, settled.id, { amountMinor: 30_000 });

    // Sold today, still owing and already late.
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 2 }],
      dueDate: daysFromNow(-4),
    });

    // Due soon.
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(3),
    });

    // A draft, which is not a sale yet.
    await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      status: 'draft',
    });

    const response = await request(app())
      .get(`${API}/dashboard`)
      .set(...auth(token));

    expect(response.status).toBe(200);
    const summary = response.body.data.summary;

    expect(summary.sales.todayOrders).toBe(4);
    expect(summary.sales.todayMinor).toBe(70_000);
    expect(summary.sales.draftOrders).toBe(1);
    expect(summary.receivables.outstandingMinor).toBe(40_000);
    expect(summary.receivables.overdueMinor).toBe(20_000);
    expect(summary.receivables.overdueOrders).toBe(1);
    expect(summary.receivables.dueSoonMinor).toBe(10_000);
    expect(summary.receivables.customersOwing).toBe(1);
    // Money that came in today, which is not the same as what was sold today.
    expect(summary.collectedTodayMinor).toBe(30_000);
  });

  it("starts a new merchant's dashboard at zero rather than empty", async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .get(`${API}/dashboard`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.sales.todayMinor).toBe(0);
    expect(response.body.data.summary.receivables.outstandingMinor).toBe(0);
    expect(response.body.data.summary.payablesMinor).toBe(0);
  });

  it("never counts another merchant's money", async () => {
    const { token, service, customer } = await fixture();
    await orderFor300(token, service.id, customer.id);

    const other = await registerMerchant();
    const response = await request(app())
      .get(`${API}/dashboard`)
      .set(...auth(other.accessToken));

    expect(response.body.data.summary.sales.todayMinor).toBe(0);
    expect(response.body.data.summary.receivables.outstandingMinor).toBe(0);
  });
});

describe('the order vocabulary the clients read', () => {
  it('serves the lifecycle, so no client keeps its own copy of the map', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .get(`${API}/catalog/meta`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    const meta = response.body.data;

    const draft = meta.orderStatuses.find((entry: { value: string }) => entry.value === 'draft');
    expect(draft.allowedNext).toContain('confirmed');
    expect(draft.holdsStock).toBe(false);
    expect(draft.editable).toBe(true);

    const confirmed = meta.orderStatuses.find(
      (entry: { value: string }) => entry.value === 'confirmed',
    );
    expect(confirmed.holdsStock).toBe(true);
    expect(confirmed.editable).toBe(false);

    const cancelled = meta.orderStatuses.find(
      (entry: { value: string }) => entry.value === 'cancelled',
    );
    expect(cancelled.terminal).toBe(true);
    expect(cancelled.allowedNext).toEqual([]);

    expect(meta.orderLineTypes).toEqual(['item', 'service']);
    expect(meta.discountTypes).toEqual(['none', 'amount', 'percent']);
    expect(meta.installmentStatuses).toEqual(['pending', 'partially_paid', 'paid']);
    expect(meta.limits.maxInstallments).toBe(36);
  });
});

describe('the PRD worked example', () => {
  /**
   * PRD section "Payment recording", the example it states outright: a ₹10,000 order
   * settled by ₹2,000, ₹3,000 and ₹5,000, ending fully paid, with each payment visible
   * separately with its own date, amount, method and notes.
   *
   * Written as its own test because it is the example the product was specified against,
   * and a suite that covers the rules but not the stated example has not been checked
   * against the brief.
   */
  it('settles a ₹10,000 order with three payments of ₹2,000, ₹3,000 and ₹5,000', async () => {
    const merchant = await registerMerchant();
    const token = merchant.accessToken;
    const customer = await createCustomer(token);

    // One service at ₹10,000.00, so the total is exactly the PRD's figure.
    const service = await createService(token, {
      name: 'Tailoring job',
      billingUnit: 'one_time',
      rateMinor: 1_000_000,
    });

    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });
    expect(order.totalMinor).toBe(1_000_000);
    expect(order.paymentStatus).toBe('unpaid');

    const first = await payOrder(token, order.id, {
      amountMinor: 200_000,
      method: 'cash',
      notes: 'Deposit at the counter',
    });
    expect(first.status).toBe(201);
    expect(first.body.data.order.paymentStatus).toBe('partially_paid');
    expect(first.body.data.order.outstandingMinor).toBe(800_000);

    const second = await payOrder(token, order.id, {
      amountMinor: 300_000,
      method: 'upi',
      reference: 'UPI-77301',
    });
    expect(second.body.data.order.paymentStatus).toBe('partially_paid');
    expect(second.body.data.order.outstandingMinor).toBe(500_000);

    const third = await payOrder(token, order.id, {
      amountMinor: 500_000,
      method: 'bank_transfer',
      reference: 'NEFT-99812',
      notes: 'Balance on delivery',
    });
    expect(third.body.data.order.paymentStatus).toBe('fully_paid');
    expect(third.body.data.order.outstandingMinor).toBe(0);

    // Each payment is visible separately, with its own amount, method, reference and note.
    const entries = await request(app())
      .get(`${API}/payments`)
      .query({ payableType: 'order', payableId: order.id })
      .set(...auth(token));

    const rows = entries.body.data.items as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(3);
    // Newest first, each carrying the balance it left behind.
    expect(rows.map((row) => row.amountMinor)).toEqual([500_000, 300_000, 200_000]);
    expect(rows.map((row) => row.method)).toEqual(['bank_transfer', 'upi', 'cash']);
    expect(rows.map((row) => row.balanceAfterMinor)).toEqual([0, 500_000, 800_000]);
    expect(rows[0]!.reference).toBe('NEFT-99812');
    expect(rows[0]!.notes).toBe('Balance on delivery');
    expect(rows[2]!.notes).toBe('Deposit at the counter');
    for (const row of rows) {
      expect(typeof row.paidAt).toBe('string');
    }

    // And the three add back to the order's own total, which is the invariant that makes
    // the figure above explainable rather than merely stored.
    const summed = rows.reduce((total, row) => total + (row.amountMinor as number), 0);
    expect(summed).toBe(1_000_000);

    // The customer owes nothing once the last payment lands.
    const settled = await request(app())
      .get(`${API}/customers/${customer.id}`)
      .set(...auth(token));
    expect(settled.body.data.customer.outstandingMinor).toBe(0);
  });

  /** The same ₹10,000, settled through a three-instalment plan instead. */
  it('settles the same order through a three-instalment plan', async () => {
    const merchant = await registerMerchant();
    const token = merchant.accessToken;
    const customer = await createCustomer(token);

    const service = await createService(token, {
      name: 'Tailoring job',
      billingUnit: 'one_time',
      rateMinor: 1_000_000,
    });
    const order = await createOrder(token, {
      customerId: customer.id,
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
    });

    await setInstallmentPlan(token, order.id, [
      { amountMinor: 200_000, dueDate: daysFromNow(7) },
      { amountMinor: 300_000, dueDate: daysFromNow(37) },
      { amountMinor: 500_000, dueDate: daysFromNow(67) },
    ]);

    // The next due instalment is made obvious, which the PRD asks for (section 9).
    const planned = await readOrder(token, order.id);
    expect(planned.nextDueInstallment?.number).toBe(1);
    expect(planned.installments[0]!.isNextDue).toBe(true);

    await payOrder(token, order.id, { amountMinor: 200_000, installmentNumber: 1 });
    await payOrder(token, order.id, { amountMinor: 300_000, installmentNumber: 2 });
    const last = await payOrder(token, order.id, { amountMinor: 500_000, installmentNumber: 3 });

    expect(last.body.data.order.paymentStatus).toBe('fully_paid');
    // The final instalment closes the balance, and no instalment is left owing.
    expect(
      last.body.data.order.installments.every((entry: { status: string }) => entry.status === 'paid'),
    ).toBe(true);
    expect(last.body.data.order.nextDueInstallment).toBeNull();
    expect(last.body.data.order.outstandingMinor).toBe(0);
  });
});
