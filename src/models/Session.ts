import { Schema, model, type Document, type Model, type Types } from 'mongoose';

export const SESSION_SUBJECTS = ['merchant', 'admin'] as const;
export type SessionSubject = (typeof SESSION_SUBJECTS)[number];

export interface SessionDocument extends Document<Types.ObjectId> {
  subjectType: SessionSubject;
  subjectId: Types.ObjectId;
  /** Current refresh rotation id. A refresh token only works while it matches. */
  rotationId: string;
  userAgent?: string | null;
  ip?: string | null;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const sessionSchema = new Schema<SessionDocument>(
  {
    subjectType: { type: String, required: true, enum: SESSION_SUBJECTS },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    rotationId: { type: String, required: true },
    userAgent: { type: String, default: null, maxlength: 300 },
    ip: { type: String, default: null, maxlength: 64 },
    lastUsedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null, maxlength: 120 },
  },
  { collection: 'sessions', timestamps: true },
);

sessionSchema.index({ subjectType: 1, subjectId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session: Model<SessionDocument> = model<SessionDocument>('Session', sessionSchema);
