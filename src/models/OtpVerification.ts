import { Schema, model, type Document, type Model, type Types } from 'mongoose';

export const OTP_PURPOSES = ['phone_verification'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export interface OtpVerificationDocument extends Document<Types.ObjectId> {
  countryCode: string;
  phone: string;
  phoneE164: string;
  purpose: OtpPurpose;
  /** Keyed hash of the code. The code itself is never persisted. */
  codeHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt?: Date | null;
  lastSentAt: Date;
  resendCount: number;
  requestIp?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const otpVerificationSchema = new Schema<OtpVerificationDocument>(
  {
    countryCode: { type: String, required: true, trim: true, maxlength: 5 },
    phone: { type: String, required: true, trim: true, maxlength: 15 },
    phoneE164: { type: String, required: true, trim: true, maxlength: 20 },
    purpose: { type: String, required: true, enum: OTP_PURPOSES, default: 'phone_verification' },
    codeHash: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0, min: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
    lastSentAt: { type: Date, required: true },
    resendCount: { type: Number, required: true, default: 0, min: 0 },
    requestIp: { type: String, default: null, maxlength: 64 },
  },
  { collection: 'otp_verifications', timestamps: true },
);

otpVerificationSchema.index({ phoneE164: 1, createdAt: -1 });
// Verification records are short-lived; Mongo removes them an hour after expiry so the
// hourly request quota can still be counted before cleanup.
otpVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export const OtpVerification: Model<OtpVerificationDocument> = model<OtpVerificationDocument>(
  'OtpVerification',
  otpVerificationSchema,
);
