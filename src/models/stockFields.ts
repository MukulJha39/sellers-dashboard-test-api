import { Schema } from 'mongoose';
import { UNITS } from '../config/catalog';

/**
 * The stock shape shared by items and raw materials.
 *
 * Quantities are integers in thousandths of the unit (see utils/quantity.ts) so the
 * ledger can be summed exactly. `isLowStock` is maintained on write rather than being
 * computed per query, because MongoDB cannot index one field compared against another
 * and the low-stock list has to stay fast as a catalog grows.
 */
export const stockSchemaFields = {
  unit: { type: String, required: true, enum: UNITS, default: 'piece' },

  /** Whether this record's quantity is tracked at all. */
  trackStock: { type: Boolean, required: true, default: true },

  /** Current available quantity, always equal to the latest ledger balance. */
  quantityThousandths: { type: Number, required: true, default: 0 },

  /**
   * Everything ever received, which is deliberately separate from what is available
   * now (PRD section 6.2).
   */
  totalReceivedThousandths: { type: Number, required: true, default: 0, min: 0 },

  lowStockThresholdThousandths: { type: Number, required: true, default: 0, min: 0 },

  /** Derived on write from quantity and threshold; see the note above. */
  isLowStock: { type: Boolean, required: true, default: false },
} as const;

/** Keeps the derived low-stock flag in step with the quantity and threshold. */
export function computeIsLowStock(input: {
  trackStock: boolean;
  quantityThousandths: number;
  lowStockThresholdThousandths: number;
}): boolean {
  if (!input.trackStock) return false;
  // A threshold of zero still flags an out-of-stock record, which is the state a
  // merchant most needs to see.
  return input.quantityThousandths <= input.lowStockThresholdThousandths;
}

/** Shared archive fields, so history never loses a record (PRD section 33). */
export const archiveSchemaFields = {
  archived: { type: Boolean, required: true, default: false },
  archivedAt: { type: Date, default: null },
} as const;

export const catalogJsonTransform = {
  transform: (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

export const categoryRefField = {
  type: Schema.Types.ObjectId,
  ref: 'Category',
  default: null,
} as const;
