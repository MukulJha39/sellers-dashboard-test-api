import request from 'supertest';
import { OtpVerification } from '../src/models/OtpVerification';
import { Merchant } from '../src/models/Merchant';
import { API, app, registerMerchant, requestOtp } from './helpers';

describe('POST /auth/otp/request', () => {
  it('sends a code for a valid country code and phone number', async () => {
    const response = await request(app())
      .post(`${API}/auth/otp/request`)
      .send({ countryCode: '+91', phone: '9876543210' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({
      maskedPhone: '+91********10',
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
      maxAttempts: 3,
    });
    expect(response.body.data.otpId).toBeTruthy();
  });

  it('never persists the code in plain text', async () => {
    const { code } = await requestOtp('+91', '9876543211');
    const stored = await OtpVerification.findOne({ phoneE164: '+919876543211' });

    expect(stored).not.toBeNull();
    expect(stored?.codeHash).not.toContain(code);
    expect(Object.keys(stored?.toObject() ?? {})).not.toContain('code');
  });

  it('rejects a missing phone number with a field-level message', async () => {
    const response = await request(app()).post(`${API}/auth/otp/request`).send({ countryCode: '+91' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.details).toEqual([{ field: 'phone', message: 'Enter your phone number.' }]);
  });

  it('rejects a malformed phone number', async () => {
    const response = await request(app())
      .post(`${API}/auth/otp/request`)
      .send({ countryCode: '+91', phone: '12ab34cd' });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('phone');
  });

  it('refuses a resend inside the cooldown window and says how long to wait', async () => {
    await requestOtp('+91', '9876543212');

    const response = await request(app())
      .post(`${API}/auth/otp/request`)
      .send({ countryCode: '+91', phone: '9876543212' });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('OTP_RESEND_TOO_SOON');
    expect(response.body.error.meta.retryAfterSeconds).toBeGreaterThan(0);
    expect(response.body.error.meta.retryAfterSeconds).toBeLessThanOrEqual(30);
  });

  it('allows a resend once the cooldown has passed and supersedes the previous code', async () => {
    const first = await requestOtp('+91', '9876543213');

    // Move the first request outside the cooldown window.
    await OtpVerification.updateOne(
      { _id: first.otpId },
      { $set: { lastSentAt: new Date(Date.now() - 60_000) } },
    );

    const second = await requestOtp('+91', '9876543213');
    expect(second.otpId).not.toBe(first.otpId);

    const supersededResponse = await request(app())
      .post(`${API}/auth/otp/verify`)
      .send({ otpId: first.otpId, code: first.code });

    expect(supersededResponse.status).toBe(400);
    expect(supersededResponse.body.error.code).toBe('OTP_ALREADY_USED');

    const currentResponse = await request(app())
      .post(`${API}/auth/otp/verify`)
      .send({ otpId: second.otpId, code: second.code });

    expect(currentResponse.status).toBe(200);
  });

  it('enforces the hourly quota for one phone number', async () => {
    const phone = '9876543214';

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { otpId } = await requestOtp('+91', phone);
      await OtpVerification.updateOne({ _id: otpId }, { $set: { lastSentAt: new Date(Date.now() - 60_000) } });
    }

    const response = await request(app()).post(`${API}/auth/otp/request`).send({ countryCode: '+91', phone });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe('RATE_LIMITED');
  });
});

describe('POST /auth/otp/verify', () => {
  it('routes a new phone number to registration without creating a merchant', async () => {
    const { otpId, code } = await requestOtp('+91', '9876543220');

    const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('registration_required');
    expect(response.body.data.registrationToken).toBeTruthy();
    expect(response.body.data).toMatchObject({ countryCode: '+91', phone: '9876543220' });
    expect(response.body.data.tokens).toBeUndefined();
    expect(await Merchant.countDocuments()).toBe(0);
  });

  it('signs an existing phone number straight in, with no registration step', async () => {
    await registerMerchant({ countryCode: '+91', phone: '9876543221', firstName: 'Rahul', lastName: 'Verma', gender: 'male' });

    const { otpId, code } = await requestOtp('+91', '9876543221');
    const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('authenticated');
    expect(response.body.data.merchant).toMatchObject({ firstName: 'Rahul', lastName: 'Verma', phone: '9876543221' });
    expect(response.body.data.tokens.accessToken).toBeTruthy();
    expect(response.body.data.registrationToken).toBeUndefined();
  });

  it('rejects an incorrect code and reports the attempts left', async () => {
    const { otpId } = await requestOtp('+91', '9876543222');

    const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code: '000000' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INVALID');
    expect(response.body.error.meta.attemptsRemaining).toBe(2);
  });

  it('locks the code after the attempt ceiling is reached', async () => {
    const { otpId, code } = await requestOtp('+91', '9876543223');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const wrong = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code: '111111' });
      expect(wrong.status).toBe(400);
    }

    const blocked = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(blocked.status).toBe(400);
    expect(blocked.body.error.code).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('rejects an expired code', async () => {
    const { otpId, code } = await requestOtp('+91', '9876543224');
    await OtpVerification.updateOne({ _id: otpId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_EXPIRED');
  });

  it('rejects a second verification of the same code, so a duplicate submit cannot double-verify', async () => {
    await registerMerchant({ countryCode: '+91', phone: '9876543225' });
    const { otpId, code } = await requestOtp('+91', '9876543225');

    const first = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });
    const second = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('OTP_ALREADY_USED');
  });

  it('rejects an unknown verification id', async () => {
    const response = await request(app())
      .post(`${API}/auth/otp/verify`)
      .send({ otpId: '0123456789abcdef01234567', code: '123456' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('OTP_INVALID');
  });

  it('refuses a suspended merchant at verification time', async () => {
    await registerMerchant({ countryCode: '+91', phone: '9876543226' });
    await Merchant.updateOne({ phoneE164: '+919876543226' }, { $set: { status: 'suspended' } });

    const { otpId, code } = await requestOtp('+91', '9876543226');
    const response = await request(app()).post(`${API}/auth/otp/verify`).send({ otpId, code });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });
});
