import type { Request } from 'express';
import { Types, type ClientSession } from 'mongoose';
import type { ContactChannel, ContactLanguage } from '../../config/commerce';
import { Customer, type CustomerDocument } from '../../models/Customer';
import type { Gender } from '../../models/Merchant';
import { diffFields, writeAudit } from '../../services/auditService';
import { AppError } from '../../utils/AppError';
import { normalizePhone } from '../../utils/phone';
import { escapeRegex } from '../../utils/pagination';
import type { StockActor } from '../catalog/stockService';

export interface CustomerInput {
  countryCode?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  gender?: Gender;

  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  notes?: string | null;
  tags?: string[] | null;
  dateOfBirth?: string | null;
  companyName?: string | null;
  preferredChannel?: ContactChannel;
  language?: ContactLanguage;
}

const AUDITED_FIELDS = [
  'firstName',
  'lastName',
  'gender',
  'phoneE164',
  'email',
  'city',
  'companyName',
  'preferredChannel',
  'language',
] as const;

/** Only the audited fields, so a diff compares values rather than whole documents. */
function auditSnapshot(customer: CustomerDocument): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) snapshot[field] = customer[field] ?? null;
  return snapshot;
}

function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Tags are deduplicated and trimmed, so "VIP" and "vip " do not both exist. */
function normalizeTags(tags: string[]): string[] {
  const seen = new Map<string, string>();
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) seen.set(key, trimmed);
  }
  return [...seen.values()].slice(0, 20);
}

function parseDate(value: string | null | undefined, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value.trim() === '') return null;

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field, message: 'Enter a valid date.' },
    ]);
  }
  return parsed;
}

export async function loadCustomer(
  merchantId: Types.ObjectId,
  customerId: string,
): Promise<CustomerDocument> {
  if (!Types.ObjectId.isValid(customerId)) {
    throw AppError.notFound('That customer was not found.');
  }

  const customer = await Customer.findOne({ _id: customerId, merchantId });
  if (!customer) throw AppError.notFound('That customer was not found.');
  return customer;
}

/**
 * Creates a customer.
 *
 * One row per phone number per merchant: the same person recorded twice splits their
 * order and payment history, which defeats the point of keeping customers at all. A
 * duplicate is reported with the existing customer's id in `meta`, so the inline
 * create sheet can offer to use that record instead of making the merchant start over.
 */
export async function createCustomer(input: {
  merchantId: Types.ObjectId;
  data: CustomerInput;
  actor: StockActor;
  req?: Request;
}): Promise<CustomerDocument> {
  const { data } = input;

  const phone = normalizePhone(data.countryCode ?? '', data.phone ?? '');
  const existing = await Customer.findOne({
    merchantId: input.merchantId,
    phoneE164: phone.e164,
  });

  if (existing) {
    throw AppError.conflict(
      existing.archived
        ? `${existing.fullName} already uses that number, in your archived customers.`
        : `${existing.fullName} already uses that number.`,
      { meta: { customerId: String(existing._id), archived: existing.archived } },
    );
  }

  const customer = await Customer.create({
    merchantId: input.merchantId,
    countryCode: phone.countryCode,
    phone: phone.phone,
    phoneE164: phone.e164,
    firstName: data.firstName,
    lastName: data.lastName,
    gender: data.gender,
    email: optionalText(data.email) ?? null,
    addressLine1: optionalText(data.addressLine1) ?? null,
    addressLine2: optionalText(data.addressLine2) ?? null,
    city: optionalText(data.city) ?? null,
    state: optionalText(data.state) ?? null,
    postalCode: optionalText(data.postalCode) ?? null,
    country: optionalText(data.country) ?? null,
    notes: optionalText(data.notes) ?? null,
    tags: normalizeTags(data.tags ?? []),
    dateOfBirth: parseDate(data.dateOfBirth, 'dateOfBirth') ?? null,
    companyName: optionalText(data.companyName) ?? null,
    preferredChannel: data.preferredChannel ?? 'none',
    language: data.language ?? 'en',
  });

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'customer.created',
    targetType: 'customer',
    targetId: customer._id,
    summary: `Added customer ${customer.fullName} (${customer.phoneE164}).`,
    req: input.req,
  });

  return customer;
}

export async function updateCustomer(input: {
  merchantId: Types.ObjectId;
  customerId: string;
  data: CustomerInput;
  actor: StockActor;
  req?: Request;
}): Promise<CustomerDocument> {
  const customer = await loadCustomer(input.merchantId, input.customerId);
  const before = auditSnapshot(customer);
  const { data } = input;

  if (data.firstName !== undefined) customer.firstName = data.firstName;
  if (data.lastName !== undefined) customer.lastName = data.lastName;
  if (data.gender !== undefined) customer.gender = data.gender;

  // A customer's number was typed by the merchant, not verified by an OTP, so unlike
  // the merchant's own sign-in number it can be corrected (PRD section 4).
  if (data.phone !== undefined || data.countryCode !== undefined) {
    const phone = normalizePhone(
      data.countryCode ?? customer.countryCode,
      data.phone ?? customer.phone,
    );

    if (phone.e164 !== customer.phoneE164) {
      const clash = await Customer.findOne({
        merchantId: input.merchantId,
        phoneE164: phone.e164,
        _id: { $ne: customer._id },
      });
      if (clash) {
        throw AppError.conflict(`${clash.fullName} already uses that number.`, {
          meta: { customerId: String(clash._id) },
        });
      }
    }

    customer.countryCode = phone.countryCode;
    customer.phone = phone.phone;
    customer.phoneE164 = phone.e164;
  }

  const textFields: Array<[keyof CustomerInput, keyof CustomerDocument]> = [
    ['email', 'email'],
    ['addressLine1', 'addressLine1'],
    ['addressLine2', 'addressLine2'],
    ['city', 'city'],
    ['state', 'state'],
    ['postalCode', 'postalCode'],
    ['country', 'country'],
    ['notes', 'notes'],
    ['companyName', 'companyName'],
  ];
  for (const [from, to] of textFields) {
    const next = optionalText(data[from] as string | null | undefined);
    // set() rather than an index cast, so the path is still checked against the schema.
    if (next !== undefined) customer.set(to, next);
  }

  if (data.tags !== undefined) customer.tags = normalizeTags(data.tags ?? []);

  const dateOfBirth = parseDate(data.dateOfBirth, 'dateOfBirth');
  if (dateOfBirth !== undefined) customer.dateOfBirth = dateOfBirth;

  if (data.preferredChannel !== undefined) customer.preferredChannel = data.preferredChannel;
  if (data.language !== undefined) customer.language = data.language;

  const changes = diffFields(before, auditSnapshot(customer), AUDITED_FIELDS as unknown as string[]);
  await customer.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: 'customer.updated',
    targetType: 'customer',
    targetId: customer._id,
    summary: `Updated customer ${customer.fullName}.`,
    changes,
    req: input.req,
  });

  return customer;
}

/**
 * Archives or restores a customer.
 *
 * Archiving hides them from the pickers and lists; it never touches the orders and
 * payments that reference them. A historical document that lost its customer would be
 * unexplainable, which is the one thing the data-integrity rules forbid
 * (PRD section 33).
 */
export async function setCustomerArchived(input: {
  merchantId: Types.ObjectId;
  customerId: string;
  archived: boolean;
  actor: StockActor;
  req?: Request;
}): Promise<CustomerDocument> {
  const customer = await loadCustomer(input.merchantId, input.customerId);

  if (customer.archived === input.archived) return customer;

  customer.archived = input.archived;
  customer.archivedAt = input.archived ? new Date() : null;
  await customer.save();

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.archived ? 'customer.archived' : 'customer.restored',
    targetType: 'customer',
    targetId: customer._id,
    summary: `${input.archived ? 'Archived' : 'Restored'} customer ${customer.fullName}.`,
    req: input.req,
  });

  return customer;
}

export const CUSTOMER_SORT_FIELDS = [
  'firstName',
  'createdAt',
  'outstandingMinor',
  'lastOrderAt',
] as const;

export interface CustomerFilters {
  search?: string;
  tag?: string;
  archived: boolean;
  /** Only customers who owe something. */
  outstanding?: boolean;
}

export async function listCustomers(
  merchantId: Types.ObjectId,
  filters: CustomerFilters,
  pagination: { skip: number; limit: number },
  sort: Record<string, 1 | -1>,
): Promise<{ items: CustomerDocument[]; total: number }> {
  const query: Record<string, unknown> = { merchantId, archived: filters.archived };

  if (filters.tag) query.tags = filters.tag;
  if (filters.outstanding) query.outstandingMinor = { $gt: 0 };

  if (filters.search) {
    // Escaped, so a merchant searching for "(" gets the customers containing it rather
    // than a regex error.
    const term = escapeRegex(filters.search);
    const pattern = new RegExp(term, 'i');
    query.$or = [
      { firstName: pattern },
      { lastName: pattern },
      { phone: pattern },
      { phoneE164: pattern },
      { companyName: pattern },
      { email: pattern },
    ];
  }

  const [items, total] = await Promise.all([
    Customer.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Customer.countDocuments(query),
  ]);

  return { items, total };
}

/** The distinct tags a merchant has used, for the filter row. */
export async function customerTags(merchantId: Types.ObjectId): Promise<string[]> {
  const tags = await Customer.distinct('tags', { merchantId, archived: false });
  return (tags as string[]).sort((a, b) => a.localeCompare(b));
}

/**
 * Brings a customer's outstanding balance back in step with their orders.
 *
 * Recomputed from the orders rather than incremented: this is a figure a merchant reads
 * at a glance and acts on, and a drift in it is invisible until it is embarrassing. Only
 * live orders count — a cancelled or returned one is owed nothing.
 */
export async function refreshCustomerOutstanding(
  merchantId: Types.ObjectId,
  customerId: Types.ObjectId,
  session?: ClientSession,
): Promise<void> {
  // Imported here rather than at module load: the order service imports this file, and a
  // top-level import both ways would be a cycle.
  const { Order } = await import('../../models/Order');

  const [totals] = await Order.aggregate<{
    count: number;
    total: number;
    paid: number;
    last: Date | null;
  }>([
    {
      $match: {
        merchantId,
        customerId,
        status: { $nin: ['cancelled', 'returned'] },
      },
    },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        total: { $sum: '$totalMinor' },
        paid: { $sum: '$paidMinor' },
        last: { $max: '$orderDate' },
      },
    },
  ]).session(session ?? null);

  await Customer.updateOne(
    { _id: customerId, merchantId },
    {
      $set: {
        outstandingMinor: Math.max(0, (totals?.total ?? 0) - (totals?.paid ?? 0)),
        orderCount: totals?.count ?? 0,
        lastOrderAt: totals?.last ?? null,
      },
    },
    { session },
  );
}
