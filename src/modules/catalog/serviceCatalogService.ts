import type { Request } from 'express';
import { Types } from 'mongoose';
import { DURATION_BILLING_UNITS, type BillingUnit } from '../../config/catalog';
import { ServiceOffering, type ServiceOfferingDocument } from '../../models/ServiceOffering';
import { diffFields, writeAudit } from '../../services/auditService';
import { deleteStoredFile } from '../../services/storageService';
import { AppError } from '../../utils/AppError';
import { describeMoneyMinor } from '../../utils/money';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import { resolveCategoryId } from './categoryService';
import type { StockActor } from './stockService';

export const SERVICE_SORT_FIELDS = ['name', 'createdAt', 'updatedAt', 'rateMinor'] as const;

export interface ServiceFilters {
  search?: string;
  categoryId?: string;
  archived?: boolean;
  isActive?: boolean;
  billingUnit?: BillingUnit;
}

export interface ServiceInput {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  billingUnit?: BillingUnit;
  rateMinor?: number;
  durationMinutes?: number | null;
  taxRatePercent?: number | null;
  isActive?: boolean;
  imageUrl?: string | null;
}

/**
 * A duration only means something for time-based billing, so it is cleared for the
 * other kinds rather than kept as a misleading leftover.
 */
function normaliseDuration(
  billingUnit: BillingUnit,
  durationMinutes: number | null | undefined,
): number | null {
  if (!DURATION_BILLING_UNITS.has(billingUnit)) return null;
  return durationMinutes ?? null;
}

export async function listServices(
  merchantId: Types.ObjectId,
  filters: ServiceFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: ServiceOfferingDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId, archived: filters.archived ?? false };

  if (filters.categoryId) {
    if (!Types.ObjectId.isValid(filters.categoryId)) {
      throw AppError.notFound('That category was not found.');
    }
    query.categoryId = new Types.ObjectId(filters.categoryId);
  }

  if (filters.isActive !== undefined) query.isActive = filters.isActive;
  if (filters.billingUnit) query.billingUnit = filters.billingUnit;

  if (filters.search?.trim()) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), 'i');
    query.$or = [{ name: pattern }, { description: pattern }];
  }

  const [items, total] = await Promise.all([
    ServiceOffering.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    ServiceOffering.countDocuments(query),
  ]);

  return { items, total };
}

export async function loadService(
  merchantId: Types.ObjectId,
  serviceId: string,
): Promise<ServiceOfferingDocument> {
  if (!Types.ObjectId.isValid(serviceId)) throw AppError.notFound('That service was not found.');

  const service = await ServiceOffering.findOne({ _id: serviceId, merchantId });
  if (!service) throw AppError.notFound('That service was not found.');
  return service;
}

export async function createService(input: {
  merchantId: Types.ObjectId;
  data: ServiceInput;
  actor: StockActor;
  req?: Request;
}): Promise<ServiceOfferingDocument> {
  const billingUnit = input.data.billingUnit ?? 'one_time';
  const categoryId = await resolveCategoryId(input.merchantId, 'service', input.data.categoryId);

  const service = await ServiceOffering.create({
    merchantId: input.merchantId,
    name: input.data.name.trim(),
    categoryId,
    description: input.data.description?.trim() || null,
    imageUrl: input.data.imageUrl ?? null,
    billingUnit,
    rateMinor: input.data.rateMinor ?? 0,
    durationMinutes: normaliseDuration(billingUnit, input.data.durationMinutes),
    taxRatePercent: input.data.taxRatePercent ?? null,
    isActive: input.data.isActive ?? true,
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'service.created',
    targetType: 'service',
    targetId: service._id,
    summary:
      `Service "${service.name}" created at ${describeMoneyMinor(service.rateMinor)} ` +
      `per ${service.billingUnit.replace(/_/g, ' ')}.`,
    req: input.req,
  });

  return service;
}

export async function updateService(input: {
  merchantId: Types.ObjectId;
  serviceId: string;
  data: Partial<ServiceInput>;
  actor: StockActor;
  req?: Request;
}): Promise<ServiceOfferingDocument> {
  const service = await loadService(input.merchantId, input.serviceId);

  const before = {
    name: service.name,
    billingUnit: service.billingUnit as string,
    rateMinor: service.rateMinor,
    durationMinutes: service.durationMinutes ?? null,
    taxRatePercent: service.taxRatePercent ?? null,
    isActive: service.isActive,
    categoryId: service.categoryId ? String(service.categoryId) : null,
  };

  if (input.data.name !== undefined) service.name = input.data.name.trim();
  if (input.data.description !== undefined) {
    service.description = input.data.description?.trim() || null;
  }
  if (input.data.imageUrl !== undefined) service.imageUrl = input.data.imageUrl;
  if (input.data.rateMinor !== undefined) service.rateMinor = input.data.rateMinor;
  if (input.data.taxRatePercent !== undefined) service.taxRatePercent = input.data.taxRatePercent;
  if (input.data.isActive !== undefined) service.isActive = input.data.isActive;

  if (input.data.categoryId !== undefined) {
    service.categoryId = await resolveCategoryId(input.merchantId, 'service', input.data.categoryId);
  }

  if (input.data.billingUnit !== undefined) service.billingUnit = input.data.billingUnit;

  // Recomputed after the billing unit settles, so switching to one-time clears a
  // duration that no longer applies.
  const requestedDuration =
    input.data.durationMinutes !== undefined ? input.data.durationMinutes : service.durationMinutes;
  service.durationMinutes = normaliseDuration(service.billingUnit, requestedDuration);

  await service.save();

  const after: Record<string, unknown> = {
    name: service.name,
    billingUnit: service.billingUnit,
    rateMinor: service.rateMinor,
    durationMinutes: service.durationMinutes ?? null,
    taxRatePercent: service.taxRatePercent ?? null,
    isActive: service.isActive,
    categoryId: service.categoryId ? String(service.categoryId) : null,
  };

  const changes = diffFields(before, after, Object.keys(before));
  if (changes.length > 0) {
    await writeAudit({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label,
      action: 'service.updated',
      targetType: 'service',
      targetId: service._id,
      summary: `Service "${service.name}" updated (${changes.map((c) => c.field).join(', ')}).`,
      changes,
      req: input.req,
    });
  }

  return service;
}

export async function setServiceArchived(input: {
  merchantId: Types.ObjectId;
  serviceId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<ServiceOfferingDocument> {
  const service = await loadService(input.merchantId, input.serviceId);
  if (service.archived === input.archived) return service;

  service.archived = input.archived;
  service.archivedAt = input.archived ? new Date() : null;
  await service.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'service.archived' : 'service.restored',
    targetType: 'service',
    targetId: service._id,
    summary: `Service "${service.name}" ${input.archived ? 'archived' : 'restored'}.`,
    req: input.req,
  });

  return service;
}

export async function replaceServiceImage(input: {
  merchantId: Types.ObjectId;
  serviceId: string;
  imageUrl: string | null;
}): Promise<ServiceOfferingDocument> {
  const service = await loadService(input.merchantId, input.serviceId);
  const previous = service.imageUrl;

  service.imageUrl = input.imageUrl;
  await service.save();

  if (previous && previous !== input.imageUrl) await deleteStoredFile(previous);
  return service;
}
