import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { PaymentStatus, PurchaseStatus } from '../config/commerce';
import { PAYMENT_STATUSES, PURCHASE_STATUSES } from '../config/commerce';
import type { StockSubjectType, Unit } from '../config/catalog';
import { STOCK_SUBJECT_TYPES, UNITS } from '../config/catalog';
import { catalogJsonTransform } from './stockFields';

/**
 * One line of a purchase.
 *
 * `name` and `unit` are snapshots taken when the purchase was recorded, not joins. A
 * purchase is a historical document: renaming an item or archiving it later must not
 * rewrite what the merchant bought last March (PRD section 33).
 */
export interface PurchaseLine {
  subjectType: StockSubjectType;
  subjectId: Types.ObjectId;
  name: string;
  unit: Unit;
  quantityThousandths: number;
  unitCostMinor: number;
  lineTotalMinor: number;
}

export interface PurchaseDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  /** Human-readable, unique per merchant, such as `PUR-0007`. */
  reference: string;

  supplierId: Types.ObjectId;
  /** Snapshot, for the same reason the line names are snapshots. */
  supplierName: string;

  lines: PurchaseLine[];

  subtotalMinor: number;
  /** Freight, loading, and anything else that is part of the bill but not a line. */
  additionalCostMinor: number;
  totalMinor: number;

  purchaseDate: Date;
  dueDate?: Date | null;
  notes?: string | null;

  status: PurchaseStatus;
  cancelledAt?: Date | null;
  cancelledReason?: string | null;

  /** Whether the goods have been taken into stock. */
  received: boolean;
  receivedAt?: Date | null;

  /** Maintained by the payment engine; see `src/modules/payments/paymentEngine.ts`. */
  paidMinor: number;
  paymentStatus: PaymentStatus;

  createdAt: Date;
  updatedAt: Date;
}

const purchaseLineSchema = new Schema<PurchaseLine>(
  {
    subjectType: { type: String, required: true, enum: STOCK_SUBJECT_TYPES },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    unit: { type: String, required: true, enum: UNITS },
    quantityThousandths: { type: Number, required: true, min: 1 },
    unitCostMinor: { type: Number, required: true, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const purchaseSchema = new Schema<PurchaseDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    reference: { type: String, required: true, trim: true, maxlength: 20 },

    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, required: true, trim: true, maxlength: 160 },

    lines: { type: [purchaseLineSchema], required: true },

    subtotalMinor: { type: Number, required: true, min: 0 },
    additionalCostMinor: { type: Number, required: true, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },

    purchaseDate: { type: Date, required: true },
    dueDate: { type: Date, default: null },
    notes: { type: String, default: null, trim: true, maxlength: 2000 },

    status: { type: String, required: true, enum: PURCHASE_STATUSES, default: 'recorded' },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null, trim: true, maxlength: 300 },

    received: { type: Boolean, required: true, default: false },
    receivedAt: { type: Date, default: null },

    paidMinor: { type: Number, required: true, default: 0, min: 0 },
    paymentStatus: { type: String, required: true, enum: PAYMENT_STATUSES, default: 'unpaid' },
  },
  { collection: 'purchases', timestamps: true, toJSON: catalogJsonTransform },
);

purchaseSchema.index({ merchantId: 1, purchaseDate: -1 });
purchaseSchema.index({ merchantId: 1, reference: 1 }, { unique: true });
purchaseSchema.index({ merchantId: 1, supplierId: 1, purchaseDate: -1 });
purchaseSchema.index({ merchantId: 1, status: 1, paymentStatus: 1, purchaseDate: -1 });
// Overdue is a query, not a stored flag: everything not fully paid with a due date in
// the past. This index is what makes that query cheap.
purchaseSchema.index({ merchantId: 1, paymentStatus: 1, dueDate: 1 });
// Finds every purchase that touched one item or material, for its purchase history.
purchaseSchema.index({ merchantId: 1, 'lines.subjectId': 1, purchaseDate: -1 });

export const Purchase: Model<PurchaseDocument> = model<PurchaseDocument>(
  'Purchase',
  purchaseSchema,
);
