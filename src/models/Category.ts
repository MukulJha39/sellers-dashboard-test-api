import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import { CATEGORY_KINDS, type CategoryKind } from '../config/catalog';

/**
 * A grouping for items, services or raw materials.
 *
 * One model for all three kinds, separated by `kind`, so category management is a
 * single screen rather than three near-identical ones.
 */
export interface CategoryDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;
  kind: CategoryKind;
  name: string;
  archived: boolean;
  archivedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const categorySchema = new Schema<CategoryDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    kind: { type: String, required: true, enum: CATEGORY_KINDS },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 60 },
    archived: { type: Boolean, required: true, default: false },
    archivedAt: { type: Date, default: null },
  },
  {
    collection: 'categories',
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

// A merchant cannot have two categories of the same kind with the same name.
categorySchema.index({ merchantId: 1, kind: 1, name: 1 }, { unique: true });
categorySchema.index({ merchantId: 1, kind: 1, archived: 1, name: 1 });

export const Category: Model<CategoryDocument> = model<CategoryDocument>('Category', categorySchema);
