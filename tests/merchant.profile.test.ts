import request from 'supertest';
import { AuditLog } from '../src/models/AuditLog';
import { Merchant } from '../src/models/Merchant';
import { API, app, pngFixture, registerMerchant } from './helpers';

describe('GET /merchants/me', () => {
  it('returns the signed-in merchant and marks the phone number as not editable', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200001' });

    const response = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data.merchant).toMatchObject({
      countryCode: '+91',
      phone: '9822200001',
      phoneEditable: false,
    });
  });

  it('refuses a request with no token, a malformed token and a tampered token', async () => {
    const noToken = await request(app()).get(`${API}/merchants/me`);
    expect(noToken.status).toBe(401);

    const malformed = await request(app()).get(`${API}/merchants/me`).set('authorization', 'Token abc');
    expect(malformed.status).toBe(401);

    const tampered = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.nope');
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe('INVALID_TOKEN');
  });

  it('blocks a merchant whose account has been suspended since signing in', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200002' });
    await Merchant.updateOne({ _id: merchant.id }, { $set: { status: 'suspended' } });

    const response = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('PATCH /merchants/me', () => {
  it('lets a merchant change their name and gender after registration', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200003' });

    const response = await request(app())
      .patch(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`)
      .send({ firstName: 'Anita', lastName: 'Sharma', gender: 'prefer_not_to_say' });

    expect(response.status).toBe(200);
    expect(response.body.data.merchant).toMatchObject({
      firstName: 'Anita',
      lastName: 'Sharma',
      fullName: 'Anita Sharma',
      gender: 'prefer_not_to_say',
    });
  });

  it('lets a merchant change their language and appearance preference', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200004' });

    const response = await request(app())
      .patch(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`)
      .send({ locale: 'hi', themeMode: 'dark' });

    expect(response.status).toBe(200);
    expect(response.body.data.merchant).toMatchObject({ locale: 'hi', themeMode: 'dark' });
  });

  it.each(['phone', 'countryCode', 'phoneE164'])(
    'refuses an attempt to change the verified %s',
    async (field) => {
      const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200005' });

      const response = await request(app())
        .patch(`${API}/merchants/me`)
        .set('authorization', `Bearer ${merchant.accessToken}`)
        .send({ firstName: 'Anita', [field]: '+1' });

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PHONE_IMMUTABLE');

      const unchanged = await Merchant.findById(merchant.id);
      expect(unchanged?.countryCode).toBe('+91');
      expect(unchanged?.phone).toBe('9822200005');
      // The rejection happens before anything else is applied.
      expect(unchanged?.firstName).toBe('Anita');
    },
  );

  it('rejects an empty update and an invalid name', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200006' });
    const auth = `Bearer ${merchant.accessToken}`;

    const empty = await request(app()).patch(`${API}/merchants/me`).set('authorization', auth).send({});
    expect(empty.status).toBe(422);

    const invalid = await request(app())
      .patch(`${API}/merchants/me`)
      .set('authorization', auth)
      .send({ firstName: '<script>alert(1)</script>' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details[0].field).toBe('firstName');
  });

  it('writes an audit entry describing exactly what changed', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200007', lastName: 'Desai' });

    await request(app())
      .patch(`${API}/merchants/me`)
      .set('authorization', `Bearer ${merchant.accessToken}`)
      .send({ lastName: 'Sharma' });

    const entry = await AuditLog.findOne({ action: 'merchant.profile_updated', targetId: merchant.id });
    expect(entry).not.toBeNull();
    expect(entry?.changes).toEqual([
      expect.objectContaining({ field: 'lastName', from: 'Desai', to: 'Sharma' }),
    ]);
  });
});

describe('profile photo', () => {
  it('uploads, replaces and removes the optional profile photo', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200008' });
    const auth = `Bearer ${merchant.accessToken}`;

    const uploaded = await request(app())
      .put(`${API}/merchants/me/photo`)
      .set('authorization', auth)
      .attach('photo', pngFixture(), { filename: 'a.png', contentType: 'image/png' });

    expect(uploaded.status).toBe(200);
    const firstUrl: string = uploaded.body.data.merchant.photoUrl;
    expect(firstUrl).toMatch(/\/uploads\/merchants\/.+\.png$/);

    const replaced = await request(app())
      .put(`${API}/merchants/me/photo`)
      .set('authorization', auth)
      .attach('photo', pngFixture(), { filename: 'b.png', contentType: 'image/png' });

    expect(replaced.status).toBe(200);
    expect(replaced.body.data.merchant.photoUrl).not.toBe(firstUrl);

    const removed = await request(app()).delete(`${API}/merchants/me/photo`).set('authorization', auth);
    expect(removed.status).toBe(200);
    expect(removed.body.data.merchant.photoUrl).toBeNull();
  });

  it('requires a file and rejects a non-image content type', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9822200009' });
    const auth = `Bearer ${merchant.accessToken}`;

    const missing = await request(app()).put(`${API}/merchants/me/photo`).set('authorization', auth);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('UPLOAD_REJECTED');

    const wrongType = await request(app())
      .put(`${API}/merchants/me/photo`)
      .set('authorization', auth)
      .attach('photo', Buffer.from('plain text'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error.code).toBe('UPLOAD_REJECTED');
  });
});

describe('phone immutability at the model layer', () => {
  it('refuses a direct document write that changes the verified number', async () => {
    const registered = await registerMerchant({ countryCode: '+91', phone: '9822200010' });

    const merchant = await Merchant.findById(registered.id);
    expect(merchant).not.toBeNull();
    merchant!.phone = '9000000000';

    await expect(merchant!.save()).rejects.toThrow(/cannot be changed/i);
  });
});
