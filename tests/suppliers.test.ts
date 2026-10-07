import request from 'supertest';
import {
  API,
  app,
  auth,
  createMaterial,
  createPurchase,
  createSupplier,
  payPurchase,
  registerMerchant,
} from './helpers';

describe('suppliers', () => {
  it('creates a supplier from a name alone', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/suppliers`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Pune Handloom' });

    expect(response.status).toBe(201);
    const supplier = response.body.data.supplier;
    expect(supplier.name).toBe('Pune Handloom');
    // A merchant buying from the shop down the road often knows nothing else, and
    // demanding a phone number would only produce a fake one.
    expect(supplier.phone).toBeNull();
    expect(supplier.outstandingMinor).toBe(0);
    expect(supplier.purchaseCount).toBe(0);
  });

  it('requires a name', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/suppliers`)
      .set(...auth(merchant.accessToken))
      .send({ city: 'Pune' });

    expect(response.status).toBe(422);
    expect((response.body.error.details as Array<{ field: string }>)[0]!.field).toBe('name');
  });

  it('refuses a duplicate name within one merchant but allows it across merchants', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();

    const first = await createSupplier(one.accessToken, { name: 'Shared Mills' });

    const duplicate = await request(app())
      .post(`${API}/suppliers`)
      .set(...auth(one.accessToken))
      .send({ name: 'Shared Mills' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.meta.supplierId).toBe(first.id);

    const otherMerchant = await request(app())
      .post(`${API}/suppliers`)
      .set(...auth(two.accessToken))
      .send({ name: 'Shared Mills' });
    expect(otherMerchant.status).toBe(201);
  });

  it('requires a country code alongside a phone number', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/suppliers`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'No Code Supplies', phone: '2025550123' });

    expect(response.status).toBe(422);
    expect((response.body.error.details as Array<{ field: string }>)[0]!.field).toBe('countryCode');
  });

  it('clears the country code when the phone number is cleared', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken, {
      countryCode: '+91',
      phone: '2025550123',
    });
    expect(supplier.phoneE164).toBe('+912025550123');

    const response = await request(app())
      .patch(`${API}/suppliers/${supplier.id}`)
      .set(...auth(merchant.accessToken))
      .send({ phone: null });

    expect(response.status).toBe(200);
    // A dialling code on its own is not a contact detail.
    expect(response.body.data.supplier.phone).toBeNull();
    expect(response.body.data.supplier.countryCode).toBeNull();
    expect(response.body.data.supplier.phoneE164).toBeNull();
  });

  it('maintains purchase totals and what is still owed', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });

    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 10, unitCostMinor: 5_000 },
      ],
    });

    const afterPurchase = await request(app())
      .get(`${API}/suppliers/${supplier.id}`)
      .set(...auth(merchant.accessToken));
    expect(afterPurchase.body.data.supplier.purchaseCount).toBe(1);
    expect(afterPurchase.body.data.supplier.totalPurchasedMinor).toBe(50_000);
    expect(afterPurchase.body.data.supplier.outstandingMinor).toBe(50_000);

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 2, unitCostMinor: 5_000 },
      ],
    });
    await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 10_000 });

    const afterPayment = await request(app())
      .get(`${API}/suppliers/${supplier.id}`)
      .set(...auth(merchant.accessToken));
    expect(afterPayment.body.data.supplier.purchaseCount).toBe(2);
    expect(afterPayment.body.data.supplier.totalPurchasedMinor).toBe(60_000);
    // 60,000 bought, 10,000 paid.
    expect(afterPayment.body.data.supplier.outstandingMinor).toBe(50_000);
  });

  it('refuses to archive a supplier who is still owed money', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });

    await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 4, unitCostMinor: 2_500 },
      ],
    });

    const response = await request(app())
      .post(`${API}/suppliers/${supplier.id}/archive`)
      .set(...auth(merchant.accessToken));

    // An archived supplier leaves the pickers, and a merchant who owes them money
    // needs them findable.
    expect(response.status).toBe(409);
    expect(response.body.error.meta.outstanding).toBe(10_000);
  });

  it('archives a settled supplier and keeps their purchases intact', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });

    const purchase = await createPurchase(merchant.accessToken, {
      supplierId: supplier.id,
      lines: [
        { subjectType: 'material', subjectId: material.id, quantity: 1, unitCostMinor: 3_000 },
      ],
    });
    await payPurchase(merchant.accessToken, purchase.id, { amountMinor: 3_000 });

    const archived = await request(app())
      .post(`${API}/suppliers/${supplier.id}/archive`)
      .set(...auth(merchant.accessToken));
    expect(archived.status).toBe(200);

    // The purchase still names them: a historical record never loses its counterparty.
    const read = await request(app())
      .get(`${API}/purchases/${purchase.id}`)
      .set(...auth(merchant.accessToken));
    expect(read.status).toBe(200);
    expect(read.body.data.purchase.supplierName).toBe(supplier.name);
  });

  it('refuses a purchase from an archived supplier', async () => {
    const merchant = await registerMerchant();
    const supplier = await createSupplier(merchant.accessToken);
    const material = await createMaterial(merchant.accessToken, { unit: 'kilogram' });

    await request(app())
      .post(`${API}/suppliers/${supplier.id}/archive`)
      .set(...auth(merchant.accessToken));

    const response = await request(app())
      .post(`${API}/purchases`)
      .set(...auth(merchant.accessToken))
      .send({
        supplierId: supplier.id,
        lines: [
          { subjectType: 'material', subjectId: material.id, quantity: 1, unitCostMinor: 1_000 },
        ],
      });

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('archived');
  });

  it('searches and sorts', async () => {
    const merchant = await registerMerchant();
    await createSupplier(merchant.accessToken, { name: 'Alpha Textiles', city: 'Pune' });
    await createSupplier(merchant.accessToken, { name: 'Zeta Fabrics', city: 'Nashik' });

    const searched = await request(app())
      .get(`${API}/suppliers`)
      .query({ search: 'Nashik' })
      .set(...auth(merchant.accessToken));
    expect(searched.body.data.items).toHaveLength(1);
    expect(searched.body.data.items[0].name).toBe('Zeta Fabrics');

    const sorted = await request(app())
      .get(`${API}/suppliers`)
      .query({ sort: '-name' })
      .set(...auth(merchant.accessToken));
    expect(sorted.body.data.items[0].name).toBe('Zeta Fabrics');
  });

  it('keeps one merchant out of another merchant suppliers', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const supplier = await createSupplier(one.accessToken);

    const read = await request(app())
      .get(`${API}/suppliers/${supplier.id}`)
      .set(...auth(two.accessToken));
    expect(read.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/suppliers`);
    expect(response.status).toBe(401);
  });
});
