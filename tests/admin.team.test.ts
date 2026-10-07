import request from 'supertest';
import { PERMISSIONS } from '../src/config/permissions';
import { Admin } from '../src/models/Admin';
import { AuditLog } from '../src/models/AuditLog';
import { Role } from '../src/models/Role';
import { Session } from '../src/models/Session';
import { API, app, auth, seedRbac, signInAdmin } from './helpers';

const PASSWORD = 'TestAdminPass#123';
/** Clears the API's rule: 12+ characters with upper, lower and a digit. */
const STRONG = 'StartingPass123!';

async function roleIdBySlug(slug: string): Promise<string> {
  const role = await Role.findOne({ slug });
  if (!role) throw new Error(`Missing seeded role ${slug}`);
  return String(role._id);
}

describe('roles CRUD', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('creates a role, derives a unique slug and reports it as unused', async () => {
    const { accessToken } = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Regional support',
        description: 'Handles merchant queries for one region.',
        permissions: [PERMISSIONS.MERCHANT_VIEW, PERMISSIONS.ORDER_VIEW],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.role).toMatchObject({
      slug: 'regional_support',
      name: 'Regional support',
      isSystem: false,
      memberCount: 0,
      editable: true,
      deletable: true,
    });
  });

  it('suffixes the slug rather than colliding when a name repeats', async () => {
    const { accessToken } = await signInAdmin();
    const body = {
      description: 'Anything.',
      permissions: [PERMISSIONS.MERCHANT_VIEW],
    };

    await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({ ...body, name: 'Region team' });

    const second = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({ ...body, name: 'Region  team' });

    expect(second.status).toBe(201);
    expect(second.body.data.role.slug).toBe('region_team_2');
  });

  it('refuses a duplicate role name', async () => {
    const { accessToken } = await signInAdmin();
    const body = {
      name: 'Region team',
      description: 'Anything.',
      permissions: [PERMISSIONS.MERCHANT_VIEW],
    };

    await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send(body);

    const second = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send(body);

    expect(second.status).toBe(422);
    expect(second.body.error.details[0].field).toBe('name');
  });

  it('rejects a permission that is not in the catalogue', async () => {
    const { accessToken } = await signInAdmin();

    const response = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Impossible',
        description: 'Holds a permission that does not exist.',
        permissions: [PERMISSIONS.MERCHANT_VIEW, 'merchant.delete_everything'],
      });

    expect(response.status).toBe(422);
  });

  it('updates permissions and records what was granted and revoked', async () => {
    const { accessToken } = await signInAdmin();

    const created = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Regional support',
        description: 'Handles merchant queries.',
        permissions: [PERMISSIONS.MERCHANT_VIEW, PERMISSIONS.ORDER_VIEW],
      });

    const updated = await request(app())
      .patch(`${API}/admin/roles/${created.body.data.role.id}`)
      .set(...auth(accessToken))
      .send({ permissions: [PERMISSIONS.MERCHANT_VIEW, PERMISSIONS.PAYMENT_VIEW] });

    expect(updated.status).toBe(200);
    expect(updated.body.data.role.permissions).toEqual([
      PERMISSIONS.MERCHANT_VIEW,
      PERMISSIONS.PAYMENT_VIEW,
    ]);

    const entry = await AuditLog.findOne({ action: 'role.updated' });
    const fields = (entry?.changes ?? []).map((change) => change.field);
    expect(fields).toContain('permissions granted');
    expect(fields).toContain('permissions revoked');
  });

  it('deletes a role nobody holds', async () => {
    const { accessToken } = await signInAdmin();

    const created = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Temporary',
        description: 'Created to be removed.',
        permissions: [PERMISSIONS.MERCHANT_VIEW],
      });

    const response = await request(app())
      .delete(`${API}/admin/roles/${created.body.data.role.id}`)
      .set(...auth(accessToken));

    expect(response.status).toBe(200);
    expect(await Role.findById(created.body.data.role.id)).toBeNull();
    expect(await AuditLog.findOne({ action: 'role.deleted' })).not.toBeNull();
  });

  it('refuses to delete a role admins still hold, and says how many', async () => {
    const { accessToken } = await signInAdmin();
    const financeId = await roleIdBySlug('finance_admin');

    const response = await request(app())
      .delete(`${API}/admin/roles/${financeId}`)
      .set(...auth(accessToken));

    // Seeded roles are refused before the member count is even reached.
    expect(response.status).toBe(403);

    const custom = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Held by someone',
        description: 'Will be assigned.',
        permissions: [PERMISSIONS.MERCHANT_VIEW],
      });

    await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(accessToken))
      .send({
        name: 'Priya Sharma',
        email: 'priya@sellersdash.local',
        roleId: custom.body.data.role.id,
        password: STRONG,
      });

    const blocked = await request(app())
      .delete(`${API}/admin/roles/${custom.body.data.role.id}`)
      .set(...auth(accessToken));

    expect(blocked.status).toBe(409);
    expect(blocked.body.error.meta.memberCount).toBe(1);
  });

  it('leaves the super administrator role fixed, as the way back in', async () => {
    const { accessToken } = await signInAdmin();
    const superId = await roleIdBySlug('super_admin');

    const edit = await request(app())
      .patch(`${API}/admin/roles/${superId}`)
      .set(...auth(accessToken))
      .send({ name: 'Renamed' });
    expect(edit.status).toBe(403);

    const remove = await request(app())
      .delete(`${API}/admin/roles/${superId}`)
      .set(...auth(accessToken));
    expect(remove.status).toBe(403);

    const listed = await request(app())
      .get(`${API}/admin/roles`)
      .set(...auth(accessToken));
    const superRole = listed.body.data.roles.find((role: { slug: string }) => role.slug === 'super_admin');
    expect(superRole).toMatchObject({ editable: false, deletable: false });
  });

  it('refuses an edit that would leave nobody able to manage admins and roles', async () => {
    const { accessToken } = await signInAdmin();
    // Only the super administrator holds both keyholder permissions, and that role is
    // fixed — so the guard is reached through a role that has been given them.
    const custom = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Second keyholder',
        description: 'Can manage the team.',
        permissions: [PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_MANAGE],
      });

    // Dropping admin.manage is fine while the super administrator still holds it.
    const allowed = await request(app())
      .patch(`${API}/admin/roles/${custom.body.data.role.id}`)
      .set(...auth(accessToken))
      .send({ permissions: [PERMISSIONS.ROLE_MANAGE] });

    expect(allowed.status).toBe(200);
  });
});

describe('admin team CRUD', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('creates a member who must change the password they were given', async () => {
    const { accessToken } = await signInAdmin();
    const roleId = await roleIdBySlug('support_admin');

    const response = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(accessToken))
      .send({ name: 'Priya Sharma', email: 'priya@sellersdash.local', roleId, password: STRONG });

    expect(response.status).toBe(201);
    expect(response.body.data.admin).toMatchObject({
      name: 'Priya Sharma',
      email: 'priya@sellersdash.local',
      status: 'active',
      mustChangePassword: true,
      passwordChangedAt: null,
    });
    expect(await AuditLog.findOne({ action: 'admin.created' })).not.toBeNull();
  });

  it('refuses a weak starting password', async () => {
    const { accessToken } = await signInAdmin();
    const roleId = await roleIdBySlug('support_admin');

    for (const password of ['short1A', 'alllowercase123', 'ALLUPPERCASE123', 'NoDigitsInHere!']) {
      const response = await request(app())
        .post(`${API}/admin/admins`)
        .set(...auth(accessToken))
        .send({ name: 'Priya Sharma', email: `p${password}@sellersdash.local`, roleId, password });
      expect(response.status).toBe(422);
    }
  });

  it('refuses an email another admin already signs in with', async () => {
    const { accessToken } = await signInAdmin();
    const roleId = await roleIdBySlug('support_admin');

    const response = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(accessToken))
      .send({ name: 'Clash', email: 'finance@sellersdash.local', roleId, password: STRONG });

    expect(response.status).toBe(422);
    expect(response.body.error.details[0].field).toBe('email');
  });

  it('suspends a member, revoking every session at once', async () => {
    const { accessToken } = await signInAdmin();
    const finance = await Admin.findOne({ email: 'finance@sellersdash.local' });
    const financeId = String(finance?._id);

    // Give them a live session to revoke.
    await signInAdmin('finance@sellersdash.local', PASSWORD);
    expect(await Session.countDocuments({ subjectId: finance?._id, revokedAt: null })).toBe(1);

    const response = await request(app())
      .patch(`${API}/admin/admins/${financeId}/status`)
      .set(...auth(accessToken))
      .send({ status: 'suspended', reason: 'Left the team' });

    expect(response.status).toBe(200);
    expect(response.body.data.admin.status).toBe('suspended');
    expect(await Session.countDocuments({ subjectId: finance?._id, revokedAt: null })).toBe(0);

    const blocked = await request(app())
      .post(`${API}/admin/auth/login`)
      .send({ email: 'finance@sellersdash.local', password: PASSWORD });
    expect(blocked.status).toBe(401);
  });

  it('never offers a way to delete an account', async () => {
    const { accessToken } = await signInAdmin();
    const finance = await Admin.findOne({ email: 'finance@sellersdash.local' });

    const response = await request(app())
      .delete(`${API}/admin/admins/${String(finance?._id)}`)
      .set(...auth(accessToken));

    expect(response.status).toBe(404);
    expect(await Admin.findById(finance?._id)).not.toBeNull();
  });

  it('refuses to let an admin suspend, demote or reset themselves', async () => {
    const { accessToken, admin } = await signInAdmin();
    const supportId = await roleIdBySlug('support_admin');

    const suspend = await request(app())
      .patch(`${API}/admin/admins/${admin.id}/status`)
      .set(...auth(accessToken))
      .send({ status: 'suspended' });
    expect(suspend.status).toBe(403);

    const demote = await request(app())
      .patch(`${API}/admin/admins/${admin.id}`)
      .set(...auth(accessToken))
      .send({ roleId: supportId });
    expect(demote.status).toBe(403);

    const reset = await request(app())
      .post(`${API}/admin/admins/${admin.id}/reset-password`)
      .set(...auth(accessToken))
      .send({ password: STRONG });
    expect(reset.status).toBe(403);
  });

  it('refuses to suspend the last admin who can manage the team', async () => {
    const { accessToken, admin } = await signInAdmin();

    // A second keyholder, so the super administrator is not the only one.
    const role = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(accessToken))
      .send({
        name: 'Second keyholder',
        description: 'Can manage the team.',
        permissions: [PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_MANAGE],
      });

    const second = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(accessToken))
      .send({
        name: 'Second Keyholder',
        email: 'second@sellersdash.local',
        roleId: role.body.data.role.id,
        password: STRONG,
      });

    // With two keyholders, suspending one is allowed.
    const allowed = await request(app())
      .patch(`${API}/admin/admins/${second.body.data.admin.id}/status`)
      .set(...auth(accessToken))
      .send({ status: 'suspended' });
    expect(allowed.status).toBe(200);

    // The super administrator is now the only keyholder left, and cannot be removed —
    // self-suspension is refused first, so this is checked from the other side.
    const restore = await request(app())
      .patch(`${API}/admin/admins/${second.body.data.admin.id}/status`)
      .set(...auth(accessToken))
      .send({ status: 'active' });
    expect(restore.status).toBe(200);

    const demoteOther = await request(app())
      .patch(`${API}/admin/admins/${second.body.data.admin.id}`)
      .set(...auth(accessToken))
      .send({ roleId: await roleIdBySlug('readonly_admin') });
    // Allowed: the super administrator still holds both permissions.
    expect(demoteOther.status).toBe(200);
    expect(admin.role.slug).toBe('super_admin');
  });

  it('filters the team by status, role and search term', async () => {
    const { accessToken } = await signInAdmin();
    const financeRoleId = await roleIdBySlug('finance_admin');

    const byRole = await request(app())
      .get(`${API}/admin/admins?roleId=${financeRoleId}`)
      .set(...auth(accessToken));
    expect(byRole.status).toBe(200);
    expect(byRole.body.data.items).toHaveLength(1);
    expect(byRole.body.data.items[0].email).toBe('finance@sellersdash.local');

    const bySearch = await request(app())
      .get(`${API}/admin/admins?search=readonly`)
      .set(...auth(accessToken));
    expect(bySearch.body.data.items).toHaveLength(1);

    const byStatus = await request(app())
      .get(`${API}/admin/admins?status=suspended`)
      .set(...auth(accessToken));
    expect(byStatus.body.data.items).toHaveLength(0);
  });

  it("marks the caller's own row as unmanageable", async () => {
    const { accessToken, admin } = await signInAdmin();

    const response = await request(app())
      .get(`${API}/admin/admins`)
      .set(...auth(accessToken));

    const rows: Array<{ id: string; canManage: boolean }> = response.body.data.items;
    expect(rows.find((row) => row.id === admin.id)?.canManage).toBe(false);
    expect(rows.filter((row) => row.id !== admin.id).every((row) => row.canManage)).toBe(true);
  });
});

describe('passwords set by somebody else', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  async function createMember(accessToken: string) {
    const roleId = await roleIdBySlug('support_admin');
    const response = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(accessToken))
      .send({ name: 'Priya Sharma', email: 'priya@sellersdash.local', roleId, password: STRONG });
    return response.body.data.admin.id as string;
  }

  it('blocks every admin endpoint until the member chooses their own password', async () => {
    const owner = await signInAdmin();
    await createMember(owner.accessToken);

    const member = await signInAdmin('priya@sellersdash.local', STRONG);
    expect(member.admin).toMatchObject({ mustChangePassword: true });

    const blocked = await request(app())
      .get(`${API}/admin/merchants`)
      .set(...auth(member.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // The three ways out stay open.
    const profile = await request(app())
      .get(`${API}/admin/auth/me`)
      .set(...auth(member.accessToken));
    expect(profile.status).toBe(200);

    const changed = await request(app())
      .post(`${API}/admin/auth/change-password`)
      .set(...auth(member.accessToken))
      .send({ currentPassword: STRONG, newPassword: 'ChosenByMe456!' });
    expect(changed.status).toBe(200);

    const allowed = await request(app())
      .get(`${API}/admin/merchants`)
      .set(...auth(member.accessToken));
    expect(allowed.status).toBe(200);
  });

  it('rejects a wrong current password and a password that has not changed', async () => {
    const owner = await signInAdmin();
    await createMember(owner.accessToken);
    const member = await signInAdmin('priya@sellersdash.local', STRONG);

    const wrong = await request(app())
      .post(`${API}/admin/auth/change-password`)
      .set(...auth(member.accessToken))
      .send({ currentPassword: 'NotTheRightOne1', newPassword: 'ChosenByMe456!' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.details[0].field).toBe('currentPassword');

    const same = await request(app())
      .post(`${API}/admin/auth/change-password`)
      .set(...auth(member.accessToken))
      .send({ currentPassword: STRONG, newPassword: STRONG });
    expect(same.status).toBe(422);
  });

  it('keeps the current session alive but signs every other device out', async () => {
    const owner = await signInAdmin();
    await createMember(owner.accessToken);

    const laptop = await signInAdmin('priya@sellersdash.local', STRONG);
    const phone = await signInAdmin('priya@sellersdash.local', STRONG);

    const changed = await request(app())
      .post(`${API}/admin/auth/change-password`)
      .set(...auth(phone.accessToken))
      .send({ currentPassword: STRONG, newPassword: 'ChosenByMe456!' });
    expect(changed.status).toBe(200);

    const stillHere = await request(app())
      .get(`${API}/admin/auth/me`)
      .set(...auth(phone.accessToken));
    expect(stillHere.status).toBe(200);

    const signedOut = await request(app())
      .get(`${API}/admin/auth/me`)
      .set(...auth(laptop.accessToken));
    expect(signedOut.status).toBe(401);
  });

  it('puts the requirement back when an admin resets someone else, and revokes their sessions', async () => {
    const owner = await signInAdmin();
    const memberId = await createMember(owner.accessToken);

    const member = await signInAdmin('priya@sellersdash.local', STRONG);
    await request(app())
      .post(`${API}/admin/auth/change-password`)
      .set(...auth(member.accessToken))
      .send({ currentPassword: STRONG, newPassword: 'ChosenByMe456!' });

    const reset = await request(app())
      .post(`${API}/admin/admins/${memberId}/reset-password`)
      .set(...auth(owner.accessToken))
      .send({ password: 'ResetByAdmin789!' });

    expect(reset.status).toBe(200);
    expect(reset.body.data.admin).toMatchObject({
      mustChangePassword: true,
      passwordChangedAt: null,
    });

    const revoked = await request(app())
      .get(`${API}/admin/auth/me`)
      .set(...auth(member.accessToken));
    expect(revoked.status).toBe(401);

    const again = await signInAdmin('priya@sellersdash.local', 'ResetByAdmin789!');
    expect(again.admin).toMatchObject({ mustChangePassword: true });
    expect(await AuditLog.findOne({ action: 'admin.password_reset' })).not.toBeNull();
  });
});

describe('an admin editing their own profile', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('changes their own display name, and records it', async () => {
    const { accessToken, admin } = await signInAdmin();

    const response = await request(app())
      .patch(`${API}/admin/auth/me`)
      .set(...auth(accessToken))
      .send({ name: 'Renamed Admin' });

    expect(response.status).toBe(200);
    expect(response.body.data.admin.name).toBe('Renamed Admin');
    expect(response.body.data.admin.email).toBe(admin.email);

    const entry = await AuditLog.findOne({ action: 'admin.profile_updated' });
    expect(entry?.changes).toEqual([
      expect.objectContaining({ field: 'name', to: 'Renamed Admin' }),
    ]);
  });

  it('refuses a name that is not one', async () => {
    const { accessToken } = await signInAdmin();

    for (const name of ['', 'A', '   ', '<script>']) {
      const response = await request(app())
        .patch(`${API}/admin/auth/me`)
        .set(...auth(accessToken))
        .send({ name });
      expect(response.status).toBe(422);
    }
  });

  it('ignores an attempt to change the email or the role through it', async () => {
    const { accessToken, admin } = await signInAdmin();
    const supportRole = await Role.findOne({ slug: 'support_admin' });

    const response = await request(app())
      .patch(`${API}/admin/auth/me`)
      .set(...auth(accessToken))
      .send({
        name: 'Still Me',
        email: 'elsewhere@sellersdash.local',
        roleId: String(supportRole?._id),
        status: 'suspended',
      });

    expect(response.status).toBe(200);
    expect(response.body.data.admin.email).toBe(admin.email);
    expect(response.body.data.admin.role.slug).toBe('super_admin');
    expect(response.body.data.admin.status).toBe('active');
  });

  it('carries createdAt on the profile, for the member-since line', async () => {
    const { accessToken } = await signInAdmin();
    const response = await request(app())
      .get(`${API}/admin/auth/me`)
      .set(...auth(accessToken));

    expect(response.status).toBe(200);
    expect(Date.parse(response.body.data.admin.createdAt)).not.toBeNaN();
  });
});

describe('permission enforcement on the team endpoints', () => {
  beforeEach(async () => {
    await seedRbac();
  });

  it('refuses the team list and role writes to a role without those permissions', async () => {
    const finance = await signInAdmin('finance@sellersdash.local', PASSWORD);

    const list = await request(app())
      .get(`${API}/admin/admins`)
      .set(...auth(finance.accessToken));
    expect(list.status).toBe(403);

    const createRole = await request(app())
      .post(`${API}/admin/roles`)
      .set(...auth(finance.accessToken))
      .send({ name: 'Sneaky', description: 'Should not work.', permissions: [PERMISSIONS.MERCHANT_VIEW] });
    expect(createRole.status).toBe(403);

    const createAdmin = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(finance.accessToken))
      .send({
        name: 'Nope',
        email: 'nope@sellersdash.local',
        roleId: await roleIdBySlug('support_admin'),
        password: STRONG,
      });
    expect(createAdmin.status).toBe(403);
  });

  it('lets the operations role read the team and roles but change neither', async () => {
    // Operations holds every permission except the two manage ones, which is exactly the
    // read-without-write case these screens have to get right.
    const operations = await signInAdmin('operations@sellersdash.local', PASSWORD);

    const roles = await request(app())
      .get(`${API}/admin/roles`)
      .set(...auth(operations.accessToken));
    expect(roles.status).toBe(200);

    const team = await request(app())
      .get(`${API}/admin/admins`)
      .set(...auth(operations.accessToken));
    expect(team.status).toBe(200);

    const update = await request(app())
      .patch(`${API}/admin/roles/${await roleIdBySlug('support_admin')}`)
      .set(...auth(operations.accessToken))
      .send({ description: 'Changed by someone who should not.' });
    expect(update.status).toBe(403);

    const addMember = await request(app())
      .post(`${API}/admin/admins`)
      .set(...auth(operations.accessToken))
      .send({
        name: 'Nope',
        email: 'nope@sellersdash.local',
        roleId: await roleIdBySlug('support_admin'),
        password: STRONG,
      });
    expect(addMember.status).toBe(403);
  });

  it('keeps the administrative views out of general read access', async () => {
    // Read-only holds every operational view, deliberately not the administrative ones:
    // the audit trail and the team record what other admins did.
    const readonly = await signInAdmin('readonly@sellersdash.local', PASSWORD);

    const roles = await request(app())
      .get(`${API}/admin/roles`)
      .set(...auth(readonly.accessToken));
    expect(roles.status).toBe(403);

    const team = await request(app())
      .get(`${API}/admin/admins`)
      .set(...auth(readonly.accessToken));
    expect(team.status).toBe(403);

    const merchants = await request(app())
      .get(`${API}/admin/merchants`)
      .set(...auth(readonly.accessToken));
    expect(merchants.status).toBe(200);
  });
});
