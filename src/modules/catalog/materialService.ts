import type { Request } from 'express';
import { Types } from 'mongoose';
import type { Unit } from '../../config/catalog';
import { RawMaterial, type RawMaterialDocument } from '../../models/RawMaterial';
import { computeIsLowStock } from '../../models/stockFields';
import { diffFields, writeAudit } from '../../services/auditService';
import { deleteStoredFile } from '../../services/storageService';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import { fromThousandths } from '../../utils/quantity';
import { resolveCategoryId } from './categoryService';
import { assertQuantityFitsUnit } from './itemService';
import { recordOpeningStock, type StockActor } from './stockService';

export const MATERIAL_SORT_FIELDS = [
  'name',
  'createdAt',
  'updatedAt',
  'quantityThousandths',
  'expiryDate',
] as const;

export interface MaterialFilters {
  search?: string;
  categoryId?: string;
  archived?: boolean;
  lowStock?: boolean;
  outOfStock?: boolean;
  /** Materials whose expiry falls within the next N days. */
  expiringWithinDays?: number;
}

export interface MaterialInput {
  name: string;
  categoryId?: string | null;
  notes?: string | null;
  unit?: Unit;
  trackStock?: boolean;
  purchaseCostMinor?: number | null;
  lowStockThresholdThousandths?: number;
  batchReference?: string | null;
  expiryDate?: Date | null;
  supplierName?: string | null;
  imageUrl?: string | null;
}

export async function listMaterials(
  merchantId: Types.ObjectId,
  filters: MaterialFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: RawMaterialDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId, archived: filters.archived ?? false };

  if (filters.categoryId) {
    if (!Types.ObjectId.isValid(filters.categoryId)) {
      throw AppError.notFound('That category was not found.');
    }
    query.categoryId = new Types.ObjectId(filters.categoryId);
  }

  if (filters.lowStock) query.isLowStock = true;
  if (filters.outOfStock) query.quantityThousandths = { $lte: 0 };

  if (filters.expiringWithinDays !== undefined) {
    const cutoff = new Date(Date.now() + filters.expiringWithinDays * 24 * 60 * 60 * 1000);
    query.expiryDate = { $ne: null, $lte: cutoff };
  }

  if (filters.search?.trim()) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), 'i');
    query.$or = [{ name: pattern }, { batchReference: pattern }, { supplierName: pattern }];
  }

  const [items, total] = await Promise.all([
    RawMaterial.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    RawMaterial.countDocuments(query),
  ]);

  return { items, total };
}

export async function loadMaterial(
  merchantId: Types.ObjectId,
  materialId: string,
): Promise<RawMaterialDocument> {
  if (!Types.ObjectId.isValid(materialId)) throw AppError.notFound('That material was not found.');

  const material = await RawMaterial.findOne({ _id: materialId, merchantId });
  if (!material) throw AppError.notFound('That material was not found.');
  return material;
}

export async function createMaterial(input: {
  merchantId: Types.ObjectId;
  data: MaterialInput;
  openingQuantityThousandths?: number;
  actor: StockActor;
  req?: Request;
}): Promise<RawMaterialDocument> {
  const unit = input.data.unit ?? 'kilogram';
  const threshold = input.data.lowStockThresholdThousandths ?? 0;
  const trackStock = input.data.trackStock ?? true;

  assertQuantityFitsUnit(unit, threshold, 'lowStockThreshold');
  if (input.openingQuantityThousandths) {
    assertQuantityFitsUnit(unit, input.openingQuantityThousandths, 'quantity');
  }

  const categoryId = await resolveCategoryId(input.merchantId, 'material', input.data.categoryId);

  const material = await RawMaterial.create({
    merchantId: input.merchantId,
    name: input.data.name.trim(),
    categoryId,
    notes: input.data.notes?.trim() || null,
    imageUrl: input.data.imageUrl ?? null,
    unit,
    trackStock,
    quantityThousandths: 0,
    totalReceivedThousandths: 0,
    lowStockThresholdThousandths: threshold,
    purchaseCostMinor: input.data.purchaseCostMinor ?? null,
    batchReference: input.data.batchReference?.trim() || null,
    expiryDate: input.data.expiryDate ?? null,
    supplierName: input.data.supplierName?.trim() || null,
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'material.created',
    targetType: 'material',
    targetId: material._id,
    summary: `Raw material "${material.name}" created, measured in ${material.unit}.`,
    req: input.req,
  });

  if (trackStock && input.openingQuantityThousandths && input.openingQuantityThousandths > 0) {
    await recordOpeningStock({
      merchantId: input.merchantId,
      subjectType: 'material',
      subject: material,
      quantityThousandths: input.openingQuantityThousandths,
      actor: input.actor,
      req: input.req,
    });
    return loadMaterial(input.merchantId, String(material._id));
  }

  return material;
}

/** Quantity is absent here on purpose: stock only moves through the ledger. */
export async function updateMaterial(input: {
  merchantId: Types.ObjectId;
  materialId: string;
  data: Partial<MaterialInput>;
  actor: StockActor;
  req?: Request;
}): Promise<RawMaterialDocument> {
  const material = await loadMaterial(input.merchantId, input.materialId);

  const before = {
    name: material.name,
    unit: material.unit as string,
    purchaseCostMinor: material.purchaseCostMinor ?? null,
    lowStockThresholdThousandths: material.lowStockThresholdThousandths,
    trackStock: material.trackStock,
    batchReference: material.batchReference ?? null,
    supplierName: material.supplierName ?? null,
    categoryId: material.categoryId ? String(material.categoryId) : null,
    expiryDate: material.expiryDate ? material.expiryDate.toISOString() : null,
  };

  if (input.data.name !== undefined) material.name = input.data.name.trim();
  if (input.data.notes !== undefined) material.notes = input.data.notes?.trim() || null;
  if (input.data.imageUrl !== undefined) material.imageUrl = input.data.imageUrl;
  if (input.data.purchaseCostMinor !== undefined) material.purchaseCostMinor = input.data.purchaseCostMinor;
  if (input.data.batchReference !== undefined) {
    material.batchReference = input.data.batchReference?.trim() || null;
  }
  if (input.data.supplierName !== undefined) {
    material.supplierName = input.data.supplierName?.trim() || null;
  }
  if (input.data.expiryDate !== undefined) material.expiryDate = input.data.expiryDate;

  if (input.data.categoryId !== undefined) {
    material.categoryId = await resolveCategoryId(input.merchantId, 'material', input.data.categoryId);
  }

  if (input.data.unit !== undefined) material.unit = input.data.unit;
  if (input.data.lowStockThresholdThousandths !== undefined) {
    material.lowStockThresholdThousandths = input.data.lowStockThresholdThousandths;
  }
  if (input.data.trackStock !== undefined) material.trackStock = input.data.trackStock;

  assertQuantityFitsUnit(material.unit, material.lowStockThresholdThousandths, 'lowStockThreshold');
  assertQuantityFitsUnit(material.unit, material.quantityThousandths, 'unit');

  material.isLowStock = computeIsLowStock({
    trackStock: material.trackStock,
    quantityThousandths: material.quantityThousandths,
    lowStockThresholdThousandths: material.lowStockThresholdThousandths,
  });

  await material.save();

  const after: Record<string, unknown> = {
    name: material.name,
    unit: material.unit,
    purchaseCostMinor: material.purchaseCostMinor ?? null,
    lowStockThresholdThousandths: material.lowStockThresholdThousandths,
    trackStock: material.trackStock,
    batchReference: material.batchReference ?? null,
    supplierName: material.supplierName ?? null,
    categoryId: material.categoryId ? String(material.categoryId) : null,
    expiryDate: material.expiryDate ? material.expiryDate.toISOString() : null,
  };

  const changes = diffFields(before, after, Object.keys(before));
  if (changes.length > 0) {
    await writeAudit({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label,
      action: 'material.updated',
      targetType: 'material',
      targetId: material._id,
      summary: `Raw material "${material.name}" updated (${changes.map((c) => c.field).join(', ')}).`,
      changes,
      req: input.req,
    });
  }

  return material;
}

export async function setMaterialArchived(input: {
  merchantId: Types.ObjectId;
  materialId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<RawMaterialDocument> {
  const material = await loadMaterial(input.merchantId, input.materialId);
  if (material.archived === input.archived) return material;

  material.archived = input.archived;
  material.archivedAt = input.archived ? new Date() : null;
  material.isLowStock = input.archived
    ? false
    : computeIsLowStock({
        trackStock: material.trackStock,
        quantityThousandths: material.quantityThousandths,
        lowStockThresholdThousandths: material.lowStockThresholdThousandths,
      });

  await material.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'material.archived' : 'material.restored',
    targetType: 'material',
    targetId: material._id,
    summary:
      `Raw material "${material.name}" ${input.archived ? 'archived' : 'restored'} ` +
      `with ${fromThousandths(material.quantityThousandths)} ${material.unit} in stock.`,
    req: input.req,
  });

  return material;
}

export async function replaceMaterialImage(input: {
  merchantId: Types.ObjectId;
  materialId: string;
  imageUrl: string | null;
}): Promise<RawMaterialDocument> {
  const material = await loadMaterial(input.merchantId, input.materialId);
  const previous = material.imageUrl;

  material.imageUrl = input.imageUrl;
  await material.save();

  if (previous && previous !== input.imageUrl) await deleteStoredFile(previous);
  return material;
}
