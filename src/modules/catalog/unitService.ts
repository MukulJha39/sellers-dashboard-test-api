import type { Request } from 'express';
import { Types } from 'mongoose';
import {
  DEFAULT_UNITS,
  UNIT_APPLIES_TO,
  UNIT_ICON_PATTERN,
  type UnitAppliesTo,
  type UnitGroup,
} from '../../config/catalog';
import { Item } from '../../models/Item';
import { MeasurementUnit, type MeasurementUnitDocument } from '../../models/MeasurementUnit';
import { Order } from '../../models/Order';
import { Purchase } from '../../models/Purchase';
import { RawMaterial } from '../../models/RawMaterial';
import { diffFields, writeAudit } from '../../services/auditService';
import type { AuthenticatedAdmin } from '../../types/express';
import { AppError, ErrorCode } from '../../utils/AppError';

/**
 * The unit-of-measurement catalogue.
 *
 * Units are database records managed from the admin panel. Records store a unit's
 * `code`, which never changes, so renaming a unit or changing its symbol is safe.
 */

const INVALID = 'Please correct the highlighted fields.';

/* ------------------------------- presentation ------------------------------ */

export interface UnitView {
  id: string;
  code: string;
  name: string;
  symbol: string;
  icon: string | null;
  group: UnitGroup;
  wholeNumbersOnly: boolean;
  appliesTo: UnitAppliesTo[];
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export function presentUnit(unit: MeasurementUnitDocument): UnitView {
  return {
    id: String(unit._id),
    code: unit.code,
    name: unit.name,
    symbol: unit.symbol,
    icon: unit.icon ?? null,
    group: unit.group ?? 'other',
    wholeNumbersOnly: unit.wholeNumbersOnly,
    appliesTo: [...unit.appliesTo],
    isActive: unit.isActive,
    sortOrder: unit.sortOrder,
    createdAt: unit.createdAt.toISOString(),
    updatedAt: unit.updatedAt.toISOString(),
  };
}

/* --------------------------------- lookups --------------------------------- */

/**
 * Writes the default units the first time the catalogue is empty, so a fresh database
 * (or a freshly wiped test database) behaves exactly as the product did before units
 * became editable.
 */
export async function ensureDefaultUnits(): Promise<void> {
  if ((await MeasurementUnit.estimatedDocumentCount()) > 0) return;
  try {
    await MeasurementUnit.insertMany(
      DEFAULT_UNITS.map(({ legacyIcon: _legacy, ...unit }, index) => ({
        ...unit,
        appliesTo: [...UNIT_APPLIES_TO],
        isActive: true,
        sortOrder: (index + 1) * 10,
      })),
      { ordered: false },
    );
  } catch (error) {
    // Two requests seeding at once: the loser's duplicates are expected and harmless.
    if ((error as { code?: number }).code !== 11000) throw error;
  }
}

/**
 * Brings units written by an earlier version up to date: gives the default units their
 * Material icon and picker group where they have none (or still carry the emoji they
 * briefly shipped with), and drops any icon that is not a Material icon name. A choice
 * an admin made — including clearing an icon — is left alone. Run at startup and by
 * the seed script, not per request.
 */
export async function upgradeUnitPresentation(): Promise<void> {
  await MeasurementUnit.bulkWrite(
    DEFAULT_UNITS.flatMap((unit) => [
      {
        updateOne: {
          filter: { code: unit.code, $or: [{ icon: { $exists: false } }, { icon: unit.legacyIcon }] },
          update: { $set: { icon: unit.icon } },
        },
      },
      {
        updateOne: {
          filter: { code: unit.code, group: { $exists: false } },
          update: { $set: { group: unit.group } },
        },
      },
    ]),
    { ordered: false },
  );
  await MeasurementUnit.updateMany({ group: { $exists: false } }, { $set: { group: 'other' } });
  await MeasurementUnit.updateMany(
    { icon: { $type: 'string', $not: UNIT_ICON_PATTERN } },
    { $set: { icon: null } },
  );
}

export async function listUnits(options: { includeInactive?: boolean } = {}): Promise<MeasurementUnitDocument[]> {
  await ensureDefaultUnits();
  const query = options.includeInactive ? {} : { isActive: true };
  return MeasurementUnit.find(query).sort({ sortOrder: 1, name: 1 });
}

export async function findUnitByCode(code: string): Promise<MeasurementUnitDocument | null> {
  await ensureDefaultUnits();
  return MeasurementUnit.findOne({ code });
}

/**
 * Checks a unit chosen for an item or material.
 *
 * A new choice must be an active unit that applies to that kind of record. Keeping the
 * unit a record already has is always allowed, so deactivating a unit never blocks
 * editing the records that use it.
 */
export async function resolveUnitChoice(input: {
  code: string;
  kind: UnitAppliesTo;
  currentCode?: string;
}): Promise<MeasurementUnitDocument | null> {
  const unit = await findUnitByCode(input.code);
  const keepingCurrent = input.currentCode !== undefined && input.currentCode === input.code;
  if (keepingCurrent) return unit;

  if (!unit || !unit.isActive || !unit.appliesTo.includes(input.kind)) {
    throw AppError.validation(INVALID, [{ field: 'unit', message: 'Choose a unit of measurement.' }]);
  }
  return unit;
}

/** Whole-number units cannot hold a fractional quantity or threshold. */
export async function assertQuantityFitsUnit(
  unit: string | MeasurementUnitDocument | null,
  thousandths: number,
  field: string,
): Promise<void> {
  if (thousandths % 1000 === 0 || !unit) return;
  const resolved = typeof unit === 'string' ? await findUnitByCode(unit) : unit;
  if (resolved?.wholeNumbersOnly) {
    throw AppError.validation(INVALID, [
      { field, message: `A quantity in ${resolved.name.toLowerCase()} must be a whole number.` },
    ]);
  }
}

/* --------------------------------- usage ---------------------------------- */

export interface UnitUsage {
  items: number;
  materials: number;
  orders: number;
  purchases: number;
}

export async function countUnitUsage(code: string): Promise<UnitUsage> {
  const [items, materials, orders, purchases] = await Promise.all([
    Item.countDocuments({ unit: code }),
    RawMaterial.countDocuments({ unit: code }),
    Order.countDocuments({ 'lines.unit': code }),
    Purchase.countDocuments({ 'lines.unit': code }),
  ]);
  return { items, materials, orders, purchases };
}

/** Usage for every unit at once, for the admin list. */
export async function countAllUnitUsage(): Promise<Map<string, UnitUsage>> {
  const byUnit = (rows: Array<{ _id: string; count: number }>) =>
    new Map(rows.map((row) => [row._id, row.count]));
  const lineCounts = (model: typeof Order | typeof Purchase) =>
    (model as typeof Order).aggregate<{ _id: string; count: number }>([
      { $unwind: '$lines' },
      { $match: { 'lines.unit': { $type: 'string' } } },
      // One count per document, not per line.
      { $group: { _id: { unit: '$lines.unit', doc: '$_id' } } },
      { $group: { _id: '$_id.unit', count: { $sum: 1 } } },
    ]);

  const [itemRows, materialRows, orderRows, purchaseRows] = await Promise.all([
    Item.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$unit', count: { $sum: 1 } } }]),
    RawMaterial.aggregate<{ _id: string; count: number }>([{ $group: { _id: '$unit', count: { $sum: 1 } } }]),
    lineCounts(Order),
    lineCounts(Purchase),
  ]);
  const items = byUnit(itemRows);
  const materials = byUnit(materialRows);
  const orders = byUnit(orderRows);
  const purchases = byUnit(purchaseRows);

  const codes = new Set([...items.keys(), ...materials.keys(), ...orders.keys(), ...purchases.keys()]);
  const usage = new Map<string, UnitUsage>();
  for (const code of codes) {
    usage.set(code, {
      items: items.get(code) ?? 0,
      materials: materials.get(code) ?? 0,
      orders: orders.get(code) ?? 0,
      purchases: purchases.get(code) ?? 0,
    });
  }
  return usage;
}

/* ------------------------------ admin changes ------------------------------ */

export interface UnitInput {
  code: string;
  name: string;
  symbol: string;
  icon?: string | null;
  group?: UnitGroup;
  wholeNumbersOnly?: boolean;
  appliesTo?: UnitAppliesTo[];
  isActive?: boolean;
  sortOrder?: number;
}

function actorFields(actor: AuthenticatedAdmin) {
  return {
    actorType: 'admin' as const,
    actorId: actor.objectId,
    actorLabel: `${actor.name} (${actor.email})`,
  };
}

function normaliseAppliesTo(values: UnitAppliesTo[] | undefined): UnitAppliesTo[] | undefined {
  if (values === undefined) return undefined;
  const chosen = UNIT_APPLIES_TO.filter((kind) => values.includes(kind));
  if (chosen.length === 0) {
    throw AppError.validation(INVALID, [
      { field: 'appliesTo', message: 'Choose whether this unit is for items, raw materials or both.' },
    ]);
  }
  return chosen;
}

/**
 * Merchants must always have something to choose. Refuses a change that would leave
 * items or raw materials without a single active unit.
 */
async function assertEveryKindKeepsAUnit(
  current: MeasurementUnitDocument,
  next: { isActive: boolean; appliesTo: UnitAppliesTo[] } | null,
): Promise<void> {
  for (const kind of UNIT_APPLIES_TO) {
    const coversNow = current.isActive && current.appliesTo.includes(kind);
    const coversAfter = next !== null && next.isActive && next.appliesTo.includes(kind);
    // Only a change that takes coverage away can leave a kind empty.
    if (!coversNow || coversAfter) continue;
    const others = await MeasurementUnit.exists({ _id: { $ne: current._id }, isActive: true, appliesTo: kind });
    if (!others) {
      const label = kind === 'item' ? 'items' : 'raw materials';
      throw AppError.conflict(`This is the last active unit for ${label}. Add or activate another one first.`);
    }
  }
}

/** Refuses turning on "whole numbers only" while a record holds a fractional quantity. */
async function assertNoFractionalStock(code: string): Promise<void> {
  const fractional = {
    unit: code,
    $expr: {
      $or: [
        { $ne: [{ $mod: ['$quantityThousandths', 1000] }, 0] },
        { $ne: [{ $mod: ['$lowStockThresholdThousandths', 1000] }, 0] },
      ],
    },
  };
  const [item, material] = await Promise.all([Item.exists(fractional), RawMaterial.exists(fractional)]);
  if (item || material) {
    throw AppError.validation(INVALID, [
      {
        field: 'wholeNumbersOnly',
        message: 'Some records in this unit hold a fractional quantity or low-stock level. Correct them first.',
      },
    ]);
  }
}

export async function createUnit(actor: AuthenticatedAdmin, input: UnitInput, req?: Request): Promise<MeasurementUnitDocument> {
  await ensureDefaultUnits();

  const code = input.code.trim().toLowerCase();
  if (await MeasurementUnit.exists({ code })) {
    throw AppError.validation(INVALID, [{ field: 'code', message: 'A unit with this code already exists.' }]);
  }

  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const last = await MeasurementUnit.findOne().sort({ sortOrder: -1 }).select('sortOrder');
    sortOrder = (last?.sortOrder ?? 0) + 10;
  }

  const unit = await MeasurementUnit.create({
    code,
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    icon: input.icon?.trim() || null,
    group: input.group ?? 'other',
    wholeNumbersOnly: input.wholeNumbersOnly ?? false,
    appliesTo: normaliseAppliesTo(input.appliesTo) ?? [...UNIT_APPLIES_TO],
    isActive: input.isActive ?? true,
    sortOrder,
  });

  await writeAudit({
    ...actorFields(actor),
    action: 'unit.created',
    targetType: 'unit',
    targetId: unit._id,
    summary: `${actor.name} added the unit ${unit.name} (${unit.symbol}).`,
    req,
  });

  return unit;
}

export async function updateUnit(
  actor: AuthenticatedAdmin,
  unitId: string,
  input: Partial<Omit<UnitInput, 'code'>>,
  req?: Request,
): Promise<MeasurementUnitDocument> {
  if (!Types.ObjectId.isValid(unitId)) throw AppError.notFound('That unit was not found.');
  const unit = await MeasurementUnit.findById(unitId);
  if (!unit) throw AppError.notFound('That unit was not found.');

  const before = {
    name: unit.name,
    symbol: unit.symbol,
    icon: unit.icon ?? null,
    group: unit.group,
    wholeNumbersOnly: unit.wholeNumbersOnly,
    appliesTo: unit.appliesTo.join(','),
    isActive: unit.isActive,
    sortOrder: unit.sortOrder,
  };

  const appliesTo = normaliseAppliesTo(input.appliesTo);
  const nextActive = input.isActive ?? unit.isActive;
  const nextAppliesTo = appliesTo ?? unit.appliesTo;
  await assertEveryKindKeepsAUnit(unit, { isActive: nextActive, appliesTo: nextAppliesTo });

  if (input.wholeNumbersOnly === true && !unit.wholeNumbersOnly) {
    await assertNoFractionalStock(unit.code);
  }

  if (input.name !== undefined) unit.name = input.name.trim();
  if (input.symbol !== undefined) unit.symbol = input.symbol.trim();
  if (input.icon !== undefined) unit.icon = input.icon?.trim() || null;
  if (input.group !== undefined) unit.group = input.group;
  if (input.wholeNumbersOnly !== undefined) unit.wholeNumbersOnly = input.wholeNumbersOnly;
  if (appliesTo !== undefined) unit.appliesTo = appliesTo;
  if (input.isActive !== undefined) unit.isActive = input.isActive;
  if (input.sortOrder !== undefined) unit.sortOrder = input.sortOrder;

  await unit.save();

  const after = {
    name: unit.name,
    symbol: unit.symbol,
    icon: unit.icon ?? null,
    group: unit.group,
    wholeNumbersOnly: unit.wholeNumbersOnly,
    appliesTo: unit.appliesTo.join(','),
    isActive: unit.isActive,
    sortOrder: unit.sortOrder,
  };
  const changes = diffFields(before, after, Object.keys(after));

  if (changes.length > 0) {
    await writeAudit({
      ...actorFields(actor),
      action: 'unit.updated',
      targetType: 'unit',
      targetId: unit._id,
      summary: `${actor.name} updated the unit ${unit.name}.`,
      changes,
      req,
    });
  }

  return unit;
}

/**
 * Deletes a unit nobody uses. A unit that any item, material, order or purchase refers
 * to is refused: deactivate it instead, so history keeps reading correctly.
 */
export async function deleteUnit(actor: AuthenticatedAdmin, unitId: string, req?: Request): Promise<void> {
  if (!Types.ObjectId.isValid(unitId)) throw AppError.notFound('That unit was not found.');
  const unit = await MeasurementUnit.findById(unitId);
  if (!unit) throw AppError.notFound('That unit was not found.');

  const usage = await countUnitUsage(unit.code);
  const total = usage.items + usage.materials + usage.orders + usage.purchases;
  if (total > 0) {
    throw AppError.conflict(
      `${unit.name} is used by existing records, so it cannot be deleted. Deactivate it instead.`,
      { code: ErrorCode.RECORD_IN_USE, meta: { usage } },
    );
  }

  await assertEveryKindKeepsAUnit(unit, null);
  await unit.deleteOne();

  await writeAudit({
    ...actorFields(actor),
    action: 'unit.deleted',
    targetType: 'unit',
    targetId: unit._id,
    summary: `${actor.name} deleted the unit ${unit.name} (${unit.code}).`,
    req,
  });
}
