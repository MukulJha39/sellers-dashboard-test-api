import type { Request } from 'express';
import { PAYMENT_METHODS } from '../../config/commerce';
import type { Types } from 'mongoose';
import { Business, type BusinessDocument } from '../../models/Business';
import { diffFields, writeAudit } from '../../services/auditService';
import { deleteStoredFile } from '../../services/storageService';
import { AppError } from '../../utils/AppError';
import { normalizeCountryCode, normalizePhoneNumber } from '../../utils/phone';
import type { StockActor } from '../catalog/stockService';

export interface BusinessInput {
  name?: string | null;
  category?: string | null;
  taxNumber?: string | null;

  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;

  contactEmail?: string | null;
  contactCountryCode?: string | null;
  contactPhone?: string | null;
  website?: string | null;

  currency?: string;

  invoiceShowLogo?: boolean;
  invoiceShowAddress?: boolean;
  invoiceShowTaxNumber?: boolean;
  invoiceFooterNote?: string | null;
  defaultPaymentTermsDays?: number | null;

  lowStockAlertsEnabled?: boolean;

  enabledPaymentMethods?: string[];
  defaultOrderStatus?: string;
  defaultTaxPercent?: number | null;
}

const AUDITED_FIELDS = [
  'name',
  'category',
  'taxNumber',
  'city',
  'currency',
  'contactPhone',
  'contactEmail',
  'defaultPaymentTermsDays',
  'lowStockAlertsEnabled',
  'defaultOrderStatus',
  'defaultTaxPercent',
] as const;

/**
 * Returns the merchant's business, creating an empty one on first read.
 *
 * Creating it lazily means a merchant has somewhere to save a single detail the moment
 * they want to, without an onboarding step that asks for everything up front
 * (PRD section 5).
 */
export async function getOrCreateBusiness(merchantId: Types.ObjectId): Promise<BusinessDocument> {
  const existing = await Business.findOne({ merchantId });
  if (existing) return existing;

  try {
    return await Business.create({ merchantId });
  } catch (error) {
    // Two concurrent first reads can race; the unique index makes the loser retry.
    if (typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000) {
      const created = await Business.findOne({ merchantId });
      if (created) return created;
    }
    throw error;
  }
}

/** A trimmed value, or null when the merchant cleared the field. */
function optionalText(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export async function updateBusiness(input: {
  merchantId: Types.ObjectId;
  data: BusinessInput;
  actor: StockActor;
  req?: Request;
}): Promise<BusinessDocument> {
  const business = await getOrCreateBusiness(input.merchantId);

  const before: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) before[field] = business[field] ?? null;

  const text: Array<[keyof BusinessInput & keyof BusinessDocument, string | null | undefined]> = [
    ['name', optionalText(input.data.name)],
    ['taxNumber', optionalText(input.data.taxNumber)],
    ['addressLine1', optionalText(input.data.addressLine1)],
    ['addressLine2', optionalText(input.data.addressLine2)],
    ['city', optionalText(input.data.city)],
    ['state', optionalText(input.data.state)],
    ['postalCode', optionalText(input.data.postalCode)],
    ['country', optionalText(input.data.country)],
    ['contactEmail', optionalText(input.data.contactEmail)],
    ['website', optionalText(input.data.website)],
    ['invoiceFooterNote', optionalText(input.data.invoiceFooterNote)],
    ['category', input.data.category === undefined ? undefined : input.data.category],
  ];

  for (const [field, value] of text) {
    if (value !== undefined) {
      (business as unknown as Record<string, unknown>)[field] = value;
    }
  }

  // The business contact number is a separate, editable field — unlike the merchant's
  // own verified sign-in number, which can never change.
  if (input.data.contactPhone !== undefined) {
    const phone = optionalText(input.data.contactPhone);
    business.contactPhone = typeof phone === 'string' ? normalizePhoneNumber(phone) : null;
    // Clearing the number clears its country code too, so no orphan code remains.
    if (phone === null) business.contactCountryCode = null;
  }
  if (input.data.contactCountryCode !== undefined) {
    const code = optionalText(input.data.contactCountryCode);
    business.contactCountryCode = typeof code === 'string' ? normalizeCountryCode(code) : null;
  }
  if (business.contactPhone && !business.contactCountryCode) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'contact.countryCode', message: 'Choose a country code for the contact number.' },
    ]);
  }

  if (input.data.currency !== undefined) business.currency = input.data.currency;
  if (input.data.invoiceShowLogo !== undefined) business.invoiceShowLogo = input.data.invoiceShowLogo;
  if (input.data.invoiceShowAddress !== undefined) {
    business.invoiceShowAddress = input.data.invoiceShowAddress;
  }
  if (input.data.invoiceShowTaxNumber !== undefined) {
    business.invoiceShowTaxNumber = input.data.invoiceShowTaxNumber;
  }
  if (input.data.defaultPaymentTermsDays !== undefined) {
    business.defaultPaymentTermsDays = input.data.defaultPaymentTermsDays;
  }
  if (input.data.lowStockAlertsEnabled !== undefined) {
    business.lowStockAlertsEnabled = input.data.lowStockAlertsEnabled;
  }

  if (input.data.enabledPaymentMethods !== undefined) {
    // De-duplicated and put back in the server's own order, so the app's method list reads
    // the same for every merchant regardless of the order they ticked them in.
    const chosen = new Set(input.data.enabledPaymentMethods);
    business.enabledPaymentMethods = PAYMENT_METHODS.filter((method) => chosen.has(method));
  }

  if (input.data.defaultOrderStatus !== undefined) {
    business.defaultOrderStatus = input.data.defaultOrderStatus;
  }

  // Null is meaningful: it is how a merchant clears a default tax rate. A `??` here would
  // read it as "not provided" and keep the old value.
  if (input.data.defaultTaxPercent !== undefined) {
    business.defaultTaxPercent = input.data.defaultTaxPercent;
  }

  await business.save();

  const after: Record<string, unknown> = {};
  for (const field of AUDITED_FIELDS) after[field] = business[field] ?? null;

  const changes = diffFields(before, after, AUDITED_FIELDS as unknown as string[]);
  if (changes.length > 0) {
    await writeAudit({
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
      actorLabel: input.actor.label,
      action: 'business.updated',
      targetType: 'business',
      targetId: business._id,
      summary: `Business profile updated (${changes.map((change) => change.field).join(', ')}).`,
      changes,
      req: input.req,
    });
  }

  return business;
}

export async function replaceBusinessLogo(input: {
  merchantId: Types.ObjectId;
  logoUrl: string | null;
  actor: StockActor;
  req?: Request;
}): Promise<BusinessDocument> {
  const business = await getOrCreateBusiness(input.merchantId);
  const previous = business.logoUrl;

  business.logoUrl = input.logoUrl;
  await business.save();

  if (previous && previous !== input.logoUrl) await deleteStoredFile(previous);

  await writeAudit({
    actorType: input.actor.type,
    actorId: input.actor.id ?? null,
    actorLabel: input.actor.label,
    action: input.logoUrl ? 'business.logo_updated' : 'business.logo_removed',
    targetType: 'business',
    targetId: business._id,
    summary: `Business logo ${input.logoUrl ? 'updated' : 'removed'}.`,
    req: input.req,
  });

  return business;
}
