import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { Merchant } from '../src/models/Merchant';
import { API, app, pngFixture, registerMerchant, verifyNewPhone } from './helpers';

describe('POST /auth/register', () => {
  it('creates a merchant from the verified phone number and returns a usable session', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100001');

    const response = await request(app()).post(`${API}/auth/register`).send({
      registrationToken,
      firstName: 'Anita',
      lastName: 'Desai',
      gender: 'female',
    });

    expect(response.status).toBe(201);
    expect(response.body.data.merchant).toMatchObject({
      countryCode: '+91',
      phone: '9811100001',
      phoneE164: '+919811100001',
      phoneEditable: false,
      firstName: 'Anita',
      lastName: 'Desai',
      fullName: 'Anita Desai',
      gender: 'female',
      status: 'active',
      photoUrl: null,
    });

    const me = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${response.body.data.tokens.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.merchant.id).toBe(response.body.data.merchant.id);
  });

  it.each([
    ['firstName', { lastName: 'Desai', gender: 'female' }],
    ['lastName', { firstName: 'Anita', gender: 'female' }],
    ['gender', { firstName: 'Anita', lastName: 'Desai' }],
  ])('requires %s', async (field, payload) => {
    const { registrationToken } = await verifyNewPhone('+91', `98111${Math.floor(10000 + Math.random() * 89999)}`);

    const response = await request(app())
      .post(`${API}/auth/register`)
      .send({ registrationToken, ...payload });

    expect(response.status).toBe(422);
    expect(response.body.error.details.map((issue: { field: string }) => issue.field)).toContain(field);
    expect(await Merchant.countDocuments()).toBe(0);
  });

  it('rejects a gender value outside the supported options', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100002');

    const response = await request(app()).post(`${API}/auth/register`).send({
      registrationToken,
      firstName: 'Anita',
      lastName: 'Desai',
      gender: 'whatever',
    });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('gender');
  });

  it('does not let the request body supply or override the verified phone number', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100003');

    const response = await request(app()).post(`${API}/auth/register`).send({
      registrationToken,
      firstName: 'Anita',
      lastName: 'Desai',
      gender: 'female',
      countryCode: '+1',
      phone: '5550001111',
    });

    expect(response.status).toBe(422);
    expect(await Merchant.countDocuments()).toBe(0);
  });

  it('accepts an optional profile photo during registration', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100004');

    const response = await request(app())
      .post(`${API}/auth/register`)
      .field('registrationToken', registrationToken)
      .field('firstName', 'Imran')
      .field('lastName', 'Shaikh')
      .field('gender', 'male')
      .attach('photo', pngFixture(), { filename: 'avatar.png', contentType: 'image/png' });

    expect(response.status).toBe(201);
    expect(response.body.data.merchant.photoUrl).toMatch(/\/uploads\/merchants\/.+\.png$/);
  });

  it('rejects a file that is not really an image', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100005');

    const response = await request(app())
      .post(`${API}/auth/register`)
      .field('registrationToken', registrationToken)
      .field('firstName', 'Imran')
      .field('lastName', 'Shaikh')
      .field('gender', 'male')
      .attach('photo', Buffer.from('MZ this is an executable, not a picture'), {
        filename: 'avatar.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('UPLOAD_REJECTED');
    expect(await Merchant.countDocuments()).toBe(0);
  });

  it('refuses a registration token for a phone number that is already registered', async () => {
    const { registrationToken } = await verifyNewPhone('+91', '9811100006');

    const first = await request(app())
      .post(`${API}/auth/register`)
      .send({ registrationToken, firstName: 'Anita', lastName: 'Desai', gender: 'female' });
    const second = await request(app())
      .post(`${API}/auth/register`)
      .send({ registrationToken, firstName: 'Anita', lastName: 'Desai', gender: 'female' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('ALREADY_REGISTERED');
  });

  it('refuses a tampered or absent registration token', async () => {
    const missing = await request(app())
      .post(`${API}/auth/register`)
      .send({ firstName: 'Anita', lastName: 'Desai', gender: 'female' });
    expect(missing.status).toBe(422);

    const tampered = await request(app()).post(`${API}/auth/register`).send({
      registrationToken: 'eyJhbGciOiJIUzI1NiJ9.eyJ0eXBlIjoicmVnaXN0cmF0aW9uIn0.bad-signature',
      firstName: 'Anita',
      lastName: 'Desai',
      gender: 'female',
    });
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_TOKEN');
  });

  it('records registration in the audit trail', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9811100007' });

    const entry = await AuditLog.findOne({ action: 'merchant.registered', targetId: merchant.id });
    expect(entry).not.toBeNull();
    expect(entry?.actorType).toBe('merchant');
    // The audit summary masks the number rather than repeating it in full.
    expect(entry?.summary).toContain('+91********07');
  });
});
