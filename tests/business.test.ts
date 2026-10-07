import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { Business } from '../src/models/Business';
import { API, app, auth, pngFixture, registerMerchant } from './helpers';

describe('business profile', () => {
  it('exists from the first read, so setup can start anywhere', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .get(`${API}/business`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.business).toMatchObject({
      name: null,
      currency: 'INR',
      status: 'active',
      lowStockAlertsEnabled: true,
    });
    // Nothing is filled in yet, and that is not an error state.
    expect(response.body.data.business.completion.percent).toBe(0);
  });

  it('saves one detail at a time without demanding the rest', async () => {
    const merchant = await registerMerchant();

    const named = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Desai General Store' });

    expect(named.status).toBe(200);
    expect(named.body.data.business.name).toBe('Desai General Store');
    expect(named.body.data.business.address.city).toBeNull();

    const located = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ city: 'Pune' });

    expect(located.body.data.business.name).toBe('Desai General Store');
    expect(located.body.data.business.address.city).toBe('Pune');
  });

  it('reports how much of the profile is filled in, as guidance not a gate', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Store', category: 'grocery', city: 'Pune' });

    const completion = response.body.data.business.completion;
    expect(completion.completed).toBe(3);
    expect(completion.total).toBe(5);
    expect(completion.percent).toBe(60);
    expect(completion.missing).toEqual(['contactPhone', 'logoUrl']);
  });

  it('accepts the nested shape it hands out', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({
        address: { line1: '12 Main Road', city: 'Pune', state: 'Maharashtra' },
        contact: { email: 'shop@example.com', countryCode: '+91', phone: '2026550100' },
        invoice: { showTaxNumber: true, footerNote: 'Thank you' },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.business.address).toMatchObject({
      line1: '12 Main Road',
      city: 'Pune',
      state: 'Maharashtra',
    });
    expect(response.body.data.business.contact).toMatchObject({
      email: 'shop@example.com',
      countryCode: '+91',
      phone: '2026550100',
    });
    expect(response.body.data.business.invoice).toMatchObject({
      showTaxNumber: true,
      footerNote: 'Thank you',
    });
  });

  it('clears a field when it is set to null', async () => {
    const merchant = await registerMerchant();

    await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ taxNumber: 'ABC123' });

    const cleared = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ taxNumber: null });

    expect(cleared.body.data.business.taxNumber).toBeNull();
  });

  it('clears an address or contact field that is set to null', async () => {
    const merchant = await registerMerchant();

    await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ city: 'Pune', addressLine1: '12 Market Road', contactEmail: 'shop@example.test' });

    // These fields also accept a nested `address`/`contact` object, and the fallback
    // between the two shapes must not swallow an explicit null: a null is the only way
    // a client can empty a detail it filled in earlier.
    const cleared = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ city: null, addressLine1: null, contactEmail: null });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.business.address.city).toBeNull();
    expect(cleared.body.data.business.address.line1).toBeNull();
    expect(cleared.body.data.business.contact.email).toBeNull();
  });

  it('accepts the nested shape it serves back', async () => {
    const merchant = await registerMerchant();

    const saved = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ address: { city: 'Nashik', line1: '4 Mill Lane' }, contact: { email: 'a@b.test' } });

    expect(saved.status).toBe(200);
    expect(saved.body.data.business.address.city).toBe('Nashik');
    expect(saved.body.data.business.address.line1).toBe('4 Mill Lane');
    expect(saved.body.data.business.contact.email).toBe('a@b.test');
  });

  it('requires a country code alongside a contact number', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ contactPhone: '2026550100' });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('contact.countryCode');
  });

  it('keeps the business contact number separate from the sign-in number', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9876500123' });

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ contactCountryCode: '+91', contactPhone: '2026550100' });

    expect(response.status).toBe(200);
    expect(response.body.data.business.contact.phone).toBe('2026550100');

    // The merchant's own verified number is untouched by a business update.
    const profile = await request(app())
      .get(`${API}/merchants/me`)
      .set(...auth(merchant.accessToken));
    expect(profile.body.data.merchant.phone).toBe('9876500123');
  });

  it('refuses an attempt to change the verified sign-in number here', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Store', phone: '9000000000' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PHONE_IMMUTABLE');
  });

  it('validates the currency, category and website', async () => {
    const merchant = await registerMerchant();
    const auth1 = auth(merchant.accessToken);

    const currency = await request(app()).patch(`${API}/business`).set(...auth1).send({ currency: 'XYZ' });
    expect(currency.status).toBe(422);

    const category = await request(app()).patch(`${API}/business`).set(...auth1).send({ category: 'spaceship' });
    expect(category.status).toBe(422);

    const website = await request(app()).patch(`${API}/business`).set(...auth1).send({ website: 'example.com' });
    expect(website.status).toBe(422);

    const good = await request(app())
      .patch(`${API}/business`)
      .set(...auth1)
      .send({ currency: 'AED', category: 'retail', website: 'https://example.com' });
    expect(good.status).toBe(200);
  });

  it('refuses an empty update', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({});

    expect(response.status).toBe(422);
  });

  it('stores inventory preferences with the business', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ lowStockAlertsEnabled: false, defaultPaymentTermsDays: 30 });

    expect(response.body.data.business.lowStockAlertsEnabled).toBe(false);
    expect(response.body.data.business.defaultPaymentTermsDays).toBe(30);
  });

  it('audits what changed', async () => {
    const merchant = await registerMerchant();

    await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ name: 'Desai General Store', city: 'Pune' });

    const entry = await AuditLog.findOne({ action: 'business.updated' });
    expect(entry).not.toBeNull();
    expect(entry?.changes.map((change) => change.field).sort()).toEqual(['city', 'name']);
  });

  it('uploads and removes a logo', async () => {
    const merchant = await registerMerchant();

    const uploaded = await request(app())
      .put(`${API}/business/logo`)
      .set(...auth(merchant.accessToken))
      .attach('logo', pngFixture(), { filename: 'logo.png', contentType: 'image/png' });

    expect(uploaded.status).toBe(200);
    expect(uploaded.body.data.business.logoUrl).toMatch(/\/uploads\/businesses\/.+\.png$/);
    expect(uploaded.body.data.business.completion.missing).not.toContain('logoUrl');

    const removed = await request(app())
      .delete(`${API}/business/logo`)
      .set(...auth(merchant.accessToken));

    expect(removed.body.data.business.logoUrl).toBeNull();
  });

  it('refuses a logo that is not really an image', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .put(`${API}/business/logo`)
      .set(...auth(merchant.accessToken))
      .attach('logo', Buffer.from('MZ not a picture'), {
        filename: 'logo.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UPLOAD_REJECTED');
  });

  it('gives each merchant their own business', async () => {
    const first = await registerMerchant();
    const second = await registerMerchant();

    await request(app())
      .patch(`${API}/business`)
      .set(...auth(first.accessToken))
      .send({ name: 'First Store' });

    const other = await request(app())
      .get(`${API}/business`)
      .set(...auth(second.accessToken));

    expect(other.body.data.business.name).toBeNull();
    expect(await Business.countDocuments({})).toBe(2);
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/business`);
    expect(response.status).toBe(401);
  });
});

describe('order and payment preferences', () => {
  it('starts with every payment method offered, rather than none', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .get(`${API}/business`)
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    // An untouched setting means "all of them": a merchant who has never opened it is not
    // quietly left unable to take a payment.
    expect(response.body.data.business.preferences.paymentMethods).toEqual(
      expect.arrayContaining(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other']),
    );
    expect(response.body.data.business.preferences.defaultOrderStatus).toBe('confirmed');
    expect(response.body.data.business.preferences.defaultTaxPercent).toBeNull();
  });

  it('narrows the methods a merchant offers, in the server own order', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      // Sent out of order on purpose: the stored list is normalised.
      .send({ enabledPaymentMethods: ['upi', 'cash'] });

    expect(response.status).toBe(200);
    expect(response.body.data.business.preferences.paymentMethods).toEqual(['cash', 'upi']);
  });

  it('refuses a method the engine has never heard of', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ enabledPaymentMethods: ['cash', 'crypto'] });

    expect(response.status).toBe(422);
  });

  it('takes an empty list as "all of them" rather than none', async () => {
    const merchant = await registerMerchant();

    await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ enabledPaymentMethods: ['cash'] })
      .expect(200);

    const cleared = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ enabledPaymentMethods: [] });

    expect(cleared.status).toBe(200);
    expect(cleared.body.data.business.preferences.paymentMethods.length).toBeGreaterThan(1);
  });

  it('remembers what a new order should start as', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ defaultOrderStatus: 'draft' });

    expect(response.status).toBe(200);
    expect(response.body.data.business.preferences.defaultOrderStatus).toBe('draft');
  });

  it('refuses a default status an order cannot start as', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ defaultOrderStatus: 'completed' });

    expect(response.status).toBe(422);
  });

  it('keeps a default tax rate, and clears it on an explicit null', async () => {
    const merchant = await registerMerchant();

    const set = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ defaultTaxPercent: 18 });
    expect(set.body.data.business.preferences.defaultTaxPercent).toBe(18);

    const cleared = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ defaultTaxPercent: null });
    // Null is meaningful: it is how a merchant says "no default", not "leave it alone".
    expect(cleared.body.data.business.preferences.defaultTaxPercent).toBeNull();
  });

  it('keeps a zero rate, which is not the same as no rate', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .patch(`${API}/business`)
      .set(...auth(merchant.accessToken))
      .send({ defaultTaxPercent: 0 });

    expect(response.body.data.business.preferences.defaultTaxPercent).toBe(0);
  });
});
