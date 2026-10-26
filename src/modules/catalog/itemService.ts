import type { Request } from 'express';
import { Types } from 'mongoose';
import type { Unit } from '../../config/catalog';
import { Item, type ItemDocument } from '../../models/Item';
import { computeIsLowStock } from '../../models/stockFields';
import { diffFields, writeAudit } from '../../services/auditService';
import { deleteStoredFile } from '../../services/storageService';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';
import { describeMoneyMinor } from '../../utils/money';
import { fromThousandths } from '../../utils/quantity';
import { withTransaction } from '../../db/transaction';
import { assertCatalogRecordDeletable, deleteStockLedgerFor } from './catalogReferences';
import { resolveCategoryId } from './categoryService';
import { recordOpeningStock, type StockActor } from './stockService';
import { assertQuantityFitsUnit, resolveUnitChoice } from './unitService';

// Re-exported for the callers that already import it from here.
export { assertQuantityFitsUnit };

export const ITEM_SORT_FIELDS = [
  'name',
  'createdAt',
  'updatedAt',
  'sellingPriceMinor',
  'quantityThousandths',
] as const;

export interface ItemFilters {
  search?: string;
  categoryId?: string;
  archived?: boolean;
  lowStock?: boolean;
  outOfStock?: boolean;
}

export interface ItemInput {
  name: string;
  categoryId?: string | null;
  description?: string | null;
  sku?: string | null;
  barcode?: string | null;
  unit?: Unit;
  trackStock?: boolean;
  sellingPriceMinor?: number;
  costPriceMinor?: number | null;
  lowStockThresholdThousandths?: number;
  taxRatePercent?: number | null;
  imageUrl?: string | null;
}

export async function listItems(
  merchantId: Types.ObjectId,
  filters: ItemFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: ItemDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId, archived: filters.archived ?? false };

  if (filters.categoryId) {
    if (!Types.ObjectId.isValid(filters.categoryId)) {
      throw AppError.notFound('That category was not found.');
    }
    query.categoryId = new Types.ObjectId(filters.categoryId);
  }

  if (filters.lowStock) query.isLowStock = true;
  if (filters.outOfStock) query.quantityThousandths = { $lte: 0 };

  if (filters.search?.trim()) {
    const pattern = new RegExp(escapeRegex(filters.search.trim()), 'i');
    query.$or = [{ name: pattern }, { sku: pattern }, { barcode: pattern }];
  }

  const [items, total] = await Promise.all([
    Item.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Item.countDocuments(query),
  ]);

  return { items, total };
}

export async function loadItem(
  merchantId: Types.ObjectId,
  itemId: string,
): Promise<ItemDocument> {
  if (!Types.ObjectId.isValid(itemId)) throw AppError.notFound('That item was not found.');

  const item = await Item.findOne({ _id: itemId, merchantId });
  if (!item) throw AppError.notFound('That item was not found.');
  return item;
}

async function assertSkuIsFree(
  merchantId: Types.ObjectId,
  sku: string | null | undefined,
  excludeId?: Types.ObjectId,
): Promise<void> {
  if (!sku) return;

  const clash = await Item.findOne({
    merchantId,
    sku,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });
  if (clash) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'sku', message: 'Another item already uses that SKU.' },
    ]);
  }
}

/**
 * Creates an item, optionally with the stock it starts with.
 *
 * An opening quantity goes through the ledger rather than being written straight onto
 * the document, so even the first quantity has a traceable origin.
 */
export async function createItem(input: {
  merchantId: Types.ObjectId;
  data: ItemInput;
  openingQuantityThousandths?: number;
  actor: StockActor;
  req?: Request;
}): Promise<ItemDocument> {
  const unit = input.data.unit ?? 'piece';
  const threshold = input.data.lowStockThresholdThousandths ?? 0;
  const trackStock = input.data.trackStock ?? true;

  const unitRecord = await resolveUnitChoice({ code: unit, kind: 'item' });
  await assertQuantityFitsUnit(unitRecord, threshold, 'lowStockThreshold');
  if (input.openingQuantityThousandths) {
    await assertQuantityFitsUnit(unitRecord, input.openingQuantityThousandths, 'quantity');
  }

  const sku = input.data.sku?.trim() || null;
  await assertSkuIsFree(input.merchantId, sku);

  const categoryId = await resolveCategoryId(input.merchantId, 'item', input.data.categoryId);

  const item = await Item.create({
    merchantId: input.merchantId,
    name: input.data.name.trim(),
    categoryId,
    description: input.data.description?.trim() || null,
    imageUrl: input.data.imageUrl ?? null,
    sku,
    barcode: input.data.barcode?.trim() || null,
    unit,
    trackStock,
    quantityThousandths: 0,
    totalReceivedThousandths: 0,
    lowStockThresholdThousandths: threshold,
    sellingPriceMinor: input.data.sellingPriceMinor ?? 0,
    costPriceMinor: input.data.costPriceMinor ?? null,
    taxRatePercent: input.data.taxRatePercent ?? null,
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'item.created',
    targetType: 'item',
    targetId: item._id,
    summary: `Item "${item.name}" created at ${describeMoneyMinor(item.sellingPriceMinor)}.`,
    req: input.req,
  });

  if (trackStock && input.openingQuantityThousandths && input.openingQuantityThousandths > 0) {
    await recordOpeningStock({
      merchantId: input.merchantId,
      subjectType: 'item',
      subject: item,
      quantityThousandths: input.openingQuantityThousandths,
      actor: input.actor,
      req: input.req,
    });
    // Re-read so the caller sees the quantity the ledger produced.
    return loadItem(input.merchantId, String(item._id));
  }

  return item;
}

/**
 * Updates an item's details.
 *
 * Quantity is deliberately not updatable here. Stock only ever moves through the
 * ledger, which is what makes every change explainable (PRD section 6.3).
 */
export async function updateItem(input: {
  merchantId: Types.ObjectId;
  itemId: string;
  data: Partial<ItemInput>;
  actor: StockActor;
  req?: Request;
}): Promise<ItemDocument> {
  const item = await loadItem(input.merchantId, input.itemId);

  const before = {
    name: item.name,
    sku: item.sku ?? null,
    unit: item.unit as string,
    sellingPriceMinor: item.sellingPriceMinor,
    costPriceMinor: item.costPriceMinor ?? null,
    lowStockThresholdThousandths: item.lowStockThresholdThousandths,
    trackStock: item.trackStock,
    taxRatePercent: item.taxRatePercent ?? null,
    categoryId: item.categoryId ? String(item.categoryId) : null,
  };

  if (input.data.name !== undefined) item.name = input.data.name.trim();
  if (input.data.description !== undefined) item.description = input.data.description?.trim() || null;
  if (input.data.barcode !== undefined) item.barcode = input.data.barcode?.trim() || null;
  if (input.data.imageUrl !== undefined) item.imageUrl = input.data.imageUrl;
  if (input.data.sellingPriceMinor !== undefined) item.sellingPriceMinor = input.data.sellingPriceMinor;
  if (input.data.costPriceMinor !== undefined) item.costPriceMinor = input.data.costPriceMinor;
  if (input.data.taxRatePercent !== undefined) item.taxRatePercent = input.data.taxRatePercent;

  if (input.data.sku !== undefined) {
    const sku = input.data.sku?.trim() || null;
    await assertSkuIsFree(input.merchantId, sku, item._id);
    item.sku = sku;
  }

  if (input.data.categoryId !== undefined) {
    item.categoryId = await resolveCategoryId(input.merchantId, 'item', input.data.categoryId);
  }

  if (input.data.unit !== undefined) {
    await resolveUnitChoice({ code: input.data.unit, kind: 'item', currentCode: item.unit });
    item.unit = input.data.unit;
  }
  if (input.data.lowStockThresholdThousandths !== undefined) {
    item.lowStockThresholdThousandths = input.data.lowStockThresholdThousandths;
  }

  // Turning tracking off keeps the history but stops the quantity mattering; turning
  // it on starts from whatever the ledger already says.
  if (input.data.trackStock !== undefined) item.trackStock = input.data.trackStock;

  await assertQuantityFitsUnit(item.unit, item.lowStockThresholdThousandths, 'lowStockThreshold');
  await assertQuantityFitsUnit(item.unit, item.quantityThousandths, 'unit');

  item.isLowStock = computeIsLowStock({
    trackStock: item.trackStock,
    quantityThousandths: item.quantityThousandths,
    lowStockThresholdThousandths: item.lowStockThresholdThousandths,
  });

  await item.save();

  const after: Record<string, unknown> = {
    name: item.name,
    sku: item.sku ?? null,
    unit: item.unit,
    sellingPriceMinor: item.sellingPriceMinor,
    costPriceMinor: item.costPriceMinor ?? null,
    lowStockThresholdThousandths: item.lowStockThresholdThousandths,
    trackStock: item.trackStock,
    taxRatePercent: item.taxRatePercent ?? null,
    categoryId: item.categoryId ? String(item.categoryId) : null,
  };

  const changes = diffFields(before, after, Object.keys(before));
  if (changes.length > 0) {
    await writeAudit({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label,
      action: 'item.updated',
      targetType: 'item',
      targetId: item._id,
      summary: `Item "${item.name}" updated (${changes.map((change) => change.field).join(', ')}).`,
      changes,
      req: input.req,
    });
  }

  return item;
}

export async function setItemArchived(input: {
  merchantId: Types.ObjectId;
  itemId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<ItemDocument> {
  const item = await loadItem(input.merchantId, input.itemId);
  if (item.archived === input.archived) return item;

  item.archived = input.archived;
  item.archivedAt = input.archived ? new Date() : null;
  // An archived item should not sit in the low-stock list.
  item.isLowStock = input.archived
    ? false
    : computeIsLowStock({
        trackStock: item.trackStock,
        quantityThousandths: item.quantityThousandths,
        lowStockThresholdThousandths: item.lowStockThresholdThousandths,
      });

  await item.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'item.archived' : 'item.restored',
    targetType: 'item',
    targetId: item._id,
    summary:
      `Item "${item.name}" ${input.archived ? 'archived' : 'restored'} ` +
      `with ${fromThousandths(item.quantityThousandths)} ${item.unit} in stock.`,
    req: input.req,
  });

  return item;
}

/**
 * Permanently removes an item, its stock ledger and its image.
 *
 * Unlike archiving, this cannot be undone, so it is refused outright while any order or
 * purchase still refers to the item. The document and its ledger go in one transaction:
 * a half-deleted item whose movements survive would leave the stock history pointing at
 * a subject that no longer exists. The image file is unlinked only after the database
 * work has committed, because a deleted file cannot be rolled back.
 */
export async function deleteItem(input: {
  merchantId: Types.ObjectId;
  itemId: string;
  actor: StockActor;
  req?: Request;
}): Promise<{ name: string; movementsDeleted: number }> {
  const item = await loadItem(input.merchantId, input.itemId);
  await assertCatalogRecordDeletable(input.merchantId, 'item', item._id);

  const name = item.name;
  const imageUrl = item.imageUrl ?? null;
  const quantityThousandths = item.quantityThousandths;
  const unit = item.unit;

  const movementsDeleted = await withTransaction(async (session) => {
    const removed = await deleteStockLedgerFor(input.merchantId, 'item', item._id, session);
    await Item.deleteOne({ _id: item._id, merchantId: input.merchantId }, session ? { session } : {});
    return removed;
  });

  await deleteStoredFile(imageUrl);

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'item.deleted',
    targetType: 'item',
    targetId: item._id,
    summary:
      `Item "${name}" permanently deleted with ${fromThousandths(quantityThousandths)} ${unit} in stock ` +
      `and ${movementsDeleted} stock movement${movementsDeleted === 1 ? '' : 's'} removed.`,
    req: input.req,
  });

  return { name, movementsDeleted };
}

export async function replaceItemImage(input: {
  merchantId: Types.ObjectId;
  itemId: string;
  imageUrl: string | null;
}): Promise<ItemDocument> {
  const item = await loadItem(input.merchantId, input.itemId);
  const previous = item.imageUrl;

  item.imageUrl = input.imageUrl;
  await item.save();

  if (previous && previous !== input.imageUrl) await deleteStoredFile(previous);
  return item;
}
