import request from 'supertest';
import {
  API,
  app,
  auth,
  createCustomer,
  createItem,
  createOrder,
  createService,
  daysFromNow,
  payOrder,
  readItem,
  readOrder,
  registerMerchant,
  seedRbac,
  setInstallmentPlan,
  signInAdmin,
} from './helpers';

/**
 * The admin side of orders: cross-merchant reads, support writes, and the permission
 * gates in front of both.
 *
 * The writes go through the same services the app uses, so the lifecycle rules and the
 * stock effects are checked here too — an administrator cannot reach a state a merchant
 * could not.
 */

/** A merchant with a stocked item, a service, a customer and two orders. */
async function merchantWithOrders() {
  const merchant = await registerMerchant();
  const token = merchant.accessToken;

  const item = await createItem(token, {
    name: 'Drilldown Chai',
    unit: 'piece',
    sellingPriceMinor: 4_500,
    openingQuantity: 20,
  });
  const service = await createService(token, { billingUnit: 'one_time', rateMinor: 10_000 });
  const customer = await createCustomer(token, { firstName: 'Drilldown', lastName: 'Rao' });

  const open = await createOrder(token, {
    customerId: customer.id,
    lines: [{ lineType: 'item', subjectId: item.id, quantity: 4 }],
    dueDate: daysFromNow(-6),
  });

  const draft = await createOrder(token, {
    customerId: customer.id,
    lines: [{ lineType: 'service', subjectId: service.id, quantity: 3 }],
    status: 'draft',
  });

  return { merchant, token, item, service, customer, open, draft };
}

describe('admin orders', () => {
  // Every test starts from an empty database (see tests/setup.ts), so the roles and
  // admin accounts are seeded per test rather than once.
  beforeEach(async () => {
    await seedRbac();
  });

  it('lists orders across merchants, naming who owns each row', async () => {
    const { merchant, open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/orders`)
      .query({ search: 'Drilldown' })
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const row = (response.body.data.items as Array<Record<string, unknown>>).find(
      (order) => order.id === open.id,
    );
    expect(row).toBeDefined();
    expect(row!.merchantId).toBe(merchant.id);
    expect(row!.merchantName).toBe('Anita Desai');
  });

  it('drills into one merchant orders', async () => {
    const { merchant } = await merchantWithOrders();
    await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/orders`)
      .query({ merchantId: merchant.id })
      .set(...auth(admin.accessToken));

    expect(response.body.data.items).toHaveLength(2);
    for (const row of response.body.data.items) {
      expect(row.merchantId).toBe(merchant.id);
    }
  });

  it('filters to what is overdue, across every merchant', async () => {
    const { open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/orders`)
      .query({ overdue: true })
      .set(...auth(admin.accessToken));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].id).toBe(open.id);
    expect(response.body.data.items[0].paymentState).toBe('overdue');
  });

  it('serves one order with its payments and what it may become next', async () => {
    const { token, open } = await merchantWithOrders();
    await payOrder(token, open.id, { amountMinor: 5_000 });
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/orders/${open.id}`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.order.reference).toBe(open.reference);
    expect(response.body.data.order.merchantName).toBe('Anita Desai');
    expect(response.body.data.payments).toHaveLength(1);
    expect(response.body.data.allowedTransitions).toContain('completed');
  });

  it('moves an order on, and the merchant sees who did it', async () => {
    const { token, open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/orders/${open.id}/status`)
      .set(...auth(admin.accessToken))
      .send({ status: 'completed' });

    expect(response.status).toBe(200);
    expect(response.body.data.order.status).toBe('completed');
    expect((await readOrder(token, open.id)).status).toBe('completed');

    const audit = await request(app())
      .get(`${API}/admin/audit-logs`)
      .query({ action: 'order.completed' })
      .set(...auth(admin.accessToken));

    expect(audit.body.data.items[0].actorType).toBe('admin');
  });

  it('sends a cancellation to its own endpoint, so the gate cannot be bypassed', async () => {
    const { open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const throughStatus = await request(app())
      .post(`${API}/admin/orders/${open.id}/status`)
      .set(...auth(admin.accessToken))
      .send({ status: 'cancelled' });

    expect(throughStatus.status).toBe(422);
    expect(throughStatus.body.error.details[0].message).toContain('cancel endpoint');
  });

  it('cancels an order and puts its stock back', async () => {
    const { token, item, open } = await merchantWithOrders();
    expect((await readItem(token, item.id)).quantity).toBe(16);
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/orders/${open.id}/cancel`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Duplicate order' });

    expect(response.status).toBe(200);
    expect(response.body.data.order.status).toBe('cancelled');
    expect(response.body.data.order.cancelledReason).toBe('Duplicate order');
    expect((await readItem(token, item.id)).quantity).toBe(20);
  });

  it('cannot reach a state the lifecycle forbids', async () => {
    const { open } = await merchantWithOrders();
    const admin = await signInAdmin();

    await request(app())
      .post(`${API}/admin/orders/${open.id}/cancel`)
      .set(...auth(admin.accessToken))
      .expect(200);

    const response = await request(app())
      .post(`${API}/admin/orders/${open.id}/status`)
      .set(...auth(admin.accessToken))
      .send({ status: 'completed' });

    expect(response.status).toBe(409);
  });

  it('records a payment on the merchant behalf, marked as support', async () => {
    const { token, open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/orders/${open.id}/payments`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 9_000, method: 'bank_transfer', reference: 'NEFT-SUPPORT-1' });

    expect(response.status).toBe(201);
    expect(response.body.data.payment.actorType).toBe('admin');
    expect(response.body.data.order.paidMinor).toBe(9_000);
    expect(response.body.data.order.paymentStatus).toBe('partially_paid');

    // The merchant sees the entry in their own ledger, not a mystery balance.
    const entries = await request(app())
      .get(`${API}/payments`)
      .query({ payableType: 'order', payableId: open.id })
      .set(...auth(token));
    expect(entries.body.data.items[0].actorType).toBe('admin');
  });

  it('refuses an overpayment, the same as the merchant endpoint does', async () => {
    const { open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/orders/${open.id}/payments`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 50_000, method: 'cash' });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.outstanding).toBe(18_000);
  });

  it('sets an instalment plan that the merchant can then pay against', async () => {
    const { token, open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .put(`${API}/admin/orders/${open.id}/installments`)
      .set(...auth(admin.accessToken))
      .send({
        installments: [
          { amountMinor: 9_000, dueDate: daysFromNow(7) },
          { amountMinor: 9_000, dueDate: daysFromNow(37) },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body.data.order.installments).toHaveLength(2);

    const paid = await payOrder(token, open.id, { amountMinor: 9_000, installmentNumber: 1 });
    expect(paid.status).toBe(201);
    expect(paid.body.data.order.installments[0].status).toBe('paid');
  });

  it('refuses an admin plan that does not add up either', async () => {
    const { open } = await merchantWithOrders();
    const admin = await signInAdmin();

    const response = await request(app())
      .put(`${API}/admin/orders/${open.id}/installments`)
      .set(...auth(admin.accessToken))
      .send({ installments: [{ amountMinor: 1_000, dueDate: daysFromNow(7) }] });

    expect(response.status).toBe(422);
  });

  it('lists the unpaid instalments across merchants, soonest first', async () => {
    const { token, open } = await merchantWithOrders();
    await setInstallmentPlan(token, open.id, [
      { amountMinor: 9_000, dueDate: daysFromNow(-5) },
      { amountMinor: 9_000, dueDate: daysFromNow(25) },
    ]);
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/installments`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0].number).toBe(1);
    expect(response.body.data.items[0].isOverdue).toBe(true);
    expect(response.body.data.items[0].merchantName).toBe('Anita Desai');
  });

  it('still lists a plan unpaid instalments after one has been settled', async () => {
    const { token, open } = await merchantWithOrders();
    await setInstallmentPlan(token, open.id, [
      { amountMinor: 6_000, dueDate: daysFromNow(-5) },
      { amountMinor: 6_000, dueDate: daysFromNow(25) },
      { amountMinor: 6_000, dueDate: daysFromNow(55) },
    ]);
    await payOrder(token, open.id, { amountMinor: 6_000, installmentNumber: 1 });
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/installments`)
      .set(...auth(admin.accessToken));

    // The settled one drops out; the two still owed do not. A query written as
    // `$ne: 'paid'` against the array would have dropped the whole order.
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items.map((row: { number: number }) => row.number)).toEqual([2, 3]);
  });

  it('narrows the instalment list to what is overdue', async () => {
    const { token, open } = await merchantWithOrders();
    await setInstallmentPlan(token, open.id, [
      { amountMinor: 9_000, dueDate: daysFromNow(-5) },
      { amountMinor: 9_000, dueDate: daysFromNow(25) },
    ]);
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/installments`)
      .query({ overdue: true })
      .set(...auth(admin.accessToken));

    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].number).toBe(1);
  });

  it('narrows the orders to a period', async () => {
    const { token, service } = await merchantWithOrders();
    const old = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      orderDate: daysFromNow(-40),
    });
    const recent = await createOrder(token, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      orderDate: daysFromNow(-2),
    });
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/orders`)
      .query({ from: daysFromNow(-7), to: daysFromNow(0) })
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const ids = response.body.data.items.map((row: { id: string }) => row.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
  });

  it('narrows the payment entries to a period, by when the money moved', async () => {
    const { token, open } = await merchantWithOrders();
    await payOrder(token, open.id, { amountMinor: 4_000, paidAt: daysFromNow(-40) });
    await payOrder(token, open.id, { amountMinor: 5_000, paidAt: daysFromNow(-2) });
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/payments`)
      .query({ payableType: 'order', from: daysFromNow(-7), to: daysFromNow(0) })
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    // A payment back-dated outside the window is outside it, however recently it was
    // written: the filter is on when the money moved.
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0].amountMinor).toBe(5_000);
  });

  it('rolls receivables up per merchant, worst first', async () => {
    const behind = await merchantWithOrders();
    const current = await registerMerchant();
    const service = await createService(current.accessToken, {
      billingUnit: 'one_time',
      rateMinor: 5_000,
    });
    await createOrder(current.accessToken, {
      lines: [{ lineType: 'service', subjectId: service.id, quantity: 1 }],
      dueDate: daysFromNow(3),
    });

    const admin = await signInAdmin();
    const response = await request(app())
      .get(`${API}/admin/receivables`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    // The merchant who is actually behind comes first: that is who support calls.
    expect(response.body.data.items[0].merchantId).toBe(behind.merchant.id);
    expect(response.body.data.items[0].overdueMinor).toBe(18_000);
    expect(response.body.data.items[1].overdueMinor).toBe(0);
    expect(response.body.data.items[1].dueSoonMinor).toBe(5_000);
  });

  it('counts one merchant orders for the drill-down', async () => {
    const { merchant, token, open } = await merchantWithOrders();
    await payOrder(token, open.id, { amountMinor: 8_000 });
    await setInstallmentPlan(token, open.id, [
      { amountMinor: 18_000, dueDate: daysFromNow(-3) },
    ]).catch(() => null);
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/order-summary`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const summary = response.body.data.summary;
    expect(summary.orders.total).toBe(2);
    expect(summary.orders.confirmed).toBe(1);
    expect(summary.orders.draft).toBe(1);
    expect(summary.orders.cancelled).toBe(0);
    expect(summary.salesMinor).toBe(48_000);
    expect(summary.outstandingMinor).toBe(40_000);
    expect(summary.overdueMinor).toBe(10_000);
    expect(summary.overdueOrders).toBe(1);
  });

  it('counts a merchant with no orders as zeros rather than failing', async () => {
    const merchant = await registerMerchant();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/order-summary`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.summary.orders.total).toBe(0);
    expect(response.body.data.summary.outstandingMinor).toBe(0);
  });

  describe('permissions', () => {
    it('lets a read-only admin look but not touch', async () => {
      const { open } = await merchantWithOrders();
      const readOnly = await signInAdmin('readonly@sellersdash.local');

      const list = await request(app())
        .get(`${API}/admin/orders`)
        .set(...auth(readOnly.accessToken));
      expect(list.status).toBe(200);

      const move = await request(app())
        .post(`${API}/admin/orders/${open.id}/status`)
        .set(...auth(readOnly.accessToken))
        .send({ status: 'completed' });
      expect(move.status).toBe(403);

      const cancel = await request(app())
        .post(`${API}/admin/orders/${open.id}/cancel`)
        .set(...auth(readOnly.accessToken));
      expect(cancel.status).toBe(403);

      const pay = await request(app())
        .post(`${API}/admin/orders/${open.id}/payments`)
        .set(...auth(readOnly.accessToken))
        .send({ amountMinor: 1_000, method: 'cash' });
      expect(pay.status).toBe(403);

      const plan = await request(app())
        .put(`${API}/admin/orders/${open.id}/installments`)
        .set(...auth(readOnly.accessToken))
        .send({ installments: [{ amountMinor: 18_000, dueDate: daysFromNow(7) }] });
      expect(plan.status).toBe(403);
    });

    it('lets support read orders but not change or pay them', async () => {
      const { open } = await merchantWithOrders();
      const support = await signInAdmin('support@sellersdash.local');

      const read = await request(app())
        .get(`${API}/admin/orders/${open.id}`)
        .set(...auth(support.accessToken));
      expect(read.status).toBe(200);

      const move = await request(app())
        .post(`${API}/admin/orders/${open.id}/status`)
        .set(...auth(support.accessToken))
        .send({ status: 'completed' });
      expect(move.status).toBe(403);

      const pay = await request(app())
        .post(`${API}/admin/orders/${open.id}/payments`)
        .set(...auth(support.accessToken))
        .send({ amountMinor: 1_000, method: 'cash' });
      expect(pay.status).toBe(403);
    });

    it('lets finance take money and set plans, but not move the order on', async () => {
      const { open } = await merchantWithOrders();
      const finance = await signInAdmin('finance@sellersdash.local');

      const pay = await request(app())
        .post(`${API}/admin/orders/${open.id}/payments`)
        .set(...auth(finance.accessToken))
        .send({ amountMinor: 4_000, method: 'cash' });
      expect(pay.status).toBe(201);

      const plan = await request(app())
        .put(`${API}/admin/orders/${open.id}/installments`)
        .set(...auth(finance.accessToken))
        .send({
          installments: [
            { amountMinor: 9_000, dueDate: daysFromNow(7) },
            { amountMinor: 9_000, dueDate: daysFromNow(37) },
          ],
        });
      expect(plan.status).toBe(200);
      // The deposit already taken is spread across the new plan rather than left at zero,
      // so the schedule and the order agree about what is still owed.
      expect(plan.body.data.order.installments[0].paidMinor).toBe(4_000);
      expect(plan.body.data.order.installments[0].status).toBe('partially_paid');
      expect(plan.body.data.order.installments[1].paidMinor).toBe(0);

      const receivables = await request(app())
        .get(`${API}/admin/receivables`)
        .set(...auth(finance.accessToken));
      expect(receivables.status).toBe(200);

      const move = await request(app())
        .post(`${API}/admin/orders/${open.id}/status`)
        .set(...auth(finance.accessToken))
        .send({ status: 'completed' });
      expect(move.status).toBe(403);
    });

    it('refuses everything without a token', async () => {
      const { open } = await merchantWithOrders();

      for (const call of [
        request(app()).get(`${API}/admin/orders`),
        request(app()).get(`${API}/admin/orders/${open.id}`),
        request(app()).get(`${API}/admin/receivables`),
        request(app()).get(`${API}/admin/installments`),
        request(app()).post(`${API}/admin/orders/${open.id}/cancel`),
      ]) {
        const response = await call;
        expect(response.status).toBe(401);
      }
    });

    it('never lets a merchant token reach an admin endpoint', async () => {
      const { token, open } = await merchantWithOrders();

      const response = await request(app())
        .get(`${API}/admin/orders/${open.id}`)
        .set(...auth(token));

      expect(response.status).toBe(401);
    });
  });
});
