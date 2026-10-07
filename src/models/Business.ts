import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { PAYMENT_METHODS } from '../config/commerce';
import { BUSINESS_CATEGORIES, CURRENCIES } from '../config/catalog';

export const BUSINESS_STATUSES = ['active', 'suspended'] as const;
export type BusinessStatus = (typeof BUSINESS_STATUSES)[number];

/**
 * A merchant's business profile.
 *
 * Every field except the owner and the currency is optional: setup is progressive and
 * must never block a merchant from using the app (PRD section 5). One business per
 * merchant today, with the shape left ready for multi-business later.
 */
export interface BusinessDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  name?: string | null;
  logoUrl?: string | null;
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

  currency: string;

  invoiceShowLogo: boolean;
  invoiceShowAddress: boolean;
  invoiceShowTaxNumber: boolean;
  invoiceFooterNote?: string | null;
  defaultPaymentTermsDays?: number | null;

  /** Inventory preference: whether low-stock alerts are surfaced in the app. */
  lowStockAlertsEnabled: boolean;

  /**
   * Which payment methods this merchant offers.
   *
   * A subset of the methods the server understands, never a free list: the engine stores
   * the method on every entry and a label it has never heard of could not be rendered,
   * reported on or filtered. Empty means "all of them", so a merchant who has never opened
   * the setting is not quietly left with none.
   */
  enabledPaymentMethods: string[];

  /**
   * What a new order starts as. `draft` suits a merchant who quotes before committing;
   * `confirmed` suits a counter where the sale is the moment of truth.
   */
  defaultOrderStatus: string;

  /** Prefilled on a new order, so a merchant who always charges 18% types it once. */
  defaultTaxPercent?: number | null;

  status: BusinessStatus;
  createdAt: Date;
  updatedAt: Date;
}

const businessSchema = new Schema<BusinessDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, unique: true },

    name: { type: String, default: null, trim: true, maxlength: 120 },
    logoUrl: { type: String, default: null, maxlength: 500 },
    category: { type: String, default: null, enum: [...BUSINESS_CATEGORIES, null] },
    taxNumber: { type: String, default: null, trim: true, maxlength: 40 },

    addressLine1: { type: String, default: null, trim: true, maxlength: 160 },
    addressLine2: { type: String, default: null, trim: true, maxlength: 160 },
    city: { type: String, default: null, trim: true, maxlength: 80 },
    state: { type: String, default: null, trim: true, maxlength: 80 },
    postalCode: { type: String, default: null, trim: true, maxlength: 20 },
    country: { type: String, default: null, trim: true, maxlength: 80 },

    contactEmail: { type: String, default: null, trim: true, lowercase: true, maxlength: 160 },
    contactCountryCode: { type: String, default: null, trim: true, maxlength: 5 },
    contactPhone: { type: String, default: null, trim: true, maxlength: 15 },
    website: { type: String, default: null, trim: true, maxlength: 200 },

    currency: { type: String, required: true, enum: CURRENCIES, default: 'INR' },

    invoiceShowLogo: { type: Boolean, required: true, default: true },
    invoiceShowAddress: { type: Boolean, required: true, default: true },
    invoiceShowTaxNumber: { type: Boolean, required: true, default: false },
    invoiceFooterNote: { type: String, default: null, trim: true, maxlength: 300 },
    defaultPaymentTermsDays: { type: Number, default: null, min: 0, max: 365 },

    lowStockAlertsEnabled: { type: Boolean, required: true, default: true },

    // Validated against the server's own list, so a stored method is always one the
    // payment engine and the reports can understand.
    enabledPaymentMethods: {
      type: [String],
      required: true,
      default: () => [],
      validate: {
        validator: (values: string[]) =>
          values.every((value) => (PAYMENT_METHODS as readonly string[]).includes(value)),
        message: 'Choose payment methods the system understands.',
      },
    },
    defaultOrderStatus: {
      type: String,
      required: true,
      // Only the two a new order may sensibly start as; the rest are reached by moving it on.
      enum: ['draft', 'confirmed'],
      default: 'confirmed',
    },
    defaultTaxPercent: { type: Number, default: null, min: 0, max: 100 },

    status: { type: String, required: true, enum: BUSINESS_STATUSES, default: 'active' },
  },
  {
    collection: 'businesses',
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

businessSchema.index({ status: 1, updatedAt: -1 });
businessSchema.index({ name: 'text' });

export const Business: Model<BusinessDocument> = model<BusinessDocument>('Business', businessSchema);
