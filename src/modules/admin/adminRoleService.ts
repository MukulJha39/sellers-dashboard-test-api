import type { Request } from 'express';
import { Types } from 'mongoose';
import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '../../config/permissions';
import { Admin } from '../../models/Admin';
import { Role, type RoleDocument } from '../../models/Role';
import { diffFields, writeAudit } from '../../services/auditService';
import { AppError, ErrorCode } from '../../utils/AppError';
import type { AuthenticatedAdmin } from '../../types/express';

/**
 * Roles: the permission sets admin accounts are assigned to.
 *
 * Two rules keep the panel from being locked shut by its own permission editor, and both
 * are enforced here rather than in the UI, because the UI is a convenience and the API is
 * the boundary (PRD section 26):
 *
 *   1. The seeded super administrator role cannot be edited or deleted at all. It is the
 *      recovery path — if every other role were stripped of `role.manage`, that role is
 *      what gets the panel back.
 *   2. No change may leave the platform without an active admin who can still manage the
 *      team and the roles.
 */

/** The seeded role that is the way back in. Nothing may change it. */
const PROTECTED_ROLE_SLUG = 'super_admin';

/** Holding these two is what makes an account able to repair the team. */
const KEYHOLDER_PERMISSIONS: Permission[] = [PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_MANAGE];

export interface RoleView {
  id: string;
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
  isSystem: boolean;
  /** How many admin accounts hold this role; a role in use cannot be deleted. */
  memberCount: number;
  /** False for the seeded super administrator role, which is fixed. */
  editable: boolean;
  deletable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoleInput {
  name: string;
  description: string;
  permissions: string[];
}

function roleObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('That role was not found.');
  return new Types.ObjectId(id);
}

function isProtected(role: RoleDocument): boolean {
  return role.slug === PROTECTED_ROLE_SLUG;
}

function present(role: RoleDocument, memberCount: number): RoleView {
  return {
    id: String(role._id),
    slug: role.slug,
    name: role.name,
    description: role.description,
    permissions: role.permissions,
    isSystem: role.isSystem,
    memberCount,
    editable: !isProtected(role),
    // A seeded role is part of the shipped setup, and a role someone is using is in use.
    deletable: !role.isSystem && memberCount === 0,
    createdAt: role.createdAt.toISOString(),
    updatedAt: role.updatedAt.toISOString(),
  };
}

/** Rejects anything outside the catalogue, so a typo cannot silently grant nothing. */
function cleanPermissions(permissions: string[]): Permission[] {
  const catalogue = new Set<string>(ALL_PERMISSIONS);
  const unknown = permissions.filter((permission) => !catalogue.has(permission));
  if (unknown.length > 0) {
    throw AppError.validation('Those permissions are not in the catalogue.', [
      { field: 'permissions', message: `Unknown permission: ${unknown.join(', ')}.` },
    ]);
  }
  // De-duplicated and ordered to match the catalogue, so two equal sets always store alike.
  const chosen = new Set(permissions);
  return ALL_PERMISSIONS.filter((permission) => chosen.has(permission));
}

/**
 * A name turned into a stable key, with a numeric suffix if that key is taken.
 *
 * The slug is what the seed and the recovery path recognise a role by, so it is derived
 * once at creation and never moves afterwards.
 */
async function generateSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'role';

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}_${attempt + 1}`;
    const taken = await Role.exists({ slug: candidate });
    if (!taken) return candidate;
  }
  throw AppError.conflict('Could not derive a unique key for that role name. Try another name.');
}

/**
 * What a permission edit actually did.
 *
 * `diffFields` compares with `!==`, which is never equal for two arrays, so permissions
 * are diffed by membership here. The result also reads better in the audit trail: what
 * was granted and what was taken away, rather than two long lists to compare by eye.
 */
function permissionDelta(
  before: readonly Permission[],
  after: readonly Permission[],
): { granted: Permission[]; revoked: Permission[] } {
  const had = new Set<string>(before);
  const has = new Set<string>(after);
  return {
    granted: after.filter((permission) => !had.has(permission)),
    revoked: before.filter((permission) => !has.has(permission)),
  };
}

async function countMembers(roleIds: Types.ObjectId[]): Promise<Map<string, number>> {
  const counts = await Admin.aggregate<{ _id: Types.ObjectId; count: number }>([
    { $match: { roleId: { $in: roleIds } } },
    { $group: { _id: '$roleId', count: { $sum: 1 } } },
  ]);
  return new Map(counts.map((entry) => [String(entry._id), entry.count]));
}

/**
 * Refuses a change that would leave nobody able to manage the team or the roles.
 *
 * `roleId` is the role being changed and `nextPermissions` is what it would hold
 * afterwards; pass `null` permissions for a role about to be deleted.
 */
async function assertKeyholderRemains(
  roleId: Types.ObjectId,
  nextPermissions: Permission[] | null,
): Promise<void> {
  const stillKeyholder =
    nextPermissions !== null && KEYHOLDER_PERMISSIONS.every((permission) => nextPermissions.includes(permission));
  if (stillKeyholder) return;

  const otherKeyholderRoles = await Role.find({
    _id: { $ne: roleId },
    permissions: { $all: KEYHOLDER_PERMISSIONS },
  })
    .select('_id')
    .lean();

  const remaining = await Admin.countDocuments({
    status: 'active',
    roleId: { $in: otherKeyholderRoles.map((role) => role._id) },
  });

  if (remaining === 0) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      'This would leave nobody able to manage admins and roles. Give another active admin a role with those permissions first.',
    );
  }
}

/* ---------------------------------- reads ---------------------------------- */

export async function listRoles(): Promise<RoleView[]> {
  const roles = await Role.find().sort({ createdAt: 1 });
  const members = await countMembers(roles.map((role) => role._id));
  return roles.map((role) => present(role, members.get(String(role._id)) ?? 0));
}

export async function getRole(id: string): Promise<RoleView> {
  const role = await Role.findById(roleObjectId(id));
  if (!role) throw AppError.notFound('That role was not found.');
  const members = await countMembers([role._id]);
  return present(role, members.get(String(role._id)) ?? 0);
}

/* --------------------------------- writes --------------------------------- */

export async function createRole(
  actor: AuthenticatedAdmin,
  input: RoleInput,
  req?: Request,
): Promise<RoleView> {
  const permissions = cleanPermissions(input.permissions);
  if (permissions.length === 0) {
    throw AppError.validation('Choose at least one permission.', [
      { field: 'permissions', message: 'A role with no permissions cannot open anything.' },
    ]);
  }

  const name = input.name.trim();
  const existing = await Role.findOne({ name });
  if (existing) {
    throw AppError.validation('That role name is already taken.', [
      { field: 'name', message: 'Another role already uses this name.' },
    ]);
  }

  const role = await Role.create({
    slug: await generateSlug(name),
    name,
    description: input.description.trim(),
    permissions,
    isSystem: false,
  });

  await writeAudit({
    actorType: 'admin',
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
    action: 'role.created',
    targetType: 'role',
    targetId: role._id,
    summary: `${actor.name} created the role ${role.name} with ${permissions.length} permission${permissions.length === 1 ? '' : 's'}.`,
    changes: [{ field: 'permissions', from: null, to: permissions.join(', ') }],
    req,
  });

  return present(role, 0);
}

export async function updateRole(
  actor: AuthenticatedAdmin,
  id: string,
  input: Partial<RoleInput>,
  req?: Request,
): Promise<RoleView> {
  const role = await Role.findById(roleObjectId(id));
  if (!role) throw AppError.notFound('That role was not found.');

  if (isProtected(role)) {
    throw AppError.forbidden(
      'The super administrator role is fixed. It is the way back in if another role is misconfigured.',
    );
  }

  const before = { name: role.name, description: role.description };
  const permissionsBefore: Permission[] = [...role.permissions];

  if (input.name !== undefined) {
    const name = input.name.trim();
    const clash = await Role.findOne({ name, _id: { $ne: role._id } });
    if (clash) {
      throw AppError.validation('That role name is already taken.', [
        { field: 'name', message: 'Another role already uses this name.' },
      ]);
    }
    role.name = name;
  }

  if (input.description !== undefined) role.description = input.description.trim();

  if (input.permissions !== undefined) {
    const permissions = cleanPermissions(input.permissions);
    if (permissions.length === 0) {
      throw AppError.validation('Choose at least one permission.', [
        { field: 'permissions', message: 'A role with no permissions cannot open anything.' },
      ]);
    }
    await assertKeyholderRemains(role._id, permissions);
    role.permissions = permissions;
  }

  await role.save();

  const changes = diffFields(before, { name: role.name, description: role.description }, [
    'name',
    'description',
  ]);

  const { granted, revoked } = permissionDelta(permissionsBefore, role.permissions);
  if (granted.length > 0) changes.push({ field: 'permissions granted', from: null, to: granted.join(', ') });
  if (revoked.length > 0) changes.push({ field: 'permissions revoked', from: revoked.join(', '), to: null });

  if (changes.length > 0) {
    const parts: string[] = [];
    if (granted.length > 0) parts.push(`granted ${granted.length}`);
    if (revoked.length > 0) parts.push(`revoked ${revoked.length}`);
    const permissionNote = parts.length > 0 ? ` (${parts.join(', ')} permission${granted.length + revoked.length === 1 ? '' : 's'})` : '';

    await writeAudit({
      actorType: 'admin',
      actorId: actor.objectId,
      actorLabel: `${actor.name} (${actor.email})`,
      action: 'role.updated',
      targetType: 'role',
      targetId: role._id,
      summary: `${actor.name} updated the role ${role.name}${permissionNote}.`,
      changes,
      req,
    });
  }

  const members = await countMembers([role._id]);
  return present(role, members.get(String(role._id)) ?? 0);
}

export async function deleteRole(
  actor: AuthenticatedAdmin,
  id: string,
  req?: Request,
): Promise<void> {
  const role = await Role.findById(roleObjectId(id));
  if (!role) throw AppError.notFound('That role was not found.');

  if (role.isSystem) {
    throw AppError.forbidden('Seeded roles are part of the shipped setup and cannot be deleted.');
  }

  const memberCount = await Admin.countDocuments({ roleId: role._id });
  if (memberCount > 0) {
    throw new AppError(
      409,
      ErrorCode.CONFLICT,
      `${memberCount} admin${memberCount === 1 ? '' : 's'} still hold this role. Move them to another role first.`,
      { meta: { memberCount } },
    );
  }

  await assertKeyholderRemains(role._id, null);

  await Role.deleteOne({ _id: role._id });

  await writeAudit({
    actorType: 'admin',
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
    action: 'role.deleted',
    targetType: 'role',
    targetId: role._id,
    summary: `${actor.name} deleted the role ${role.name}.`,
    changes: [{ field: 'permissions', from: role.permissions.join(', '), to: null }],
    req,
  });
}
