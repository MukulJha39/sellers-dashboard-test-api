import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import {
  STOCK_ADJUSTMENT_REASONS,
  STOCK_MOVEMENT_TYPES,
  STOCK_SUBJECT_TYPES,
  type StockAdjustmentReason,
  type StockMovementType,
  type StockSubjectType,
} from '../config/catalog';

/**
 * The stock ledger: an append-only record of every quantity change.
 *
 * This is the source of truth. An item's or material's `quantityThousandths` is a
 * cached projection of the latest `balanceAfterThousandths` here, so a quantity can
 * always be explained by replaying the ledger (PRD section 6.3).
 *
 * Nothing in the product updates a ledger row after it is written.
 */
export interface StockMovementDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  /** Services are absent from the subject types on purpose. */
  subjectType: StockSubjectType;
  subjectId: Types.ObjectId;
  /** Denormalised so history stays readable after a record is archived. */
  subjectName: string;

  type: StockMovementType;
  reason?: StockAdjustmentReason | null;

  /** Signed change, in thousandths of the unit. */
  deltaThousandths: number;
  /** Balance after applying the change, also in thousandths. */
  balanceAfterThousandths: number;

  note?: string | null;

  actorType: 'merchant' | 'admin' | 'system';
  actorId?: Types.ObjectId | null;
  actorLabel: string;

  /** Set once purchases and orders start moving stock, in Phases 3 and 4. */
  referenceType?: string | null;
  referenceId?: Types.ObjectId | null;

  createdAt: Date;
  updatedAt: Date;
}

const stockMovementSchema = new Schema<StockMovementDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },

    subjectType: { type: String, required: true, enum: STOCK_SUBJECT_TYPES },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    subjectName: { type: String, required: true, maxlength: 120 },

    type: { type: String, required: true, enum: STOCK_MOVEMENT_TYPES },
    reason: { type: String, default: null, enum: [...STOCK_ADJUSTMENT_REASONS, null] },

    deltaThousandths: { type: Number, required: true },
    balanceAfterThousandths: { type: Number, required: true },

    note: { type: String, default: null, trim: true, maxlength: 300 },

    actorType: { type: String, required: true, enum: ['merchant', 'admin', 'system'] },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorLabel: { type: String, required: true, maxlength: 160 },

    referenceType: { type: String, default: null, maxlength: 40 },
    referenceId: { type: Schema.Types.ObjectId, default: null },
  },
  { collection: 'stock_movements', timestamps: true },
);

// The history view for one item or material, newest first.
stockMovementSchema.index({ merchantId: 1, subjectType: 1, subjectId: 1, createdAt: -1 });
// A merchant's whole stock activity feed.
stockMovementSchema.index({ merchantId: 1, createdAt: -1 });
// Admin triage across merchants.
stockMovementSchema.index({ createdAt: -1 });

/** A ledger row is immutable once written. */
stockMovementSchema.pre('save', function (next) {
  if (!this.isNew) {
    next(new Error('Stock ledger entries cannot be modified once written.'));
    return;
  }
  next();
});

export const StockMovement: Model<StockMovementDocument> = model<StockMovementDocument>(
  'StockMovement',
  stockMovementSchema,
);
