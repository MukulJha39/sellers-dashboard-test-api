import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import {
  UNIT_APPLIES_TO,
  UNIT_CODE_PATTERN,
  UNIT_GROUP_VALUES,
  UNIT_ICON_PATTERN,
  type UnitAppliesTo,
  type UnitGroup,
} from '../config/catalog';

/**
 * A unit of measurement merchants can choose for an item or a raw material.
 *
 * Managed from the admin panel. Items, materials, order lines and purchase lines store
 * the unit's `code`, so the code never changes once created; the name and symbol can.
 */
export interface MeasurementUnitDocument extends Document<Types.ObjectId> {
  code: string;
  name: string;
  /** The label shown after a quantity, for example "kg" or "pieces". */
  symbol: string;
  /** Optional Material Icons name, for example "scale" or "water_drop". */
  icon: string | null;
  /** The picker section this unit appears under, for example "weight". */
  group: UnitGroup;
  /** Counted rather than measured: quantities must be whole numbers. */
  wholeNumbersOnly: boolean;
  /** Which kinds of record may choose this unit. */
  appliesTo: UnitAppliesTo[];
  /** An inactive unit stays on existing records but cannot be newly chosen. */
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const measurementUnitSchema = new Schema<MeasurementUnitDocument>(
  {
    code: { type: String, required: true, unique: true, match: UNIT_CODE_PATTERN, immutable: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: 40 },
    symbol: { type: String, required: true, trim: true, minlength: 1, maxlength: 12 },
    icon: { type: String, default: null, trim: true, match: UNIT_ICON_PATTERN },
    group: { type: String, required: true, enum: UNIT_GROUP_VALUES, default: 'other' },
    wholeNumbersOnly: { type: Boolean, required: true, default: false },
    appliesTo: {
      type: [{ type: String, enum: UNIT_APPLIES_TO }],
      required: true,
      default: () => [...UNIT_APPLIES_TO],
    },
    isActive: { type: Boolean, required: true, default: true },
    sortOrder: { type: Number, required: true, default: 0 },
  },
  {
    collection: 'measurement_units',
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

measurementUnitSchema.index({ isActive: 1, sortOrder: 1, name: 1 });

export const MeasurementUnit: Model<MeasurementUnitDocument> = model<MeasurementUnitDocument>(
  'MeasurementUnit',
  measurementUnitSchema,
);
