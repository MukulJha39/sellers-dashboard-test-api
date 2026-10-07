import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { archiveSchemaFields, catalogJsonTransform } from './stockFields';

/**
 * A business the merchant buys from (PRD section 11).
 *
 * Only the name is required. A merchant recording a purchase from the shop down the
 * road often knows nothing else, and demanding a phone number would push them into
 * typing a fake one.
 */
export interface SupplierDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  name: string;
  contactPerson?: string | null;
  countryCode?: string | null;
  phone?: string | null;
  phoneE164?: string | null;
  email?: string | null;
  addressLine1?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  notes?: string | null;

  /**
   * What the merchant still owes this supplier, in minor units: a projection of their
   * unpaid purchases, maintained by the payment engine.
   */
  outstandingMinor: number;

  /** Denormalised so the supplier list needs no per-row aggregate. */
  purchaseCount: number;
  totalPurchasedMinor: number;
  lastPurchaseAt?: Date | null;

  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const supplierSchema = new Schema<SupplierDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },

    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 160 },
    contactPerson: { type: String, default: null, trim: true, maxlength: 120 },
    countryCode: { type: String, default: null, trim: true, maxlength: 6 },
    phone: { type: String, default: null, trim: true, maxlength: 20 },
    phoneE164: { type: String, default: null, trim: true, maxlength: 26 },
    email: { type: String, default: null, trim: true, lowercase: true, maxlength: 160 },
    addressLine1: { type: String, default: null, trim: true, maxlength: 160 },
    city: { type: String, default: null, trim: true, maxlength: 80 },
    state: { type: String, default: null, trim: true, maxlength: 80 },
    postalCode: { type: String, default: null, trim: true, maxlength: 20 },
    country: { type: String, default: null, trim: true, maxlength: 80 },
    taxNumber: { type: String, default: null, trim: true, maxlength: 40 },
    notes: { type: String, default: null, trim: true, maxlength: 2000 },

    outstandingMinor: { type: Number, required: true, default: 0, min: 0 },
    purchaseCount: { type: Number, required: true, default: 0, min: 0 },
    totalPurchasedMinor: { type: Number, required: true, default: 0, min: 0 },
    lastPurchaseAt: { type: Date, default: null },

    ...archiveSchemaFields,
  },
  { collection: 'suppliers', timestamps: true, toJSON: catalogJsonTransform },
);

supplierSchema.index({ merchantId: 1, archived: 1, name: 1 });
supplierSchema.index({ merchantId: 1, archived: 1, createdAt: -1 });
// Names are unique per merchant, so the same supplier is not recorded twice.
supplierSchema.index({ merchantId: 1, name: 1 }, { unique: true });
supplierSchema.index({ merchantId: 1, outstandingMinor: -1, archived: 1 });
// Phone numbers are optional here, so uniqueness applies only where one is present.
supplierSchema.index(
  { merchantId: 1, phoneE164: 1 },
  { unique: true, partialFilterExpression: { phoneE164: { $type: 'string' } } },
);

export const Supplier: Model<SupplierDocument> = model<SupplierDocument>(
  'Supplier',
  supplierSchema,
);
