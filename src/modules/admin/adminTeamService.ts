import type { Request } from 'express';
import { Types } from 'mongoose';
import { PERMISSIONS, type Permission } from '../../config/permissions';
import { Admin, type AdminDocument, type AdminStatus } from '../../models/Admin';
import { Role, type RoleDocument } from '../../models/Role';
import { diffFields, writeAudit } from '../../services/auditService';
import { revokeAllSessions } from '../../services/sessionService';
import { AppError, ErrorCode } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import type { AuthenticatedAdmin } from '../../types/express';

/**
 * The admin team: who can sign in to this panel, and as what.
 *
 * Accounts are never deleted. An admin who leaves is suspended, which revokes their
 * sessions immediately and keeps every audit entry they left behind pointing at a real
 * account — a deleted row would turn years of history into orphaned names (PRD section 27).
 *
 * Two guards hold throughout, and both are enforced here rather than in the panel:
 *   - nobody may suspend themselves or change their own role, so one mistake cannot take
 *     away the access needed to undo it;
 *   - no change may leave the platform without an active admin who can still manage the
 *     team and the roles.
 */

export const ADMIN_SORT_FIELDS = ['createdAt', 'updatedAt', 'name', 'email', 'lastLoginAt'] as const;

/** Holding both is what makes an account able to repair the team. */
const KEYHOLDER_PERMISSIONS: Permission[] = [PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_MANAGE];

export interface AdminMemberView {
  id: string;
  name: string;
  email: string;
  status: AdminStatus;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  role: { id: string; slug: string; name: string };
  createdAt: string;
  updatedAt: string;
  /** False for the signed-in admin's own row: self-service is not team management. */
  canManage: boolean;
}

export interface AdminListFilters {
  search?: string;
  status?: AdminStatus;
  roleId?: string;
}

function adminObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('That admin was not found.');
  return new Types.ObjectId(id);
}

function present(admin: AdminDocument, role: RoleDocument | null, actorId: string): AdminMemberView {
  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    status: admin.status,
    mustChangePassword: admin.mustChangePassword,
    lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
    passwordChangedAt: admin.passwordChangedAt ? admin.passwordChangedAt.toISOString() : null,
    role: role
      ? { id: String(role._id), slug: role.slug, name: role.name }
      : { id: String(admin.roleId), slug: 'unknown', name: 'Missing role' },
    createdAt: admin.createdAt.toISOString(),
    updatedAt: admin.updatedAt.toISOString(),
    canManage: String(admin._id) !== actorId,
  };
}

async function loadRole(roleId: Types.ObjectId | string): Promise<RoleDocument> {
  const role = Types.ObjectId.isValid(String(roleId)) ? await Role.findById(roleId) : null;
  if (!role) {
    throw AppError.validation('That role was not found.', [
      { field: 'roleId', message: 'Choose a role from the list.' },
    ]);
  }
  return role;
}

/**
 * Refuses a change that would leave nobody able to manage the team and the roles.
 *
 * `excludeId` is the account the change is about: it is counted out, and whether it still
 * qualifies afterwards is decided by `nextRole` (null when it is being suspended).
 */
async function assertKeyholderRemains(
  excludeId: Types.ObjectId,
  nextRole: RoleDocument | null,
): Promise<void> {
  const stillKeyholder =
    nextRole !== null && KEYHOLDER_PERMISSIONS.every((permission) => nextRole.permissions.includes(permission));
  if (stillKeyholder) return;

  const keyholderRoles = await Role.find({ permissions: { $all: KEYHOLDER_PERMISSIONS } })
    .select('_id')
    .lean();

  const remaining = await Admin.countDocuments({
    _id: { $ne: excludeId },
    status: 'active',
    roleId: { $in: keyholderRoles.map((role) => role._id) },
  });

  if (remaining === 0) {
    throw AppError.conflict(
      'This is the last active admin who can manage admins and roles. Give someone else that access first.',
    );
  }
}

/** Self-service is not team management: an admin cannot act on their own row here. */
function assertNotSelf(actor: AuthenticatedAdmin, targetId: Types.ObjectId, action: string): void {
  if (String(targetId) !== actor.id) return;
  throw AppError.forbidden(
    `You cannot ${action} your own account. Ask another administrator to do it.`,
  );
}

/* ---------------------------------- reads ---------------------------------- */

export async function listAdmins(
  actor: AuthenticatedAdmin,
  filters: AdminListFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: AdminMemberView[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filters.status) query.status = filters.status;
  if (filters.roleId && Types.ObjectId.isValid(filters.roleId)) {
    query.roleId = new Types.ObjectId(filters.roleId);
  }

  if (filters.search) {
    const term = escapeRegex(filters.search.trim());
    if (term) {
      const pattern = new RegExp(term, 'i');
      query.$or = [{ name: pattern }, { email: pattern }];
    }
  }

  const [documents, total] = await Promise.all([
    Admin.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Admin.countDocuments(query),
  ]);

  const roles = await Role.find({ _id: { $in: documents.map((doc) => doc.roleId) } });
  const roleById = new Map(roles.map((role) => [String(role._id), role]));

  return {
    items: documents.map((doc) => present(doc, roleById.get(String(doc.roleId)) ?? null, actor.id)),
    total,
  };
}

export async function getAdmin(actor: AuthenticatedAdmin, id: string): Promise<AdminMemberView> {
  const admin = await Admin.findById(adminObjectId(id));
  if (!admin) throw AppError.notFound('That admin was not found.');
  const role = await Role.findById(admin.roleId);
  return present(admin, role, actor.id);
}

/* --------------------------------- writes --------------------------------- */

/**
 * Creates a team member with a password their creator chose.
 *
 * That password is a way in, not a credential: `mustChangePassword` is set, and until the
 * member replaces it they can reach nothing but their own profile and the change-password
 * endpoint.
 */
export async function createAdmin(
  actor: AuthenticatedAdmin,
  input: { name: string; email: string; roleId: string; password: string },
  req?: Request,
): Promise<AdminMemberView> {
  const email = input.email.toLowerCase().trim();

  const existing = await Admin.findOne({ email });
  if (existing) {
    throw AppError.validation('That email address is already in use.', [
      { field: 'email', message: 'Another admin already signs in with this address.' },
    ]);
  }

  const role = await loadRole(input.roleId);

  const admin = new Admin({
    name: input.name.trim(),
    email,
    roleId: role._id,
    status: 'active',
    mustChangePassword: true,
  });
  await admin.setPassword(input.password);
  await admin.save();

  await writeAudit({
    actorType: 'admin',
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
    action: 'admin.created',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${actor.name} added ${admin.name} (${admin.email}) to the admin team as ${role.name}.`,
    changes: [{ field: 'role', from: null, to: role.name }],
    req,
  });

  return present(admin, role, actor.id);
}

export async function updateAdmin(
  actor: AuthenticatedAdmin,
  id: string,
  input: { name?: string; email?: string; roleId?: string },
  req?: Request,
): Promise<AdminMemberView> {
  const admin = await Admin.findById(adminObjectId(id));
  if (!admin) throw AppError.notFound('That admin was not found.');

  const currentRole = await Role.findById(admin.roleId);
  const before = { name: admin.name, email: admin.email, role: currentRole?.name ?? 'Missing role' };

  if (input.name !== undefined) admin.name = input.name.trim();

  if (input.email !== undefined) {
    const email = input.email.toLowerCase().trim();
    if (email !== admin.email) {
      const clash = await Admin.findOne({ email, _id: { $ne: admin._id } });
      if (clash) {
        throw AppError.validation('That email address is already in use.', [
          { field: 'email', message: 'Another admin already signs in with this address.' },
        ]);
      }
      admin.email = email;
    }
  }

  let nextRole: RoleDocument | null = currentRole;
  if (input.roleId !== undefined && input.roleId !== String(admin.roleId)) {
    // Changing your own role is how an admin accidentally locks themselves out.
    assertNotSelf(actor, admin._id, 'change the role on');
    nextRole = await loadRole(input.roleId);
    await assertKeyholderRemains(admin._id, nextRole);
    admin.roleId = nextRole._id;
  }

  await admin.save();

  const changes = diffFields(
    before,
    { name: admin.name, email: admin.email, role: nextRole?.name ?? 'Missing role' },
    ['name', 'email', 'role'],
  );

  if (changes.length > 0) {
    await writeAudit({
      actorType: 'admin',
      actorId: actor.objectId,
      actorLabel: `${actor.name} (${actor.email})`,
      action: 'admin.updated',
      targetType: 'admin',
      targetId: admin._id,
      summary: `${actor.name} updated ${admin.name} (${changes.map((change) => change.field).join(', ')}).`,
      changes,
      req,
    });
  }

  return present(admin, nextRole, actor.id);
}

/**
 * Suspends or reactivates a member.
 *
 * Suspending revokes every session at once, so a signed-in tab stops working now rather
 * than whenever its access token happens to expire.
 */
export async function setAdminStatus(
  actor: AuthenticatedAdmin,
  id: string,
  status: AdminStatus,
  reason: string | null,
  req?: Request,
): Promise<AdminMemberView> {
  const admin = await Admin.findById(adminObjectId(id));
  if (!admin) throw AppError.notFound('That admin was not found.');

  const role = await Role.findById(admin.roleId);
  if (admin.status === status) return present(admin, role, actor.id);

  if (status === 'suspended') {
    assertNotSelf(actor, admin._id, 'suspend');
    await assertKeyholderRemains(admin._id, null);
  }

  const previous = admin.status;
  admin.status = status;
  await admin.save();

  let revokedSessions = 0;
  if (status === 'suspended') {
    revokedSessions = await revokeAllSessions('admin', admin._id, 'admin_suspended');
  }

  await writeAudit({
    actorType: 'admin',
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
    action: 'admin.status_changed',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${actor.name} changed ${admin.name}'s admin access from ${previous} to ${status}.`,
    changes: [{ field: 'status', from: previous, to: status }],
    metadata: { reason, revokedSessions },
    req,
  });

  return present(admin, role, actor.id);
}

/**
 * Sets a new password on someone else's account.
 *
 * Every session is revoked and `mustChangePassword` goes back on, so the password the
 * resetting admin just typed cannot keep working as that member's credential.
 */
export async function resetAdminPassword(
  actor: AuthenticatedAdmin,
  id: string,
  password: string,
  req?: Request,
): Promise<AdminMemberView> {
  const admin = await Admin.findById(adminObjectId(id));
  if (!admin) throw AppError.notFound('That admin was not found.');

  assertNotSelf(actor, admin._id, 'reset the password on');

  await admin.setPassword(password);
  admin.mustChangePassword = true;
  admin.passwordChangedAt = null;
  await admin.save();

  const revokedSessions = await revokeAllSessions('admin', admin._id, 'admin_password_reset');

  await writeAudit({
    actorType: 'admin',
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
    action: 'admin.password_reset',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${actor.name} reset the password for ${admin.name}, who must choose a new one at next sign-in.`,
    metadata: { revokedSessions },
    req,
  });

  const role = await Role.findById(admin.roleId);
  return present(admin, role, actor.id);
}

/**
 * An admin replacing their own password.
 *
 * Other sessions are revoked, because the usual reason to change a password is that the
 * old one is known to someone else. The current session survives, so the admin is not
 * signed out of the tab they are working in.
 */
export async function changeOwnPassword(
  actor: AuthenticatedAdmin,
  input: { currentPassword: string; newPassword: string },
  currentSessionId: string | undefined,
  req?: Request,
): Promise<void> {
  const admin = await Admin.findById(actor.objectId).select('+passwordHash');
  if (!admin) throw AppError.notFound('This admin account is no longer available.');

  const matches = await admin.verifyPassword(input.currentPassword);
  if (!matches) {
    throw new AppError(422, ErrorCode.VALIDATION_ERROR, 'Your current password is not correct.', {
      details: [{ field: 'currentPassword', message: 'That is not your current password.' }],
    });
  }

  if (input.currentPassword === input.newPassword) {
    throw AppError.validation('Choose a password you have not used here before.', [
      { field: 'newPassword', message: 'The new password must be different from the current one.' },
    ]);
  }

  await admin.setPassword(input.newPassword);
  admin.mustChangePassword = false;
  admin.passwordChangedAt = new Date();
  await admin.save();

  const revokedSessions = await revokeAllSessions(
    'admin',
    admin._id,
    'admin_password_changed',
    currentSessionId,
  );

  await writeAudit({
    actorType: 'admin',
    actorId: admin._id,
    actorLabel: `${admin.name} (${admin.email})`,
    action: 'admin.password_changed',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${admin.name} changed their own password.`,
    metadata: { revokedSessions },
    req,
  });
}
