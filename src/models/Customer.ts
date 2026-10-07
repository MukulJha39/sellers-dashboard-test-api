import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { ContactChannel, ContactLanguage } from '../config/commerce';
import { CONTACT_CHANNELS, CONTACT_LANGUAGES } from '../config/commerce';
import { GENDERS, type Gender } from './Merchant';
import { archiveSchemaFields, catalogJsonTransform } from './stockFields';

/**
 * A person the merchant sells to (PRD section 7).
 *
 * Phone number, name and gender are the core identity; everything else is optional, so
 * a customer can be created mid-order from three fields and filled in later.
 *
 * Unlike the merchant's own sign-in number, a customer's phone number *is* editable:
 * it was typed by the merchant, not verified by an OTP, and merchants mistype numbers.
 */
export interface CustomerDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  countryCode: string;
  phone: string;
  phoneE164: string;
  firstName: string;
  lastName: string;
  gender: Gender;

  email?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  notes?: string | null;
  tags: string[];
  dateOfBirth?: Date | null;
  companyName?: string | null;
  preferredChannel: ContactChannel;
  language: ContactLanguage;

  /**
   * What this customer owes, in minor units. A projection of their unpaid orders,
   * maintained by the payment engine from Phase 4 onwards; it stays zero in Phase 3
   * because nothing a customer can owe exists yet.
   */
  outstandingMinor: number;

  /** Denormalised counters for the customer list, so a row needs no extra query. */
  orderCount: number;
  lastOrderAt?: Date | null;

  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;

  fullName: string;
}

const customerSchema = new Schema<CustomerDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },

    countryCode: { type: String, required: true, trim: true, maxlength: 6 },
    phone: { type: String, required: true, trim: true, maxlength: 20 },
    phoneE164: { type: String, required: true, trim: true, maxlength: 26 },
    firstName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    gender: { type: String, required: true, enum: GENDERS },

    email: { type: String, default: null, trim: true, lowercase: true, maxlength: 160 },
    addressLine1: { type: String, default: null, trim: true, maxlength: 160 },
    addressLine2: { type: String, default: null, trim: true, maxlength: 160 },
    city: { type: String, default: null, trim: true, maxlength: 80 },
    state: { type: String, default: null, trim: true, maxlength: 80 },
    postalCode: { type: String, default: null, trim: true, maxlength: 20 },
    country: { type: String, default: null, trim: true, maxlength: 80 },
    notes: { type: String, default: null, trim: true, maxlength: 2000 },
    tags: { type: [String], default: [] },
    dateOfBirth: { type: Date, default: null },
    companyName: { type: String, default: null, trim: true, maxlength: 160 },
    preferredChannel: {
      type: String,
      required: true,
      enum: CONTACT_CHANNELS,
      default: 'none',
    },
    language: { type: String, required: true, enum: CONTACT_LANGUAGES, default: 'en' },

    outstandingMinor: { type: Number, required: true, default: 0, min: 0 },
    orderCount: { type: Number, required: true, default: 0, min: 0 },
    lastOrderAt: { type: Date, default: null },

    ...archiveSchemaFields,
  },
  { collection: 'customers', timestamps: true, toJSON: catalogJsonTransform },
);

customerSchema.index({ merchantId: 1, archived: 1, firstName: 1, lastName: 1 });
customerSchema.index({ merchantId: 1, archived: 1, createdAt: -1 });
// One customer per phone number per merchant: the same person in two rows splits their
// history, which is exactly what a merchant is trying to avoid by keeping customers.
customerSchema.index({ merchantId: 1, phoneE164: 1 }, { unique: true });
customerSchema.index({ merchantId: 1, tags: 1, archived: 1 });
// Supports the outstanding-balance list without scanning every customer.
customerSchema.index({ merchantId: 1, outstandingMinor: -1, archived: 1 });

customerSchema.virtual('fullName').get(function (this: CustomerDocument) {
  return `${this.firstName} ${this.lastName}`.trim();
});

export const Customer: Model<CustomerDocument> = model<CustomerDocument>(
  'Customer',
  customerSchema,
);
