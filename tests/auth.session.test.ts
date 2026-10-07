import request from 'supertest';
import { Session } from '../src/models/Session';
import { API, app, registerMerchant } from './helpers';

describe('session lifecycle', () => {
  it('exchanges a refresh token for a new pair and rotates the old one out', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9833300001' });

    const refreshed = await request(app())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: merchant.refreshToken });

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.tokens.accessToken).toBeTruthy();
    expect(refreshed.body.data.tokens.refreshToken).not.toBe(merchant.refreshToken);

    const me = await request(app())
      .get(`${API}/merchants/me`)
      .set('authorization', `Bearer ${refreshed.body.data.tokens.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('treats a replayed refresh token as a compromise and ends the session', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9833300002' });

    const first = await request(app()).post(`${API}/auth/refresh`).send({ refreshToken: merchant.refreshToken });
    expect(first.status).toBe(200);

    // Replaying the original token must not work.
    const replay = await request(app()).post(`${API}/auth/refresh`).send({ refreshToken: merchant.refreshToken });
    expect(replay.status).toBe(401);

    // And the session it belonged to is now revoked, so the newer token is dead too.
    const afterRevocation = await request(app())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: first.body.data.tokens.refreshToken });
    expect(afterRevocation.status).toBe(401);

    const session = await Session.findOne({ subjectType: 'merchant' });
    expect(session?.revokedReason).toBe('refresh_token_reuse');
  });

  it('logs out of the current device and invalidates its tokens', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9833300003' });
    const auth = `Bearer ${merchant.accessToken}`;

    const loggedOut = await request(app()).post(`${API}/auth/logout`).set('authorization', auth);
    expect(loggedOut.status).toBe(200);
    expect(loggedOut.body.data.loggedOut).toBe(true);

    const afterLogout = await request(app()).get(`${API}/merchants/me`).set('authorization', auth);
    expect(afterLogout.status).toBe(401);

    const refreshAfterLogout = await request(app())
      .post(`${API}/auth/refresh`)
      .send({ refreshToken: merchant.refreshToken });
    expect(refreshAfterLogout.status).toBe(401);
  });

  it('does not accept a merchant refresh token on the admin refresh endpoint', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9833300004' });

    const response = await request(app())
      .post(`${API}/admin/auth/refresh`)
      .send({ refreshToken: merchant.refreshToken });

    expect(response.status).toBe(401);
  });

  it('does not accept a merchant access token on an admin endpoint', async () => {
    const merchant = await registerMerchant({ countryCode: '+91', phone: '9833300005' });

    const response = await request(app())
      .get(`${API}/admin/merchants`)
      .set('authorization', `Bearer ${merchant.accessToken}`);

    expect(response.status).toBe(401);
  });
});

describe('API surface basics', () => {
  it('reports liveness', async () => {
    const response = await request(app()).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
  });

  it('returns a structured not-found error with a request id', async () => {
    const response = await request(app()).get(`${API}/does-not-exist`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.requestId).toBeTruthy();
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('never leaks a stack trace in an error response', async () => {
    const response = await request(app()).post(`${API}/auth/otp/request`).send({});

    expect(response.status).toBe(422);
    expect(JSON.stringify(response.body)).not.toMatch(/at .+\(.+:\d+:\d+\)/);
    expect(response.body.error.stack).toBeUndefined();
  });
});
