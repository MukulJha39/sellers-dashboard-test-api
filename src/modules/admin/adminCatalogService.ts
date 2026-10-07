import { Types } from 'mongoose';
import type { StockSubjectType } from '../../config/catalog';
import { Item, type ItemDocument } from '../../models/Item';
import { Merchant } from '../../models/Merchant';
import { RawMaterial, type RawMaterialDocument } from '../../models/RawMaterial';
import { ServiceOffering, type ServiceOfferingDocument } from '../../models/ServiceOffering';
import { StockMovement, type StockMovementDocument } from '../../models/StockMovement';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import { fromThousandths } from '../../utils/quantity';

/** Merchant names keyed by id, so admin tables can show who owns each row. */
export type MerchantNames = Map<string, string>;

export async function loadMerchantNames(
  merchantIds: Array<Types.ObjectId | null | undefined>,
): Promise<MerchantNames> {
  const ids = merchantIds.filter((id): id is Types.ObjectId => Boolean(id));
  if (ids.length === 0) return new Map<string, string>();

  const merchants = await Merchant.find({ _id: { $in: ids } })
    .select('firstName lastName')
    .lean();

  return new Map<string, string>(
    merchants.map((merchant) => [
      String(merchant._id),
      `${merchant.firstName} ${merchant.lastName}`.trim(),
    ]),
  );
}

export interface AdminCatalogFilters {
  merchantId?: string;
  search?: string;
  archived?: boolean;
  lowStock?: boolean;
}

function baseQuery(filters: AdminCatalogFilters): Record<string, unknown> {
  const query: Record<string, unknown> = { archived: filters.archived ?? false };

  if (filters.merchantId) {
    if (!Types.ObjectId.isValid(filters.merchantId)) {
      throw AppError.notFound('That merchant was not found.');
    }
    query.merchantId = new Types.ObjectId(filters.merchantId);
  }

  if (filters.lowStock) query.isLowStock = true;
  return query;
}

export const ADMIN_CATALOG_SORT_FIELDS = [
  'name',
  'createdAt',
  'updatedAt',
  'quantityThousandths',
] as const;

export async function adminListItems(
  filters: AdminCatalogFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: ItemDocument[]; total: number }> {
  const query = baseQuery(filters);
  if (filters.search?.trim()) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), 'i');
    query.$or = [{ name: pattern }, { sku: pattern }];
  }

  const [items, total] = await Promise.all([
    Item.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Item.countDocuments(query),
  ]);

  return { items, total };
}

export async function adminListServices(
  filters: AdminCatalogFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: ServiceOfferingDocument[]; total: number }> {
  const query = baseQuery(filters);
  // Services carry no stock, so a low-stock filter cannot apply to them.
  delete query.isLowStock;

  if (filters.search?.trim()) {
    query.name = new RegExp(escapeRegex(filters.search.trim()), 'i');
  }

  const [items, total] = await Promise.all([
    ServiceOffering.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    ServiceOffering.countDocuments(query),
  ]);

  return { items, total };
}

export async function adminListMaterials(
  filters: AdminCatalogFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: RawMaterialDocument[]; total: number }> {
  const query = baseQuery(filters);
  if (filters.search?.trim()) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), 'i');
    query.$or = [{ name: pattern }, { batchReference: pattern }];
  }

  const [items, total] = await Promise.all([
    RawMaterial.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    RawMaterial.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Loads a catalog record without a merchant filter, for an admin acting on behalf of
 * support. The owning merchant comes back with it so every downstream write stays
 * scoped to the right business.
 */
export async function adminLoadItem(itemId: string): Promise<ItemDocument> {
  if (!Types.ObjectId.isValid(itemId)) throw AppError.notFound('That item was not found.');
  const item = await Item.findById(itemId);
  if (!item) throw AppError.notFound('That item was not found.');
  return item;
}

export async function adminLoadService(serviceId: string): Promise<ServiceOfferingDocument> {
  if (!Types.ObjectId.isValid(serviceId)) throw AppError.notFound('That service was not found.');
  const service = await ServiceOffering.findById(serviceId);
  if (!service) throw AppError.notFound('That service was not found.');
  return service;
}

export async function adminLoadMaterial(materialId: string): Promise<RawMaterialDocument> {
  if (!Types.ObjectId.isValid(materialId)) throw AppError.notFound('That material was not found.');
  const material = await RawMaterial.findById(materialId);
  if (!material) throw AppError.notFound('That material was not found.');
  return material;
}

export async function adminLoadStockSubject(
  subjectType: StockSubjectType,
  subjectId: string,
): Promise<ItemDocument | RawMaterialDocument> {
  return subjectType === 'item' ? adminLoadItem(subjectId) : adminLoadMaterial(subjectId);
}

export async function adminListStockMovements(
  filters: { merchantId?: string; subjectType?: StockSubjectType; subjectId?: string },
  pagination: Pagination,
): Promise<{ items: StockMovementDocument[]; total: number }> {
  const query: Record<string, unknown> = {};

  if (filters.merchantId) {
    if (!Types.ObjectId.isValid(filters.merchantId)) {
      throw AppError.notFound('That merchant was not found.');
    }
    query.merchantId = new Types.ObjectId(filters.merchantId);
  }
  if (filters.subjectType) query.subjectType = filters.subjectType;
  if (filters.subjectId) {
    if (!Types.ObjectId.isValid(filters.subjectId)) {
      throw AppError.notFound('That record was not found.');
    }
    query.subjectId = new Types.ObjectId(filters.subjectId);
  }

  const [items, total] = await Promise.all([
    StockMovement.find(query).sort({ createdAt: -1 }).skip(pagination.skip).limit(pagination.limit),
    StockMovement.countDocuments(query),
  ]);

  return { items, total };
}

export interface AdminLowStockRow {
  id: string;
  type: StockSubjectType;
  merchantId: string;
  name: string;
  unit: string;
  quantity: number;
  lowStockThreshold: number;
  isOutOfStock: boolean;
}

/** Everything running low across all merchants, for support triage. */
export async function adminLowStock(
  pagination: Pagination,
  merchantId?: string,
): Promise<{ rows: AdminLowStockRow[]; total: number }> {
  const query: Record<string, unknown> = { archived: false, isLowStock: true };
  if (merchantId) {
    if (!Types.ObjectId.isValid(merchantId)) throw AppError.notFound('That merchant was not found.');
    query.merchantId = new Types.ObjectId(merchantId);
  }

  const [items, materials, itemCount, materialCount] = await Promise.all([
    Item.find(query).sort({ quantityThousandths: 1 }).limit(pagination.skip + pagination.limit),
    RawMaterial.find(query).sort({ quantityThousandths: 1 }).limit(pagination.skip + pagination.limit),
    Item.countDocuments(query),
    RawMaterial.countDocuments(query),
  ]);

  const rows: AdminLowStockRow[] = [
    ...items.map((item) => ({
      id: String(item._id),
      type: 'item' as const,
      merchantId: String(item.merchantId),
      name: item.name,
      unit: item.unit,
      quantity: fromThousandths(item.quantityThousandths),
      lowStockThreshold: fromThousandths(item.lowStockThresholdThousandths),
      isOutOfStock: item.quantityThousandths <= 0,
    })),
    ...materials.map((material) => ({
      id: String(material._id),
      type: 'material' as const,
      merchantId: String(material.merchantId),
      name: material.name,
      unit: material.unit,
      quantity: fromThousandths(material.quantityThousandths),
      lowStockThreshold: fromThousandths(material.lowStockThresholdThousandths),
      isOutOfStock: material.quantityThousandths <= 0,
    })),
  ].sort((a, b) => a.quantity - b.quantity);

  return {
    rows: rows.slice(pagination.skip, pagination.skip + pagination.limit),
    total: itemCount + materialCount,
  };
}
