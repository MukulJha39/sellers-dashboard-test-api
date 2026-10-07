import { Schema, model, type Document, type Model, type Types } from 'mongoose';

/**
 * A Merchant is a person who runs their business in the app (PRD section 42).
 *
 * The collection is deliberately still named `users`: the terminology requirement is
 * about product-facing language, not storage naming.
 */
export const GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const;
export type Gender = (typeof GENDERS)[number];

export const MERCHANT_STATUSES = ['active', 'suspended'] as const;
export type MerchantStatus = (typeof MERCHANT_STATUSES)[number];

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export interface MerchantDocument extends Document<Types.ObjectId> {
  countryCode: string;
  phone: string;
  /** Denormalised E.164 value; the uniqueness anchor for a merchant identity. */
  phoneE164: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  photoUrl?: string | null;
  status: MerchantStatus;
  locale: string;
  themeMode: ThemeMode;
  phoneVerifiedAt: Date;
  lastLoginAt?: Date | null;
  suspendedAt?: Date | null;
  suspendedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
  fullName: string;
}

const merchantSchema = new Schema<MerchantDocument>(
  {
    countryCode: { type: String, required: true, trim: true, maxlength: 5 },
    phone: { type: String, required: true, trim: true, maxlength: 15 },
    phoneE164: { type: String, required: true, trim: true, maxlength: 20, unique: true },
    firstName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    gender: { type: String, required: true, enum: GENDERS },
    photoUrl: { type: String, default: null, maxlength: 500 },
    status: { type: String, required: true, enum: MERCHANT_STATUSES, default: 'active' },
    locale: { type: String, required: true, default: 'en', maxlength: 10 },
    themeMode: { type: String, required: true, enum: THEME_MODES, default: 'system' },
    phoneVerifiedAt: { type: Date, required: true },
    lastLoginAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    suspendedReason: { type: String, default: null, maxlength: 300 },
  },
  {
    collection: 'users',
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: Record<string, unknown>) => {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

merchantSchema.virtual('fullName').get(function (this: MerchantDocument) {
  return `${this.firstName} ${this.lastName}`.trim();
});

merchantSchema.index({ countryCode: 1, phone: 1 }, { unique: true });
merchantSchema.index({ status: 1, createdAt: -1 });
merchantSchema.index({ firstName: 'text', lastName: 'text' });

/**
 * Defence in depth for PRD section 4: the verified phone number is the identity anchor
 * and can never change, even if a bug or a crafted payload reaches the model layer.
 */
merchantSchema.pre('save', function (next) {
  if (!this.isNew && (this.isModified('countryCode') || this.isModified('phone') || this.isModified('phoneE164'))) {
    next(new Error('The verified phone number of a merchant cannot be changed.'));
    return;
  }
  next();
});

export const Merchant: Model<MerchantDocument> = model<MerchantDocument>('Merchant', merchantSchema);
