import type { Request } from 'express';
import type { Permission } from '../../config/permissions';
import { Admin, type AdminDocument } from '../../models/Admin';
import { Role, type RoleDocument } from '../../models/Role';
import { writeAudit } from '../../services/auditService';
import { createSession } from '../../services/sessionService';
import { AppError } from '../../utils/AppError';
import type { IssuedTokens } from '../../utils/jwt';

export interface AdminView {
  id: string;
  name: string;
  email: string;
  status: string;
  /** True while this account still holds a password somebody else chose. */
  mustChangePassword: boolean;
  /** Null until they have replaced a password that was set for them. */
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  /** When the account was added to the team. */
  createdAt: string;
  role: { id: string; slug: string; name: string; description: string };
  permissions: Permission[];
}

export function presentAdmin(admin: AdminDocument, role: RoleDocument): AdminView {
  return {
    id: String(admin._id),
    name: admin.name,
    email: admin.email,
    status: admin.status,
    mustChangePassword: admin.mustChangePassword,
    passwordChangedAt: admin.passwordChangedAt ? admin.passwordChangedAt.toISOString() : null,
    lastLoginAt: admin.lastLoginAt ? admin.lastLoginAt.toISOString() : null,
    createdAt: admin.createdAt.toISOString(),
    role: {
      id: String(role._id),
      slug: role.slug,
      name: role.name,
      description: role.description,
    },
    permissions: role.permissions,
  };
}

/**
 * Admin sign-in. Failures are deliberately indistinguishable from one another so the
 * response never reveals whether an email exists or an account is suspended.
 */
export async function loginAdmin(input: {
  email: string;
  password: string;
  req?: Request;
}): Promise<{ admin: AdminView; tokens: IssuedTokens }> {
  const invalidCredentials = AppError.unauthenticated('Those sign-in details are not correct.');

  const admin = await Admin.findOne({ email: input.email.toLowerCase().trim() }).select('+passwordHash');
  if (!admin || admin.status !== 'active') throw invalidCredentials;

  const passwordMatches = await admin.verifyPassword(input.password);
  if (!passwordMatches) throw invalidCredentials;

  const role = await Role.findById(admin.roleId);
  if (!role) throw AppError.forbidden('Your admin role is missing. Contact a super administrator.');

  admin.lastLoginAt = new Date();
  await admin.save();

  const { tokens } = await createSession('admin', admin._id, input.req);

  await writeAudit({
    actorType: 'admin',
    actorId: admin._id,
    actorLabel: `${admin.name} (${admin.email})`,
    action: 'admin.signed_in',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${admin.name} signed in to the admin panel as ${role.name}.`,
    req: input.req,
  });

  return { admin: presentAdmin(admin, role), tokens };
}

/**
 * An admin correcting their own display name.
 *
 * Only the name. The email address is the sign-in identity and the role is what the
 * account may reach — letting someone change either of those on themselves would put both
 * outside the team screen, where granting them is a deliberate act by someone else.
 *
 * The audit trail stores the actor's name as text at the time of writing, so a rename
 * never rewrites what is already recorded.
 */
export async function updateOwnProfile(
  adminId: string,
  input: { name: string },
  req?: Request,
): Promise<AdminView> {
  const admin = await Admin.findById(adminId);
  if (!admin) throw AppError.notFound('This admin account is no longer available.');

  const role = await Role.findById(admin.roleId);
  if (!role) throw AppError.forbidden('Your admin role is missing. Contact a super administrator.');

  const previous = admin.name;
  const name = input.name.trim();
  if (name === previous) return presentAdmin(admin, role);

  admin.name = name;
  await admin.save();

  await writeAudit({
    actorType: 'admin',
    actorId: admin._id,
    actorLabel: `${admin.name} (${admin.email})`,
    action: 'admin.profile_updated',
    targetType: 'admin',
    targetId: admin._id,
    summary: `${name} changed their own display name.`,
    changes: [{ field: 'name', from: previous, to: name }],
    req,
  });

  return presentAdmin(admin, role);
}

export async function getAdminProfile(adminId: string): Promise<AdminView> {
  const admin = await Admin.findById(adminId);
  if (!admin) throw AppError.notFound('This admin account is no longer available.');

  const role = await Role.findById(admin.roleId);
  if (!role) throw AppError.forbidden('Your admin role is missing. Contact a super administrator.');

  return presentAdmin(admin, role);
}
