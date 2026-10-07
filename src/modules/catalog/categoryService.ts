import type { Request } from 'express';
import { Types } from 'mongoose';
import type { CategoryKind } from '../../config/catalog';
import { Category, type CategoryDocument } from '../../models/Category';
import { Item } from '../../models/Item';
import { RawMaterial } from '../../models/RawMaterial';
import { ServiceOffering } from '../../models/ServiceOffering';
import { writeAudit } from '../../services/auditService';
import { AppError } from '../../utils/AppError';
import type { StockActor } from './stockService';
import type { CategoryNames } from './catalogPresenters';

function modelForKind(kind: CategoryKind) {
  switch (kind) {
    case 'item':
      return Item;
    case 'service':
      return ServiceOffering;
    case 'material':
      return RawMaterial;
  }
}

/** Names for a set of category ids, so list endpoints can label rows in one query. */
export async function loadCategoryNames(
  merchantId: Types.ObjectId,
  categoryIds: Array<Types.ObjectId | null | undefined>,
): Promise<CategoryNames> {
  const ids = categoryIds.filter((id): id is Types.ObjectId => Boolean(id));
  if (ids.length === 0) return new Map<string, string>();

  const categories = await Category.find({ merchantId, _id: { $in: ids } })
    .select('name')
    .lean();

  return new Map<string, string>(
    categories.map((category) => [String(category._id), category.name]),
  );
}

/**
 * Validates that a category belongs to this merchant and groups the right kind.
 *
 * Returning null for an absent category keeps categories optional everywhere.
 */
export async function resolveCategoryId(
  merchantId: Types.ObjectId,
  kind: CategoryKind,
  categoryId: unknown,
): Promise<Types.ObjectId | null> {
  if (categoryId === undefined || categoryId === null || categoryId === '') return null;

  const id = String(categoryId);
  if (!Types.ObjectId.isValid(id)) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'categoryId', message: 'Choose a category from your list.' },
    ]);
  }

  const category = await Category.findOne({ _id: id, merchantId, kind });
  if (!category) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'categoryId', message: 'Choose a category from your list.' },
    ]);
  }

  return category._id;
}

export async function listCategories(
  merchantId: Types.ObjectId,
  options: { kind?: CategoryKind; includeArchived?: boolean } = {},
): Promise<Array<{ category: CategoryDocument; usageCount: number }>> {
  const query: Record<string, unknown> = { merchantId };
  if (options.kind) query.kind = options.kind;
  if (!options.includeArchived) query.archived = false;

  const categories = await Category.find(query).sort({ kind: 1, name: 1 });
  if (categories.length === 0) return [];

  // One count per kind present, rather than one per category.
  const kinds = Array.from(new Set(categories.map((category) => category.kind)));
  const usage = new Map<string, number>();

  await Promise.all(
    kinds.map(async (kind) => {
      const grouped = await modelForKind(kind).aggregate<{ _id: Types.ObjectId | null; count: number }>([
        { $match: { merchantId, archived: false, categoryId: { $ne: null } } },
        { $group: { _id: '$categoryId', count: { $sum: 1 } } },
      ]);
      for (const row of grouped) {
        if (row._id) usage.set(String(row._id), row.count);
      }
    }),
  );

  return categories.map((category) => ({
    category,
    usageCount: usage.get(String(category._id)) ?? 0,
  }));
}

export async function createCategory(input: {
  merchantId: Types.ObjectId;
  kind: CategoryKind;
  name: string;
  actor: StockActor;
  req?: Request;
}): Promise<CategoryDocument> {
  const name = input.name.trim();

  const existing = await Category.findOne({ merchantId: input.merchantId, kind: input.kind, name });
  if (existing) {
    // An archived duplicate is restored rather than refused, which is what a merchant
    // retyping an old category name expects.
    if (existing.archived) {
      existing.archived = false;
      existing.archivedAt = null;
      await existing.save();
      return existing;
    }
    throw AppError.conflict('You already have a category with that name.');
  }

  const category = await Category.create({ merchantId: input.merchantId, kind: input.kind, name });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'category.created',
    targetType: 'category',
    targetId: category._id,
    summary: `Category "${name}" created for ${input.kind}s.`,
    req: input.req,
  });

  return category;
}

export async function renameCategory(input: {
  merchantId: Types.ObjectId;
  categoryId: string;
  name: string;
  actor: StockActor;
  req?: Request;
}): Promise<CategoryDocument> {
  const category = await loadCategory(input.merchantId, input.categoryId);
  const name = input.name.trim();
  const previous = category.name;

  if (previous === name) return category;

  const clash = await Category.findOne({
    merchantId: input.merchantId,
    kind: category.kind,
    name,
    _id: { $ne: category._id },
  });
  if (clash) throw AppError.conflict('You already have a category with that name.');

  category.name = name;
  await category.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'category.renamed',
    targetType: 'category',
    targetId: category._id,
    summary: `Category renamed from "${previous}" to "${name}".`,
    changes: [{ field: 'name', from: previous, to: name }],
    req: input.req,
  });

  return category;
}

/**
 * Archives a category.
 *
 * Records already filed under it keep their reference, so their history stays intact
 * (PRD section 33); the category simply stops being offered for new records.
 */
export async function setCategoryArchived(input: {
  merchantId: Types.ObjectId;
  categoryId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<CategoryDocument> {
  const category = await loadCategory(input.merchantId, input.categoryId);
  if (category.archived === input.archived) return category;

  category.archived = input.archived;
  category.archivedAt = input.archived ? new Date() : null;
  await category.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'category.archived' : 'category.restored',
    targetType: 'category',
    targetId: category._id,
    summary: `Category "${category.name}" ${input.archived ? 'archived' : 'restored'}.`,
    req: input.req,
  });

  return category;
}

export async function loadCategory(
  merchantId: Types.ObjectId,
  categoryId: string,
): Promise<CategoryDocument> {
  if (!Types.ObjectId.isValid(categoryId)) throw AppError.notFound('That category was not found.');

  const category = await Category.findOne({ _id: categoryId, merchantId });
  if (!category) throw AppError.notFound('That category was not found.');
  return category;
}
