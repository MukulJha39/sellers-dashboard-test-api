import request from 'supertest';
import { PERMISSIONS } from '../src/config/permissions';
import { Admin } from '../src/models/Admin';
import { AuditLog } from '../src/models/AuditLog';
import { Role } from '../src/models/Role';
import { API, app, auth, seedRbac, signInAdmin } from './helpers';

const PASSWORD = 'TestAdminPass#123';

describe('audit log filtering', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('narrows to what one account did, which is not the same as what was done to it', async () => {
    const owner = await signInAdmin();
    const finance = await signInAdmin('finance@sellersdash.local', PASSWORD);

    // Both signed in, so both have an entry naming themselves as the actor.
    const mine = await request(app())
      .get(`${API}/admin/audit-logs?actorId=${owner.admin.id}`)
      .set(...auth(owner.accessToken));

    expect(mine.status).toBe(200);
    expect(mine.body.data.items.length).toBeGreaterThan(0);
    expect(
      mine.body.data.items.every((entry: { actorLabel: string }) =>
        entry.actorLabel.includes(owner.admin.email),
      ),
    ).toBe(true);
    expect(
      mine.body.data.items.some((entry: { actorLabel: string }) =>
        entry.actorLabel.includes(finance.admin.email),
      ),
    ).toBe(false);

    // Unfiltered, both are present.
    const all = await request(app())
      .get(`${API}/admin/audit-logs`)
      .set(...auth(owner.accessToken));
    const actors = new Set(all.body.data.items.map((entry: { actorLabel: string }) => entry.actorLabel));
    expect(actors.size).toBeGreaterThan(1);
  });

  it('rejects an actorId that is not an id', async () => {
    const { accessToken } = await signInAdmin();
    const response = await request(app())
      .get(`${API}/admin/audit-logs?actorId=not-an-id`)
      .set(...auth(accessToken));
    expect(response.status).toBe(422);
  });
});

describe('admin seed data', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('seeds five roles with genuinely different permission levels', async () => {
    const roles = await Role.find().sort({ createdAt: 1 });
    const slugs = roles.map((role) => role.slug);

    expect(slugs).toEqual([
      'super_admin',
      'operations_admin',
      'support_admin',
      'finance_admin',
      'readonly_admin',
    ]);

    const bySlug = new Map(roles.map((role) => [role.slug, role]));
    const superAdmin = bySlug.get('super_admin');
    const readOnly = bySlug.get('readonly_admin');
    const finance = bySlug.get('finance_admin');

    expect(superAdmin?.permissions).toContain(PERMISSIONS.ROLE_MANAGE);
    expect(readOnly?.permissions).not.toContain(PERMISSIONS.MERCHANT_EDIT);
    expect(readOnly?.permissions.every((permission) => permission.endsWith('.view'))).toBe(true);
    expect(finance?.permissions).toContain(PERMISSIONS.PAYMENT_MANAGE);
    expect(finance?.permissions).not.toContain(PERMISSIONS.ITEM_MANAGE);
    expect(roles.every((role) => role.isSystem)).toBe(true);
  });

  it('seeds one admin per role and stores passwords as bcrypt hashes only', async () => {
    const admins = await Admin.find().select('+passwordHash');
    expect(admins).toHaveLength(5);

    for (const admin of admins) {
      expect(admin.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
      expect(admin.passwordHash).not.toContain(PASSWORD);
    }

    expect(admins.map((admin) => admin.toJSON()).every((json) => !('passwordHash' in json))).toBe(true);
  });

  it('is idempotent and does not reset existing passwords', async () => {
    await seedRbac();

    expect(await Role.countDocuments()).toBe(5);
    expect(await Admin.countDocuments()).toBe(5);

    const signedIn = await signInAdmin();
    expect(signedIn.admin.role.slug).toBe('super_admin');
  });
});

describe('POST /admin/auth/login', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('signs in a super admin and returns the role with its permissions', async () => {
    const response = await request(app())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@sellersdash.local', password: PASSWORD });

    expect(response.status).toBe(200);
    expect(response.body.data.admin.role.slug).toBe('super_admin');
    expect(response.body.data.admin.permissions).toContain(PERMISSIONS.MERCHANT_VIEW);
    expect(response.body.data.admin.passwordHash).toBeUndefined();
    expect(response.body.data.tokens.accessToken).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'admin@sellersdash.local', password: 'NotThePassword#1' });
    const unknownEmail = await request(app())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'nobody@sellersdash.local', password: PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('refuses a suspended admin without revealing why', async () => {
    await Admin.updateOne({ email: 'support@sellersdash.local' }, { $set: { status: 'suspended' } });

    const response = await request(app())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'support@sellersdash.local', password: PASSWORD });

    expect(response.status).toBe(401);
    expect(response.body.error.message).toBe('Those sign-in details are not correct.');
  });

  it('records the sign-in in the audit trail', async () => {
    await signInAdmin();

    const entry = await AuditLog.findOne({ action: 'admin.signed_in' });
    expect(entry).not.toBeNull();
    expect(entry?.actorType).toBe('admin');
    expect(entry?.summary).toContain('Super administrator');
  });

  it('returns the signed-in admin from /admin/auth/me and ends the session on logout', async () => {
    const session = await signInAdmin();
    const auth = `Bearer ${session.accessToken}`;

    const me = await request(app()).get(`${API}/admin/auth/me`).set('authorization', auth);
    expect(me.status).toBe(200);
    expect(me.body.data.admin.email).toBe('admin@sellersdash.local');

    const loggedOut = await request(app()).post(`${API}/admin/auth/logout`).set('authorization', auth);
    expect(loggedOut.status).toBe(200);

    const afterLogout = await request(app()).get(`${API}/admin/auth/me`).set('authorization', auth);
    expect(afterLogout.status).toBe(401);
  });
});

describe('permission enforcement is server-side', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('lets a read-only admin list merchants but refuses every write', async () => {
    const readOnly = await signInAdmin('readonly@sellersdash.local', PASSWORD);
    const auth = `Bearer ${readOnly.accessToken}`;

    const list = await request(app()).get(`${API}/admin/merchants`).set('authorization', auth);
    expect(list.status).toBe(200);

    const edit = await request(app())
      .patch(`${API}/admin/merchants/0123456789abcdef01234567`)
      .set('authorization', auth)
      .send({ firstName: 'Nope' });
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe('FORBIDDEN');

    const suspend = await request(app())
      .patch(`${API}/admin/merchants/0123456789abcdef01234567/status`)
      .set('authorization', auth)
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(403);
  });

  it('refuses the audit trail to roles without audit.view', async () => {
    for (const email of ['support@sellersdash.local', 'readonly@sellersdash.local']) {
      const session = await signInAdmin(email, PASSWORD);

      const response = await request(app())
        .get(`${API}/admin/audit-logs`)
        .set('authorization', `Bearer ${session.accessToken}`);

      expect(response.status).toBe(403);
    }
  });

  it('allows the audit trail for finance, which does hold audit.view', async () => {
    const finance = await signInAdmin('finance@sellersdash.local', PASSWORD);

    const response = await request(app())
      .get(`${API}/admin/audit-logs`)
      .set('authorization', `Bearer ${finance.accessToken}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data.items)).toBe(true);
  });

  it('refuses the role matrix to a role without role.view', async () => {
    const finance = await signInAdmin('finance@sellersdash.local', PASSWORD);
    const superAdmin = await signInAdmin();

    const refused = await request(app())
      .get(`${API}/admin/roles`)
      .set('authorization', `Bearer ${finance.accessToken}`);
    expect(refused.status).toBe(403);

    const allowed = await request(app())
      .get(`${API}/admin/roles`)
      .set('authorization', `Bearer ${superAdmin.accessToken}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.roles).toHaveLength(5);
    expect(allowed.body.data.permissionGroups.length).toBeGreaterThan(5);
  });

  it('requires authentication for every admin data endpoint', async () => {
    for (const path of ['/admin/merchants', '/admin/roles', '/admin/audit-logs', '/admin/auth/me']) {
      const response = await request(app()).get(`${API}${path}`);
      expect(response.status).toBe(401);
    }
  });
});
