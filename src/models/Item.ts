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
 * A physical thing the merchant sells (PRD section 6.3).
 *
 * Selling a tracked item moves stock; that happens through the ledger in Phase 4, never
 * by writing this document's quantity directly.
 */
export interface ItemDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;
  name: string;
  categoryId?: Types.ObjectId | null;
  description?: string | null;
  imageUrl?: string | null;
  sku?: string | null;
  barcode?: string | null;

  unit: Unit;
  trackStock: boolean;
  quantityThousandths: number;
  totalReceivedThousandths: number;
  lowStockThresholdThousandths: number;
  isLowStock: boolean;

  sellingPriceMinor: number;
  costPriceMinor?: number | null;
  taxRatePercent?: number | null;

  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const itemSchema = new Schema<ItemDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 120 },
    categoryId: categoryRefField,
    description: { type: String, default: null, trim: true, maxlength: 1000 },
    imageUrl: { type: String, default: null, maxlength: 500 },
    sku: { type: String, default: null, trim: true, maxlength: 60 },
    barcode: { type: String, default: null, trim: true, maxlength: 60 },

    ...stockSchemaFields,

    sellingPriceMinor: { type: Number, required: true, default: 0, min: 0 },
    costPriceMinor: { type: Number, default: null, min: 0 },
    taxRatePercent: { type: Number, default: null, min: 0, max: 100 },

    ...archiveSchemaFields,
  },
  { collection: 'items', timestamps: true, toJSON: catalogJsonTransform },
);

itemSchema.index({ merchantId: 1, archived: 1, name: 1 });
itemSchema.index({ merchantId: 1, archived: 1, createdAt: -1 });
itemSchema.index({ merchantId: 1, categoryId: 1, archived: 1 });
// Supports the low-stock list without scanning the whole catalog.
itemSchema.index({ merchantId: 1, isLowStock: 1, archived: 1 });
// SKUs are unique per merchant when present, and ignored when not.
itemSchema.index(
  { merchantId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' } } },
);
itemSchema.index({ name: 'text', description: 'text', sku: 'text' });

/** Keeps the derived flag correct however the document was changed. */
itemSchema.pre('save', function (next) {
  this.isLowStock = computeIsLowStock({
    trackStock: this.trackStock,
    quantityThousandths: this.quantityThousandths,
    lowStockThresholdThousandths: this.lowStockThresholdThousandths,
  });
  next();
});

export const Item: Model<ItemDocument> = model<ItemDocument>('Item', itemSchema);
