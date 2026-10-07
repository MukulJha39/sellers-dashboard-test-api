import request from 'supertest';
import {
  API,
  app,
  auth,
  createCustomer,
  createItem,
  createPurchase,
  createSupplier,
  payPurchase,
  readItem,
  registerMerchant,
  seedRbac,
  signInAdmin,
} from './helpers';

/** A merchant with a customer, a supplier and a received, part-paid purchase. */
async function merchantWithHistory() {
  const merchant = await registerMerchant();
  const customer = await createCustomer(merchant.accessToken, { firstName: 'Drilldown' });
  const supplier = await createSupplier(merchant.accessToken, { name: 'Drilldown Mills' });
  const item = await createItem(merchant.accessToken, { unit: 'piece', openingQuantity: 2 });

  const purchase = await createPurchase(merchant.accessToken, {
    supplierId: supplier.id,
    lines: [{ subjectType: 'item', subjectId: item.id, quantity: 10, unitCostMinor: 2_000 }],
    receiveStock: true,
    dueDate: '2026-01-01T00:00:00.000Z',
  });
  await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 5_000 });

  return { merchant, customer, supplier, item, purchase };
}

describe('admin relationships', () => {
  // Every test starts from an empty database (see tests/setup.ts), so the roles and
  // admin accounts are seeded per test rather than once.
  beforeEach(async () => {
    await seedRbac();
  });

  it('lists customers across merchants, naming who owns each row', async () => {
    const { merchant, customer } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/customers`)
      .query({ search: 'Drilldown' })
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const row = (response.body.data.items as Array<Record<string, unknown>>).find(
      (c) => c.id === customer.id,
    );
    expect(row).toBeDefined();
    expect(row!.merchantId).toBe(merchant.id);
    expect(row!.merchantName).toBe('Anita Desai');
  });

  it('drills into one merchant customers', async () => {
    const { merchant, customer } = await merchantWithHistory();
    await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/customers`)
      .query({ merchantId: merchant.id })
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const ids = (response.body.data.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toEqual([customer.id]);
  });

  it('shows a purchase with its line items and payment entries', async () => {
    const { purchase } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/purchases/${purchase.id}`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.purchase.reference).toBe(purchase.reference);
    expect(response.body.data.purchase.lines).toHaveLength(1);
    expect(response.body.data.purchase.paidMinor).toBe(5_000);
    expect(response.body.data.purchase.outstandingMinor).toBe(15_000);
    expect(response.body.data.purchase.merchantName).toBe('Anita Desai');
    expect(response.body.data.payments).toHaveLength(1);
    expect(response.body.data.payments[0].amountMinor).toBe(5_000);
  });

  it('reports the overdue state from the clock rather than a stored flag', async () => {
    const { purchase } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/purchases`)
      .query({ overdue: 'true' })
      .set(...auth(admin.accessToken));

    const row = (response.body.data.items as Array<Record<string, unknown>>).find(
      (p) => p.id === purchase.id,
    );
    expect(row).toBeDefined();
    expect(row!.paymentStatus).toBe('partially_paid');
    expect(row!.paymentState).toBe('overdue');
  });

  it('summarises a merchant relationships for the drill-down', async () => {
    const { merchant } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/merchants/${merchant.id}/relationship-summary`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    const summary = response.body.data.summary;
    expect(summary.customers.active).toBe(1);
    expect(summary.suppliers.active).toBe(1);
    expect(summary.suppliers.withOutstanding).toBe(1);
    expect(summary.purchases.recorded).toBe(1);
    expect(summary.purchases.overdue).toBe(1);
    expect(summary.outstandingPayableMinor).toBe(15_000);
  });

  it('edits a merchant customer on their behalf, marked as support', async () => {
    const { customer } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .patch(`${API}/admin/customers/${customer.id}`)
      .set(...auth(admin.accessToken))
      .send({ city: 'Pune' });

    expect(response.status).toBe(200);
    expect(response.body.data.customer.address.city).toBe('Pune');

    const audit = await request(app())
      .get(`${API}/admin/audit-logs`)
      .query({ action: 'customer.updated' })
      .set(...auth(admin.accessToken));

    const entry = (audit.body.data.items as Array<Record<string, unknown>>)[0]!;
    // The merchant can see that support made the change, not an unexplained edit.
    expect(entry.actorType).toBe('admin');
  });

  it('records a payment through the same engine, marked as admin', async () => {
    const { purchase } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/purchases/${purchase.id}/payments`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 15_000, method: 'bank_transfer' });

    expect(response.status).toBe(201);
    expect(response.body.data.payment.actorType).toBe('admin');
    expect(response.body.data.purchase.paymentStatus).toBe('fully_paid');
    expect(response.body.data.purchase.outstandingMinor).toBe(0);
  });

  it('refuses an admin overpayment with the same guard the merchant gets', async () => {
    const { purchase } = await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/purchases/${purchase.id}/payments`)
      .set(...auth(admin.accessToken))
      .send({ amountMinor: 99_999, method: 'cash' });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.outstanding).toBe(15_000);
  });

  it('cancels a purchase and returns its stock, through the shared service', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const item = await createItem(merchant.accessToken, { unit: 'piece', openingQuantity: 1 });
    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [{ subjectType: 'item', subjectId: item.id, quantity: 6, unitCostMinor: 1_000 }],
      receiveStock: true,
    });

    const admin = await signInAdmin();
    const response = await request(app())
      .post(`${API}/admin/purchases/${purchase.id}/cancel`)
      .set(...auth(admin.accessToken))
      .send({ reason: 'Duplicate entry reported by the merchant' });

    expect(response.status).toBe(200);
    expect(response.body.data.purchase.status).toBe('cancelled');
    // The same reversal the merchant would have got.
    expect((await readItem(merchant.accessToken, item.id)).quantity).toBe(1);
  });

  it('lists payments across merchants', async () => {
    await merchantWithHistory();
    const admin = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/payments`)
      .set(...auth(admin.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(response.body.data.items[0].merchantName).toBe('Anita Desai');
  });

  describe('permissions', () => {
    it('lets a read-only admin look but never change', async () => {
      const { customer, purchase } = await merchantWithHistory();
      const readOnly = await signInAdmin('readonly@sellersdash.local');

      for (const path of ['/admin/customers', '/admin/suppliers', '/admin/purchases']) {
        const response = await request(app())
          .get(`${API}${path}`)
          .set(...auth(readOnly.accessToken));
        expect(response.status).toBe(200);
      }

      const edit = await request(app())
        .patch(`${API}/admin/customers/${customer.id}`)
        .set(...auth(readOnly.accessToken))
        .send({ city: 'Nope' });
      expect(edit.status).toBe(403);

      const archive = await request(app())
        .post(`${API}/admin/customers/${customer.id}/archive`)
        .set(...auth(readOnly.accessToken));
      expect(archive.status).toBe(403);

      const cancel = await request(app())
        .post(`${API}/admin/purchases/${purchase.id}/cancel`)
        .set(...auth(readOnly.accessToken));
      expect(cancel.status).toBe(403);

      const pay = await request(app())
        .post(`${API}/admin/purchases/${purchase.id}/payments`)
        .set(...auth(readOnly.accessToken))
        .send({ amountMinor: 100, method: 'cash' });
      expect(pay.status).toBe(403);
    });

    it('lets a support admin edit a customer but not cancel a purchase', async () => {
      const { customer, purchase } = await merchantWithHistory();
      const support = await signInAdmin('support@sellersdash.local');

      const edit = await request(app())
        .patch(`${API}/admin/customers/${customer.id}`)
        .set(...auth(support.accessToken))
        .send({ city: 'Pune' });
      expect(edit.status).toBe(200);

      // Support helps merchants with their records; it does not unwind their money.
      const cancel = await request(app())
        .post(`${API}/admin/purchases/${purchase.id}/cancel`)
        .set(...auth(support.accessToken));
      expect(cancel.status).toBe(403);

      const pay = await request(app())
        .post(`${API}/admin/purchases/${purchase.id}/payments`)
        .set(...auth(support.accessToken))
        .send({ amountMinor: 100, method: 'cash' });
      expect(pay.status).toBe(403);
    });

    it('lets a finance admin record a payment but not edit a customer', async () => {
      const { customer, purchase } = await merchantWithHistory();
      const finance = await signInAdmin('finance@sellersdash.local');

      const pay = await request(app())
        .post(`${API}/admin/purchases/${purchase.id}/payments`)
        .set(...auth(finance.accessToken))
        .send({ amountMinor: 1_000, method: 'cash' });
      expect(pay.status).toBe(201);

      const edit = await request(app())
        .patch(`${API}/admin/customers/${customer.id}`)
        .set(...auth(finance.accessToken))
        .send({ city: 'Nope' });
      expect(edit.status).toBe(403);
    });

    it('requires authentication for every relationship endpoint', async () => {
      for (const path of [
        '/admin/customers',
        '/admin/suppliers',
        '/admin/purchases',
        '/admin/payments',
      ]) {
        const response = await request(app()).get(`${API}${path}`);
        expect(response.status).toBe(401);
      }
    });
  });
});
