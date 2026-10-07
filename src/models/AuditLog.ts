import { Schema, model, type Document, type Model, type Types } from 'mongoose';

export const AUDIT_ACTOR_TYPES = ['merchant', 'admin', 'system'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export interface AuditChange {
  field: string;
  from?: unknown;
  to?: unknown;
}

export interface AuditLogDocument extends Document<Types.ObjectId> {
  actorType: AuditActorType;
  actorId?: Types.ObjectId | null;
  /** Denormalised so the timeline stays readable even if the actor is later removed. */
  actorLabel: string;
  action: string;
  targetType: string;
  targetId?: Types.ObjectId | null;
  /** Human-readable line for the in-product activity timeline (PRD section 27). */
  summary: string;
  changes: AuditChange[];
  ip?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

const auditLogSchema = new Schema<AuditLogDocument>(
  {
    actorType: { type: String, required: true, enum: AUDIT_ACTOR_TYPES },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorLabel: { type: String, required: true, maxlength: 160 },
    action: { type: String, required: true, maxlength: 80 },
    targetType: { type: String, required: true, maxlength: 60 },
    targetId: { type: Schema.Types.ObjectId, default: null },
    summary: { type: String, required: true, maxlength: 400 },
    changes: {
      type: [
        new Schema<AuditChange>(
          {
            field: { type: String, required: true, maxlength: 80 },
            from: { type: Schema.Types.Mixed },
            to: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    ip: { type: String, default: null, maxlength: 64 },
    requestId: { type: String, default: null, maxlength: 64 },
    metadata: { type: Schema.Types.Mixed, default: null },
  },
  {
    collection: 'audit_logs',
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

auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ actorType: 1, actorId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

export const AuditLog: Model<AuditLogDocument> = model<AuditLogDocument>('AuditLog', auditLogSchema);
