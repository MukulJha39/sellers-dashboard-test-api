import type { Request, Response } from 'express';
import type { AdminStatus } from '../../models/Admin';
import { AppError } from '../../utils/AppError';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import { parsePagination, parseSort } from '../../utils/pagination';
import type { AuthenticatedAdmin } from '../../types/express';
import { createRole, deleteRole, listRoles, updateRole } from './adminRoleService';
import {
  ADMIN_SORT_FIELDS,
  changeOwnPassword,
  createAdmin,
  getAdmin,
  listAdmins,
  resetAdminPassword,
  setAdminStatus,
  updateAdmin,
  type AdminListFilters,
} from './adminTeamService';
import { PERMISSION_GROUPS } from '../../config/permissions';

/** Roles and the admin team: the two screens behind `role.manage` and `admin.manage`. */

function requireAdminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ---------------------------------- roles ---------------------------------- */

export async function getRolesWithMembers(_req: Request, res: Response): Promise<void> {
  sendData(res, { roles: await listRoles(), permissionGroups: PERMISSION_GROUPS });
}

export async function postRole(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  const role = await createRole(
    admin,
    {
      name: String(req.body.name),
      description: String(req.body.description ?? ''),
      permissions: Array.isArray(req.body.permissions) ? req.body.permissions.map(String) : [],
    },
    req,
  );
  sendData(res, { role }, 201);
}

export async function patchRole(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);

  const input: { name?: string; description?: string; permissions?: string[] } = {};
  if (req.body.name !== undefined) input.name = String(req.body.name);
  if (req.body.description !== undefined) input.description = String(req.body.description);
  if (req.body.permissions !== undefined) {
    input.permissions = Array.isArray(req.body.permissions) ? req.body.permissions.map(String) : [];
  }

  sendData(res, { role: await updateRole(admin, String(req.params.id), input, req) });
}

export async function deleteRoleById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  await deleteRole(admin, String(req.params.id), req);
  sendData(res, { deleted: true });
}

/* ------------------------------- admin team ------------------------------- */

export async function getAdmins(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_SORT_FIELDS, { createdAt: -1 });

  const filters: AdminListFilters = {};
  const search = optionalString(req.query.search);
  const status = optionalString(req.query.status);
  const roleId = optionalString(req.query.roleId);
  if (search) filters.search = search;
  if (status) filters.status = status as AdminStatus;
  if (roleId) filters.roleId = roleId;

  const { items, total } = await listAdmins(admin, filters, pagination, sort);
  sendList(res, items, buildPageMeta(pagination.page, pagination.limit, total));
}

export async function getAdminById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  sendData(res, { admin: await getAdmin(admin, String(req.params.id)) });
}

export async function postAdmin(req: Request, res: Response): Promise<void> {
  const actor = requireAdminContext(req);
  const created = await createAdmin(
    actor,
    {
      name: String(req.body.name),
      email: String(req.body.email),
      roleId: String(req.body.roleId),
      password: String(req.body.password),
    },
    req,
  );
  sendData(res, { admin: created }, 201);
}

export async function patchAdmin(req: Request, res: Response): Promise<void> {
  const actor = requireAdminContext(req);

  const input: { name?: string; email?: string; roleId?: string } = {};
  if (req.body.name !== undefined) input.name = String(req.body.name);
  if (req.body.email !== undefined) input.email = String(req.body.email);
  if (req.body.roleId !== undefined) input.roleId = String(req.body.roleId);

  sendData(res, { admin: await updateAdmin(actor, String(req.params.id), input, req) });
}

export async function patchAdminStatus(req: Request, res: Response): Promise<void> {
  const actor = requireAdminContext(req);
  const status = String(req.body.status) as AdminStatus;
  const reason = optionalString(req.body.reason) ?? null;

  sendData(res, { admin: await setAdminStatus(actor, String(req.params.id), status, reason, req) });
}

export async function postAdminPasswordReset(req: Request, res: Response): Promise<void> {
  const actor = requireAdminContext(req);
  sendData(res, {
    admin: await resetAdminPassword(actor, String(req.params.id), String(req.body.password), req),
  });
}

/* ---------------------------- own password ---------------------------- */

export async function postChangeOwnPassword(req: Request, res: Response): Promise<void> {
  const actor = requireAdminContext(req);
  await changeOwnPassword(
    actor,
    {
      currentPassword: String(req.body.currentPassword),
      newPassword: String(req.body.newPassword),
    },
    req.sessionId,
    req,
  );
  sendData(res, { passwordChanged: true });
}
