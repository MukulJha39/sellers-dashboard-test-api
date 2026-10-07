import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import { Supplier, type SupplierDocument } from '../../models/Supplier';
import { diffFields, writeAudit } from '../../services/auditService';
import { AppError } from '../../utils/AppError';
import { escapeRegex } from '../../utils/pagination';
import { normalizePhone } from '../../utils/phone';
import type { StockActor } from '../catalog/stockService';

export interface SupplierInput {
  name?: string;
  contactPerson?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  notes?: string | null;
}

const AUDITED_FIELDS = ['name', 'contactPerson', 'phoneE164', 'email', 'city', 'taxNumber'] as const;

/** Only the audited fields, so a diff compares values rather than whole documents. */
function auditSnapshot(supplier: SupplierDocument): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) snapshot[field] = supplier[field] ?? null;
  return snapshot;
}

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function loadSupplier(
  merchantId: Types.ObjectId,
  supplierId: string,
  session?: ClientSession,
): Promise<SupplierDocument> {
  if (!Types.ObjectId.isValid(supplierId)) {
    throw AppError.notFound('That supplier was not found.');
  }

  const query = Supplier.findOne({ _id: supplierId, merchantId });
  if (session) query.session(session);

  const supplier = await query;
  if (!supplier) throw AppError.notFound('That supplier was not found.');
  return supplier;
}

/**
 * Applies the phone fields, or clears them.
 *
 * A supplier's number is optional, so clearing it has to clear the country code with
 * it: a dialling code on its own is not a contact detail.
 */
function applyPhone(supplier: SupplierDocument, data: SupplierInput): void {
  if (data.phone === undefined && data.countryCode === undefined) return;

  // Presence is decided by whether the key was sent, not by `??`: a null is how a
  // client clears the number, and `??` would read it as "not provided" and fall back
  // to the stored value, making the field impossible to empty.
  const rawPhone = data.phone !== undefined ? data.phone : supplier.phone;
  const phoneText = optionalText(rawPhone) ?? null;

  if (phoneText === null) {
    supplier.phone = null;
    supplier.phoneE164 = null;
    supplier.countryCode = null;
    return;
  }

  const rawCode = data.countryCode !== undefined ? data.countryCode : supplier.countryCode;
  const codeText = optionalText(rawCode);
  if (!codeText) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'countryCode', message: 'Choose a country code for the phone number.' },
    ]);
  }

  const phone = normalizePhone(codeText, phoneText);
  supplier.countryCode = phone.countryCode;
  supplier.phone = phone.phone;
  supplier.phoneE164 = phone.e164;
}

async function assertNameFree(
  merchantId: Types.ObjectId,
  name: string,
  excludeId?: Types.ObjectId,
): Promise<void> {
  const clash = await Supplier.findOne({
    merchantId,
    name,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  });

  if (clash) {
    throw AppError.conflict(
      clash.archived
        ? 'You already have a supplier with that name, in your archived suppliers.'
        : 'You already have a supplier with that name.',
      { meta: { supplierId: String(clash._id), archived: clash.archived } },
    );
  }
}

export async function createSupplier(input: {
  merchantId: Types.ObjectId;
  data: SupplierInput;
  actor: StockActor;
  req?: Request;
}): Promise<SupplierDocument> {
  const name = (input.data.name ?? '').trim();
  await assertNameFree(input.merchantId, name);

  const supplier = new Supplier({
    merchantId: input.merchantId,
    name,
    contactPerson: optionalText(input.data.contactPerson) ?? null,
    email: optionalText(input.data.email) ?? null,
    addressLine1: optionalText(input.data.addressLine1) ?? null,
    city: optionalText(input.data.city) ?? null,
    state: optionalText(input.data.state) ?? null,
    postalCode: optionalText(input.data.postalCode) ?? null,
    country: optionalText(input.data.country) ?? null,
    taxNumber: optionalText(input.data.taxNumber) ?? null,
    notes: optionalText(input.data.notes) ?? null,
  });

  applyPhone(supplier, input.data);
  await supplier.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'supplier.created',
    targetType: 'supplier',
    targetId: supplier._id,
    summary: `Added supplier ${supplier.name}.`,
    req: input.req,
  });

  return supplier;
}

export async function updateSupplier(input: {
  merchantId: Types.ObjectId;
  supplierId: string;
  data: SupplierInput;
  actor: StockActor;
  req?: Request;
}): Promise<SupplierDocument> {
  const supplier = await loadSupplier(input.merchantId, input.supplierId);
  const before = auditSnapshot(supplier);

  if (input.data.name !== undefined) {
    const name = input.data.name.trim();
    if (name !== supplier.name) await assertNameFree(input.merchantId, name, supplier._id);
    supplier.name = name;
  }

  const textFields: Array<keyof SupplierInput & keyof SupplierDocument> = [
    'contactPerson',
    'email',
    'addressLine1',
    'city',
    'state',
    'postalCode',
    'country',
    'taxNumber',
    'notes',
  ];
  for (const field of textFields) {
    const next = optionalText(input.data[field] as string | null | undefined);
    // set() rather than an index cast, so the path is still checked against the schema.
    if (next !== undefined) supplier.set(field, next);
  }

  applyPhone(supplier, input.data);

  const changes = diffFields(before, auditSnapshot(supplier), AUDITED_FIELDS as unknown as string[]);
  await supplier.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'supplier.updated',
    targetType: 'supplier',
    targetId: supplier._id,
    summary: `Updated supplier ${supplier.name}.`,
    changes,
    req: input.req,
  });

  return supplier;
}

/**
 * Archives or restores a supplier. Purchases that reference them are untouched: the
 * record of what was bought from whom survives the relationship ending
 * (PRD section 33).
 */
export async function setSupplierArchived(input: {
  merchantId: Types.ObjectId;
  supplierId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<SupplierDocument> {
  const supplier = await loadSupplier(input.merchantId, input.supplierId);

  if (supplier.archived === input.archived) return supplier;

  // Refused rather than allowed with a warning: an archived supplier disappears from
  // the pickers, and a merchant who still owes them money needs them findable.
  if (input.archived && supplier.outstandingMinor > 0) {
    throw AppError.conflict(
      'There is still money outstanding to this supplier. Settle it before archiving them.',
      { meta: { outstanding: supplier.outstandingMinor } },
    );
  }

  supplier.archived = input.archived;
  supplier.archivedAt = input.archived ? new Date() : null;
  await supplier.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'supplier.archived' : 'supplier.restored',
    targetType: 'supplier',
    targetId: supplier._id,
    summary: `${input.archived ? 'Archived' : 'Restored'} supplier ${supplier.name}.`,
    req: input.req,
  });

  return supplier;
}

export const SUPPLIER_SORT_FIELDS = [
  'name',
  'createdAt',
  'outstandingMinor',
  'lastPurchaseAt',
  'totalPurchasedMinor',
] as const;

export interface SupplierFilters {
  search?: string;
  archived: boolean;
  outstanding?: boolean;
}

export async function listSuppliers(
  merchantId: Types.ObjectId,
  filters: SupplierFilters,
  pagination: { skip: number; limit: number },
  sort: Record<string, 1 | -1>,
): Promise<{ items: SupplierDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId, archived: filters.archived };
  if (filters.outstanding) query.outstandingMinor = { $gt: 0 };

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [
      { name: pattern },
      { contactPerson: pattern },
      { phone: pattern },
      { phoneE164: pattern },
      { email: pattern },
      { city: pattern },
    ];
  }

  const [items, total] = await Promise.all([
    Supplier.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Supplier.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Brings a supplier's denormalised purchase totals back in step with their purchases.
 *
 * Called after a purchase is created, cancelled or paid. Recomputed from the purchases
 * rather than incremented, because these are summary figures a merchant reads at a
 * glance and a drift in them is invisible until it is embarrassing.
 */
export async function refreshSupplierTotals(
  merchantId: Types.ObjectId,
  supplierId: Types.ObjectId,
  session?: ClientSession,
): Promise<void> {
  // Imported here rather than at module load: the purchase service imports this file,
  // and a top-level import both ways would be a cycle.
  const { Purchase } = await import('../../models/Purchase');

  const [totals] = await Purchase.aggregate<{
    count: number;
    total: number;
    paid: number;
    last: Date | null;
  }>([
    { $match: { merchantId, supplierId, status: 'recorded' } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: { $sum: '$totalMinor' },
        paid: { $sum: '$paidMinor' },
        last: { $max: '$purchaseDate' },
      },
    },
  ]).session(session ?? null);

  const update = {
    purchaseCount: totals?.count ?? 0,
    totalPurchasedMinor: totals?.total ?? 0,
    outstandingMinor: Math.max(0, (totals?.total ?? 0) - (totals?.paid ?? 0)),
    lastPurchaseAt: totals?.last ?? null,
  };

  await Supplier.updateOne({ _id: supplierId, merchantId }, { $set: update }, { session });
}
