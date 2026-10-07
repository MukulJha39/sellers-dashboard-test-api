import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { Merchant } from '../src/models/Merchant';
import { API, app, registerMerchant, seedRbac, signInAdmin } from './helpers';

const PASSWORD = 'TestAdminPass#123';

describe('GET /admin/merchants', () => {
  let auth = '';

  beforeEach(async () => {
    await seedRbac();
    const session = await signInAdmin();
    auth = `Bearer ${session.accessToken}`;

    await registerMerchant({ countryCode: '+91', phone: '9844400001', firstName: 'Anita', lastName: 'Desai', gender: 'female' });
    await registerMerchant({ countryCode: '+91', phone: '9844400002', firstName: 'Rahul', lastName: 'Verma', gender: 'male' });
    await registerMerchant({ countryCode: '+44', phone: '7700900123', firstName: 'Jo', lastName: 'Harper', gender: 'prefer_not_to_say' });
  });

  it('shows a merchant registered from the app, with their identity data', async () => {
    const response = await request(app()).get(`${API}/admin/merchants`).set('authorization', auth);

    expect(response.status).toBe(200);
    expect(response.body.data.meta).toMatchObject({ page: 1, total: 3, totalPages: 1, hasNextPage: false });
    expect(response.body.data.items.map((item: { phone: string }) => item.phone).sort()).toEqual([
      '7700900123',
      '9844400001',
      '9844400002',
    ]);
    expect(response.body.data.items[0]).toHaveProperty('phoneEditable', false);
  });

  it('searches by name and by phone number', async () => {
    const byName = await request(app()).get(`${API}/admin/merchants?search=verma`).set('authorization', auth);
    expect(byName.body.data.items).toHaveLength(1);
    expect(byName.body.data.items[0].lastName).toBe('Verma');

    const byPhone = await request(app()).get(`${API}/admin/merchants?search=7700900`).set('authorization', auth);
    expect(byPhone.body.data.items).toHaveLength(1);
    expect(byPhone.body.data.items[0].firstName).toBe('Jo');

    const noMatch = await request(app()).get(`${API}/admin/merchants?search=zzzz`).set('authorization', auth);
    expect(noMatch.body.data.items).toHaveLength(0);
    expect(noMatch.body.data.meta.total).toBe(0);
  });

  it('treats a search term as literal text, not as a pattern', async () => {
    const response = await request(app()).get(`${API}/admin/merchants?search=.*`).set('authorization', auth);

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(0);
  });

  it('filters by status and by gender', async () => {
    await Merchant.updateOne({ phoneE164: '+919844400002' }, { $set: { status: 'suspended' } });

    const suspended = await request(app()).get(`${API}/admin/merchants?status=suspended`).set('authorization', auth);
    expect(suspended.body.data.items).toHaveLength(1);
    expect(suspended.body.data.items[0].phone).toBe('9844400002');

    const female = await request(app()).get(`${API}/admin/merchants?gender=female`).set('authorization', auth);
    expect(female.body.data.items).toHaveLength(1);
    expect(female.body.data.items[0].firstName).toBe('Anita');
  });

  it('paginates and sorts within an allowlist of fields', async () => {
    const firstPage = await request(app())
      .get(`${API}/admin/merchants?page=1&limit=2&sort=firstName`)
      .set('authorization', auth);

    expect(firstPage.body.data.items).toHaveLength(2);
    expect(firstPage.body.data.items.map((item: { firstName: string }) => item.firstName)).toEqual(['Anita', 'Jo']);
    expect(firstPage.body.data.meta).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2, hasNextPage: true });

    const secondPage = await request(app())
      .get(`${API}/admin/merchants?page=2&limit=2&sort=firstName`)
      .set('authorization', auth);
    expect(secondPage.body.data.items.map((item: { firstName: string }) => item.firstName)).toEqual(['Rahul']);
    expect(secondPage.body.data.meta.hasNextPage).toBe(false);

    const descending = await request(app())
      .get(`${API}/admin/merchants?sort=-firstName&limit=1`)
      .set('authorization', auth);
    expect(descending.body.data.items[0].firstName).toBe('Rahul');

    // An unknown sort field silently falls back instead of reaching into the document.
    const unknownSort = await request(app())
      .get(`${API}/admin/merchants?sort=passwordHash`)
      .set('authorization', auth);
    expect(unknownSort.status).toBe(200);
    expect(unknownSort.body.data.items).toHaveLength(3);
  });

  it('rejects invalid filter and pagination values', async () => {
    const badStatus = await request(app()).get(`${API}/admin/merchants?status=nope`).set('authorization', auth);
    expect(badStatus.status).toBe(422);

    const badLimit = await request(app()).get(`${API}/admin/merchants?limit=5000`).set('authorization', auth);
    expect(badLimit.status).toBe(422);
  });
});

describe('merchant detail and edits', () => {
  let auth = '';
  let merchantId = '';

  beforeEach(async () => {
    await seedRbac();
    const session = await signInAdmin();
    auth = `Bearer ${session.accessToken}`;
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9844400010', firstName: 'Anita', lastName: 'Desai' });
    merchantId = merchant.id;
  });

  it('returns a single merchant and 404s for an unknown or malformed id', async () => {
    const found = await request(app()).get(`${API}/admin/merchants/${merchantId}`).set('authorization', auth);
    expect(found.status).toBe(200);
    expect(found.body.data.merchant.phone).toBe('9844400010');

    const unknown = await request(app())
      .get(`${API}/admin/merchants/0123456789abcdef01234567`)
      .set('authorization', auth);
    expect(unknown.status).toBe(404);

    const malformed = await request(app()).get(`${API}/admin/merchants/not-an-id`).set('authorization', auth);
    expect(malformed.status).toBe(422);
  });

  it('lets an authorised admin correct a name, and audits the change', async () => {
    const response = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}`)
      .set('authorization', auth)
      .send({ lastName: 'Sharma' });

    expect(response.status).toBe(200);
    expect(response.body.data.merchant.lastName).toBe('Sharma');

    const entry = await AuditLog.findOne({ action: 'merchant.profile_updated_by_admin', targetId: merchantId });
    expect(entry?.actorType).toBe('admin');
    expect(entry?.changes).toEqual([
      expect.objectContaining({ field: 'lastName', from: 'Desai', to: 'Sharma' }),
    ]);
  });

  it('refuses an admin attempt to change the verified phone number', async () => {
    const response = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}`)
      .set('authorization', auth)
      .send({ firstName: 'Anita', phone: '9000000000' });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PHONE_IMMUTABLE');

    const unchanged = await Merchant.findById(merchantId);
    expect(unchanged?.phone).toBe('9844400010');
  });

  it('suspends a merchant, revokes their sessions immediately and audits it', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9844400011' });

    const beforeSuspension = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`);
    expect(beforeSuspension.status).toBe(200);

    const suspended = await request(app())
      .patch(`${API}/admin/merchants/${merchant.id}/status`)
      .set('authorization', auth)
      .send({ status: 'suspended', reason: 'Suspected fraudulent activity' });

    expect(suspended.status).toBe(200);
    expect(suspended.body.data.merchant.status).toBe('suspended');

    const afterSuspension = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`);
    expect(afterSuspension.status).toBe(401);

    const refreshAttempt = await request(app())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: merchant.refreshToken });
    expect(refreshAttempt.status).toBe(401);

    const entry = await AuditLog.findOne({ action: 'merchant.status_changed', targetId: merchant.id });
    expect(entry?.changes).toEqual([expect.objectContaining({ field: 'status', from: 'active', to: 'suspended' })]);
    expect(entry?.metadata).toMatchObject({ reason: 'Suspected fraudulent activity', revokedSessions: 1 });
  });

  it('reactivates a suspended merchant and clears the suspension details', async () => {
    await request(app())
      .patch(`${API}/admin/merchants/${merchantId}/status`)
      .set('authorization', auth)
      .send({ status: 'suspended', reason: 'Temporary hold for review' });

    const reactivated = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}/status`)
      .set('authorization', auth)
      .send({ status: 'active' });

    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.merchant.status).toBe('active');

    const merchant = await Merchant.findById(merchantId);
    expect(merchant?.suspendedAt).toBeNull();
    expect(merchant?.suspendedReason).toBeNull();
  });

  it('rejects an invalid status value', async () => {
    const response = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}/status`)
      .set('authorization', auth)
      .send({ status: 'deleted' });

    expect(response.status).toBe(422);
  });

  it('lets a support admin edit a merchant but not suspend one', async () => {
    const support = await signInAdmin('support@sellersdash.local', PASSWORD);
    const supportAuth = `Bearer ${support.accessToken}`;

    const edit = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}`)
      .set('authorization', supportAuth)
      .send({ firstName: 'Anita' });
    expect(edit.status).toBe(200);

    const suspend = await request(app())
      .patch(`${API}/admin/merchants/${merchantId}/status`)
      .set('authorization', supportAuth)
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(403);
  });
});

describe('GET /admin/audit-logs', () => {
  it('filters the trail by target so a merchant drill-down shows only their activity', async () => {
    await seedRbac();
    const session = await signInAdmin();
    const auth = `Bearer ${session.accessToken}`;

    const merchantA = await registerMerchant({ countryCode: '+91', phone: '9844400020' });
    await registerMerchant({ countryCode: '+91', phone: '9844400021' });

    const response = await request(app())
      .get(`${API}/admin/audit-logs?targetType=merchant&targetId=${merchantA.id}`)
      .set('authorization', auth);

    expect(response.status).toBe(200);
    expect(response.body.data.items.length).toBeGreaterThan(0);
    expect(
      response.body.data.items.every((item: { targetId: string }) => item.targetId === merchantA.id),
    ).toBe(true);
  });
});
