import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { BILLING_UNITS, type BillingUnit } from '../config/catalog';
import { archiveSchemaFields, catalogJsonTransform, categoryRefField } from './stockFields';

/**
 * Something the merchant sells by time, session, unit or package (PRD section 6.4).
 *
 * Named `ServiceOffering` in code so it never reads as a service-layer class; the
 * product calls these Services, and the API resource is `/services`.
 *
 * Deliberately carries none of the stock fields: a service can never move physical
 * stock, and the absence of those fields is what guarantees it.
 */
export interface ServiceOfferingDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId | null;
  description?: string | null;
  imageUrl?: string | null;

  billingUnit: BillingUnit;
  rateMinor: number;

  /** Meaningful for hourly and per-session billing; null otherwise. */
  durationMinutes?: number | null;

  taxRatePercent?: number | null;

  /** A service can be taken off the menu without archiving its history. */
  isActive: boolean;

  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const serviceOfferingSchema = new Schema<ServiceOfferingDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    categoryId: categoryRefField,
    description: { type: String, default: null, trim: true, maxlength: 1000 },
    imageUrl: { type: String, default: null, maxlength: 500 },

    billingUnit: { type: String, required: true, enum: BILLING_UNITS, default: 'one_time' },
    rateMinor: { type: Number, required: true, default: 0, min: 0 },
    durationMinutes: { type: Number, default: null, min: 1, max: 60 * 24 * 30 },
    taxRatePercent: { type: Number, default: null, min: 0, max: 100 },

    isActive: { type: Boolean, required: true, default: true },

    ...archiveSchemaFields,
  },
  { collection: 'services', timestamps: true, toJSON: catalogJsonTransform },
);

serviceOfferingSchema.index({ merchantId: 1, archived: 1, name: 1 });
serviceOfferingSchema.index({ merchantId: 1, archived: 1, createdAt: -1 });
serviceOfferingSchema.index({ merchantId: 1, categoryId: 1, archived: 1 });
serviceOfferingSchema.index({ merchantId: 1, isActive: 1, archived: 1 });
serviceOfferingSchema.index({ name: 'text', description: 'text' });

export const ServiceOffering: Model<ServiceOfferingDocument> = model<ServiceOfferingDocument>(
  'ServiceOffering',
  serviceOfferingSchema,
);
