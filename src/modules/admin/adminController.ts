import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { AuditLog } from '../../models/AuditLog';
import type { Gender, MerchantStatus } from '../../models/Merchant';
import { refreshSession, revokeSession } from '../../services/sessionService';
import { AppError } from '../../utils/AppError';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import { parsePagination, parseSort } from '../../utils/pagination';
import type { AuthenticatedAdmin } from '../../types/express';
import { getAdminProfile, loginAdmin, updateOwnProfile } from './adminAuthService';
import {
  getMerchant,
  listMerchants,
  setMerchantStatus,
  updateMerchantByAdmin,
  MERCHANT_SORT_FIELDS,
  type MerchantListFilters,
} from './adminMerchantService';

function requireAdminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/* ---------------------------------- auth ---------------------------------- */

export async function postAdminLogin(req: Request, res: Response): Promise<void> {
  const result = await loginAdmin({
    email: String(req.body.email),
    password: String(req.body.password),
    req,
  });
  sendData(res, result);
}

export async function getAdminMe(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  sendData(res, { admin: await getAdminProfile(admin.id) });
}

export async function patchAdminMe(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  sendData(res, { admin: await updateOwnProfile(admin.id, { name: String(req.body.name) }, req) });
}

export async function postAdminRefresh(req: Request, res: Response): Promise<void> {
  const result = await refreshSession(String(req.body.refreshToken), 'admin');
  sendData(res, { tokens: result.tokens });
}

export async function postAdminLogout(req: Request, res: Response): Promise<void> {
  if (req.sessionId) await revokeSession(req.sessionId, 'logout');
  sendData(res, { loggedOut: true });
}

/* -------------------------------- merchants ------------------------------- */

export async function getMerchants(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, MERCHANT_SORT_FIELDS, { createdAt: -1 });

  const filters: MerchantListFilters = {};
  const search = optionalString(req.query.search);
  const status = optionalString(req.query.status);
  const gender = optionalString(req.query.gender);
  if (search) filters.search = search;
  if (status) filters.status = status as MerchantStatus;
  if (gender) filters.gender = gender as Gender;

  const { items, total } = await listMerchants(filters, pagination, sort);
  sendList(res, items, buildPageMeta(pagination.page, pagination.limit, total));
}

export async function getMerchantById(req: Request, res: Response): Promise<void> {
  sendData(res, { merchant: await getMerchant(String(req.params.id)) });
}

export async function patchMerchantById(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);

  const input: { firstName?: string; lastName?: string; gender?: Gender } = {};
  if (req.body.firstName !== undefined) input.firstName = String(req.body.firstName).trim();
  if (req.body.lastName !== undefined) input.lastName = String(req.body.lastName).trim();
  if (req.body.gender !== undefined) input.gender = String(req.body.gender) as Gender;

  sendData(res, { merchant: await updateMerchantByAdmin(admin, String(req.params.id), input, req) });
}

export async function patchMerchantStatus(req: Request, res: Response): Promise<void> {
  const admin = requireAdminContext(req);
  const status = String(req.body.status) as MerchantStatus;
  const reason = optionalString(req.body.reason) ?? null;

  sendData(res, { merchant: await setMerchantStatus(admin, String(req.params.id), status, reason, req) });
}

/* ------------------------------ roles & audit ----------------------------- */

export async function getAuditLogs(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);

  const query: Record<string, unknown> = {};
  const targetType = optionalString(req.query.targetType);
  const targetId = optionalString(req.query.targetId);
  const actorType = optionalString(req.query.actorType);
  const actorId = optionalString(req.query.actorId);
  const action = optionalString(req.query.action);

  if (targetType) query.targetType = targetType;
  if (targetId && Types.ObjectId.isValid(targetId)) query.targetId = new Types.ObjectId(targetId);
  if (actorType) query.actorType = actorType;
  // Who performed the action, as opposed to what it was performed on. This is what
  // answers "what have I been doing", which `targetId` cannot.
  if (actorId && Types.ObjectId.isValid(actorId)) query.actorId = new Types.ObjectId(actorId);
  if (action) query.action = action;

  const [entries, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    AuditLog.countDocuments(query),
  ]);

  sendList(
    res,
    entries.map((entry) => ({
      id: String(entry._id),
      actorType: entry.actorType,
      actorLabel: entry.actorLabel,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ? String(entry.targetId) : null,
      summary: entry.summary,
      changes: entry.changes,
      createdAt: entry.createdAt.toISOString(),
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}
