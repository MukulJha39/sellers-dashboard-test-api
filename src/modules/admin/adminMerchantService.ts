import type { Request } from 'express';
import { Types } from 'mongoose';
import { Merchant, type Gender, type MerchantStatus } from '../../models/Merchant';
import { diffFields, writeAudit } from '../../services/auditService';
import { revokeAllSessions } from '../../services/sessionService';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import type { AuthenticatedAdmin } from '../../types/express';
import { presentMerchant, type MerchantView } from '../merchant/merchantPresenter';

export const MERCHANT_SORT_FIELDS = ['createdAt', 'updatedAt', 'firstName', 'lastName', 'lastLoginAt'] as const;

export interface MerchantListFilters {
  search?: string;
  status?: MerchantStatus;
  gender?: Gender;
}

function merchantObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) throw AppError.notFound('That merchant was not found.');
  return new Types.ObjectId(id);
}

export async function listMerchants(
  filters: MerchantListFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: MerchantView[]; total: number }> {
  const query: Record<string, unknown> = {};
  if (filters.status) query.status = filters.status;
  if (filters.gender) query.gender = filters.gender;

  if (filters.search) {
    const term = escapeRegex(filters.search.trim());
    if (term) {
      const pattern = new RegExp(term, 'i');
      query.$or = [
        { firstName: pattern },
        { lastName: pattern },
        { phone: pattern },
        { phoneE164: pattern },
      ];
    }
  }

  const [documents, total] = await Promise.all([
    Merchant.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Merchant.countDocuments(query),
  ]);

  return { items: documents.map(presentMerchant), total };
}

export async function getMerchant(id: string): Promise<MerchantView> {
  const merchant = await Merchant.findById(merchantObjectId(id));
  if (!merchant) throw AppError.notFound('That merchant was not found.');
  return presentMerchant(merchant);
}

/**
 * Admins may correct a merchant's name or gender. The verified phone number is not in
 * this set, and the route rejects any attempt to send it (PRD section 4).
 */
export async function updateMerchantByAdmin(
  admin: AuthenticatedAdmin,
  id: string,
  input: { firstName?: string; lastName?: string; gender?: Gender },
  req?: Request,
): Promise<MerchantView> {
  const merchant = await Merchant.findById(merchantObjectId(id));
  if (!merchant) throw AppError.notFound('That merchant was not found.');

  const before = {
    firstName: merchant.firstName,
    lastName: merchant.lastName,
    gender: merchant.gender as string,
  };

  if (input.firstName !== undefined) merchant.firstName = input.firstName;
  if (input.lastName !== undefined) merchant.lastName = input.lastName;
  if (input.gender !== undefined) merchant.gender = input.gender;

  await merchant.save();

  const changes = diffFields(before, input as Record<string, unknown>, ['firstName', 'lastName', 'gender']);
  if (changes.length > 0) {
    await writeAudit({
      actorType: 'admin',
      actorId: admin.objectId,
      actorLabel: `${admin.name} (${admin.email})`,
      action: 'merchant.profile_updated_by_admin',
      targetType: 'merchant',
      targetId: merchant._id,
      summary: `${admin.name} updated merchant details (${changes.map((change) => change.field).join(', ')}).`,
      changes,
      req,
    });
  }

  return presentMerchant(merchant);
}

/**
 * Suspending a merchant takes effect immediately: every active session is revoked so an
 * already-signed-in device cannot keep working until its access token expires.
 */
export async function setMerchantStatus(
  admin: AuthenticatedAdmin,
  id: string,
  status: MerchantStatus,
  reason: string | null,
  req?: Request,
): Promise<MerchantView> {
  const merchant = await Merchant.findById(merchantObjectId(id));
  if (!merchant) throw AppError.notFound('That merchant was not found.');

  if (merchant.status === status) {
    return presentMerchant(merchant);
  }

  const previousStatus = merchant.status;
  merchant.status = status;
  merchant.suspendedAt = status === 'suspended' ? new Date() : null;
  merchant.suspendedReason = status === 'suspended' ? reason : null;
  await merchant.save();

  let revokedSessions = 0;
  if (status === 'suspended') {
    revokedSessions = await revokeAllSessions('merchant', merchant._id, 'merchant_suspended');
  }

  await writeAudit({
    actorType: 'admin',
    actorId: admin.objectId,
    actorLabel: `${admin.name} (${admin.email})`,
    action: 'merchant.status_changed',
    targetType: 'merchant',
    targetId: merchant._id,
    summary: `${admin.name} changed merchant status from ${previousStatus} to ${status}.`,
    changes: [{ field: 'status', from: previousStatus, to: status }],
    metadata: { reason, revokedSessions },
    req,
  });

  return presentMerchant(merchant);
}
