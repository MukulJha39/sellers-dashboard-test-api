import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { Unit } from '../config/catalog';
import {
  archiveSchemaFields,
  catalogJsonTransform,
  categoryRefField,
  computeIsLowStock,
  stockSchemaFields,
} from './stockFields';

/**
 * An input the merchant buys before producing or selling something (PRD section 6.2).
 *
 * Shares the stock shape with items but is purchase-oriented: it carries a purchase
 * cost, batch reference and expiry rather than a selling price and SKU.
 */
export interface RawMaterialDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId | null;
  notes?: string | null;
  imageUrl?: string | null;

  unit: Unit;
  trackStock: boolean;
  quantityThousandths: number;
  totalReceivedThousandths: number;
  lowStockThresholdThousandths: number;
  isLowStock: boolean;

  /** What a unit of this material costs to buy. */
  purchaseCostMinor?: number | null;

  batchReference?: string | null;
  expiryDate?: Date | null;

  /**
   * Free-text supplier name until suppliers become records of their own in Phase 3,
   * at which point this is superseded by a reference.
   */
  supplierName?: string | null;

  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const rawMaterialSchema = new Schema<RawMaterialDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    categoryId: categoryRefField,
    notes: { type: String, default: null, trim: true, maxlength: 1000 },
    imageUrl: { type: String, default: null, maxlength: 500 },

    ...stockSchemaFields,

    purchaseCostMinor: { type: Number, default: null, min: 0 },
    batchReference: { type: String, default: null, trim: true, maxlength: 60 },
    expiryDate: { type: Date, default: null },
    supplierName: { type: String, default: null, trim: true, maxlength: 120 },

    ...archiveSchemaFields,
  },
  { collection: 'raw_materials', timestamps: true, toJSON: catalogJsonTransform },
);

rawMaterialSchema.index({ merchantId: 1, archived: 1, name: 1 });
rawMaterialSchema.index({ merchantId: 1, archived: 1, createdAt: -1 });
rawMaterialSchema.index({ merchantId: 1, categoryId: 1, archived: 1 });
rawMaterialSchema.index({ merchantId: 1, isLowStock: 1, archived: 1 });
// Supports surfacing materials that are about to expire.
rawMaterialSchema.index({ merchantId: 1, expiryDate: 1 });
rawMaterialSchema.index({ name: 'text', notes: 'text', batchReference: 'text' });

rawMaterialSchema.pre('save', function (next) {
  this.isLowStock = computeIsLowStock({
    trackStock: this.trackStock,
    quantityThousandths: this.quantityThousandths,
    lowStockThresholdThousandths: this.lowStockThresholdThousandths,
  });
  next();
});

export const RawMaterial: Model<RawMaterialDocument> = model<RawMaterialDocument>(
  'RawMaterial',
  rawMaterialSchema,
);
