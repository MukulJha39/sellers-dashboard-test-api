import request from 'supertest';
import { API, app, auth, createCustomer, freshCustomerPhone, registerMerchant } from './helpers';

describe('customers', () => {
  it('creates a customer from the required identity fields alone', async () => {
    const merchant = await registerMerchant();
    const phone = freshCustomerPhone();

    const response = await request(app())
      .post(`${API}/customers`)
      .set(...auth(merchant.accessToken))
      .send({
        countryCode: '+91',
        phone,
        firstName: 'Nisha',
        lastName: 'Rao',
        gender: 'female',
      });

    expect(response.status).toBe(201);
    const customer = response.body.data.customer;
    expect(customer.fullName).toBe('Nisha Rao');
    expect(customer.phoneE164).toBe(`+91${phone}`);
    // Everything else is optional and comes back as an explicit empty value rather
    // than being absent, so a client never has to guess.
    expect(customer.email).toBeNull();
    expect(customer.tags).toEqual([]);
    expect(customer.outstandingMinor).toBe(0);
    expect(customer.archived).toBe(false);
  });

  it('requires a phone number, both names and gender', async () => {
    const merchant = await registerMerchant();

    const response = await request(app())
      .post(`${API}/customers`)
      .set(...auth(merchant.accessToken))
      .send({ firstName: 'Nisha' });

    expect(response.status).toBe(422);
    const fields = (response.body.error.details as Array<{ field: string }>).map((d) => d.field);
    expect(fields).toContain('countryCode');
    expect(fields).toContain('phone');
    expect(fields).toContain('lastName');
    expect(fields).toContain('gender');
  });

  it('keeps every other field optional', async () => {
    const merchant = await registerMerchant();

    const customer = await createCustomer(merchant.accessToken, {
      email: 'Nisha.Rao@Example.test',
      addressLine1: '4 Mill Lane',
      city: 'Pune',
      notes: 'Prefers deliveries after 6pm.',
      companyName: 'Rao Interiors',
      dateOfBirth: '1990-04-12T00:00:00.000Z',
      preferredChannel: 'whatsapp',
      language: 'hi',
      tags: ['VIP', 'wholesale'],
    });

    expect(customer.email).toBe('nisha.rao@example.test');
    expect(customer.address.city).toBe('Pune');
    expect(customer.companyName).toBe('Rao Interiors');
    expect(customer.preferredChannel).toBe('whatsapp');
    expect(customer.language).toBe('hi');
    expect(customer.tags).toEqual(['VIP', 'wholesale']);
    expect(customer.dateOfBirth).toBe('1990-04-12T00:00:00.000Z');
  });

  it('refuses a second customer with the same number, and says which one has it', async () => {
    const merchant = await registerMerchant();
    const phone = freshCustomerPhone();
    const first = await createCustomer(merchant.accessToken, { phone });

    const response = await request(app())
      .post(`${API}/customers`)
      .set(...auth(merchant.accessToken))
      .send({ countryCode: '+91', phone, firstName: 'Other', lastName: 'Person', gender: 'male' });

    expect(response.status).toBe(409);
    // The id comes back so the inline create sheet can offer the existing customer
    // rather than making the merchant start again.
    expect(response.body.error.meta.customerId).toBe(first.id);
    expect(response.body.error.meta.archived).toBe(false);
  });

  it('lets two merchants each have a customer on the same number', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const phone = freshCustomerPhone();

    await createCustomer(one.accessToken, { phone });
    const second = await createCustomer(two.accessToken, { phone });

    expect(second.phoneE164).toBe(`+91${phone}`);
  });

  it('deduplicates and trims tags', async () => {
    const merchant = await registerMerchant();

    const customer = await createCustomer(merchant.accessToken, {
      tags: ['VIP', 'vip ', ' VIP', 'wholesale', ''],
    });

    expect(customer.tags).toEqual(['VIP', 'wholesale']);
  });

  it('corrects a mistyped phone number, unlike the merchant own sign-in number', async () => {
    const merchant = await registerMerchant();
    const customer = await createCustomer(merchant.accessToken);
    const corrected = freshCustomerPhone();

    const response = await request(app())
      .patch(`${API}/customers/${customer.id}`)
      .set(...auth(merchant.accessToken))
      .send({ phone: corrected });

    expect(response.status).toBe(200);
    expect(response.body.data.customer.phoneE164).toBe(`+91${corrected}`);
  });

  it('refuses a correction onto another customer number', async () => {
    const merchant = await registerMerchant();
    const taken = await createCustomer(merchant.accessToken, { firstName: 'Taken' });
    const other = await createCustomer(merchant.accessToken, { firstName: 'Other' });

    const response = await request(app())
      .patch(`${API}/customers/${other.id}`)
      .set(...auth(merchant.accessToken))
      .send({ phone: taken.phone });

    expect(response.status).toBe(409);
    expect(response.body.error.meta.customerId).toBe(taken.id);
  });

  it('clears an optional field when it is set to null', async () => {
    const merchant = await registerMerchant();
    const customer = await createCustomer(merchant.accessToken, { city: 'Pune', notes: 'Note' });

    const response = await request(app())
      .patch(`${API}/customers/${customer.id}`)
      .set(...auth(merchant.accessToken))
      .send({ city: null, notes: null });

    expect(response.status).toBe(200);
    expect(response.body.data.customer.address.city).toBeNull();
    expect(response.body.data.customer.notes).toBeNull();
  });

  it('archives and restores, keeping the record intact', async () => {
    const merchant = await registerMerchant();
    const customer = await createCustomer(merchant.accessToken, { firstName: 'Archivable' });

    const archived = await request(app())
      .post(`${API}/customers/${customer.id}/archive`)
      .set(...auth(merchant.accessToken));
    expect(archived.status).toBe(200);
    expect(archived.body.data.customer.archived).toBe(true);

    // Gone from the default list, present in the archived one.
    const live = await request(app())
      .get(`${API}/customers`)
      .query({ search: 'Archivable' })
      .set(...auth(merchant.accessToken));
    expect(live.body.data.items).toHaveLength(0);

    const archivedList = await request(app())
      .get(`${API}/customers`)
      .query({ search: 'Archivable', archived: 'true' })
      .set(...auth(merchant.accessToken));
    expect(archivedList.body.data.items).toHaveLength(1);
    expect(archivedList.body.data.items[0].firstName).toBe('Archivable');

    const restored = await request(app())
      .post(`${API}/customers/${customer.id}/restore`)
      .set(...auth(merchant.accessToken));
    expect(restored.body.data.customer.archived).toBe(false);
  });

  it('tells a merchant when the number belongs to an archived customer', async () => {
    const merchant = await registerMerchant();
    const phone = freshCustomerPhone();
    const customer = await createCustomer(merchant.accessToken, { phone });

    await request(app())
      .post(`${API}/customers/${customer.id}/archive`)
      .set(...auth(merchant.accessToken));

    const response = await request(app())
      .post(`${API}/customers`)
      .set(...auth(merchant.accessToken))
      .send({ countryCode: '+91', phone, firstName: 'Again', lastName: 'Person', gender: 'male' });

    expect(response.status).toBe(409);
    // Said plainly: the number is not free, and the record can be restored.
    expect(response.body.error.message).toContain('archived');
    expect(response.body.error.meta.archived).toBe(true);
  });

  it('searches by name, phone number and company', async () => {
    const merchant = await registerMerchant();
    const phone = freshCustomerPhone();
    await createCustomer(merchant.accessToken, {
      phone,
      firstName: 'Vikram',
      lastName: 'Shetty',
      companyName: 'Shetty Hardware',
    });

    for (const term of ['Vikram', 'Shetty', phone.slice(-6), 'Hardware']) {
      const response = await request(app())
        .get(`${API}/customers`)
        .query({ search: term })
        .set(...auth(merchant.accessToken));

      expect(response.status).toBe(200);
      expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
      expect(
        (response.body.data.items as Array<{ firstName: string }>).some(
          (c) => c.firstName === 'Vikram',
        ),
      ).toBe(true);
    }
  });

  it('treats a search term as literal text', async () => {
    const merchant = await registerMerchant();
    await createCustomer(merchant.accessToken, { firstName: 'Normal', lastName: 'Name' });

    const response = await request(app())
      .get(`${API}/customers`)
      .query({ search: '.*' })
      .set(...auth(merchant.accessToken));

    expect(response.status).toBe(200);
    // A regex would have matched everything; literal text matches nothing.
    expect(response.body.data.items).toHaveLength(0);
  });

  it('filters by tag and lists the tags in use', async () => {
    const merchant = await registerMerchant();
    await createCustomer(merchant.accessToken, { firstName: 'Tagged', tags: ['wholesale'] });
    await createCustomer(merchant.accessToken, { firstName: 'Untagged' });

    const filtered = await request(app())
      .get(`${API}/customers`)
      .query({ tag: 'wholesale' })
      .set(...auth(merchant.accessToken));
    expect(filtered.body.data.items).toHaveLength(1);
    expect(filtered.body.data.items[0].firstName).toBe('Tagged');

    const tags = await request(app())
      .get(`${API}/customers/tags`)
      .set(...auth(merchant.accessToken));
    expect(tags.body.data.tags).toContain('wholesale');
  });

  it('keeps one merchant out of another merchant customers', async () => {
    const one = await registerMerchant();
    const two = await registerMerchant();
    const customer = await createCustomer(one.accessToken);

    const read = await request(app())
      .get(`${API}/customers/${customer.id}`)
      .set(...auth(two.accessToken));
    expect(read.status).toBe(404);

    const edit = await request(app())
      .patch(`${API}/customers/${customer.id}`)
      .set(...auth(two.accessToken))
      .send({ firstName: 'Hijacked' });
    expect(edit.status).toBe(404);
  });

  it('requires authentication', async () => {
    const response = await request(app()).get(`${API}/customers`);
    expect(response.status).toBe(401);
  });
});
