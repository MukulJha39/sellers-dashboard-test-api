import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { BillingUnit, Unit } from '../config/catalog';
import { BILLING_UNITS, UNITS } from '../config/catalog';
import type { PaymentStatus } from '../config/commerce';
import { PAYMENT_STATUSES } from '../config/commerce';
import type {
  DiscountType,
  InstallmentStatus,
  OrderLineType,
  OrderStatus,
} from '../config/orders';
import {
  DISCOUNT_TYPES,
  INSTALLMENT_STATUSES,
  ORDER_LINE_TYPES,
  ORDER_STATUSES,
} from '../config/orders';
import { catalogJsonTransform } from './stockFields';

/**
 * One line of an order (PRD section 8).
 *
 * `name`, `unit`, `billingUnit` and the rates are snapshots taken when the order was
 * created, not joins. An order is a record of what was sold at what price: repricing an
 * item next week must not rewrite what a customer was charged last Tuesday
 * (PRD section 33).
 */
export interface OrderLine {
  lineType: OrderLineType;
  subjectId: Types.ObjectId;
  name: string;

  /** Items carry a unit of measurement; services carry a billing unit instead. */
  unit?: Unit | null;
  billingUnit?: BillingUnit | null;

  quantityThousandths: number;
  unitRateMinor: number;

  /** Minutes, for a service billed by time. Informational: the rate still drives price. */
  durationMinutes?: number | null;

  /** quantity × rate, before any order-level discount or tax. */
  lineTotalMinor: number;
}

/**
 * One scheduled installment (PRD section 9).
 *
 * The schedule lives on the order because it is only ever read with it. The payments
 * themselves stay in the shared payment ledger; `paidMinor` here is a projection of the
 * entries allocated to this installment.
 */
export interface OrderInstallment {
  /** 1-based, stable for the life of the plan, and how a payment names its target. */
  number: number;
  amountMinor: number;
  dueDate: Date;
  paidMinor: number;
  status: InstallmentStatus;
  notes?: string | null;

  /** Set when a reminder for this installment has been sent (Phase 5 fills it in). */
  reminderSentAt?: Date | null;
}

export interface OrderDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  /** Human-readable, unique per merchant, such as `ORD-0042`. */
  reference: string;

  /**
   * Null for an anonymous sale. The PRD allows a counter sale with no customer, and a
   * required customer would push merchants into inventing one (PRD section 8).
   */
  customerId?: Types.ObjectId | null;
  /** Snapshot, so a cancelled or renamed customer never orphans an order. */
  customerName?: string | null;

  lines: OrderLine[];

  subtotalMinor: number;
  discountType: DiscountType;
  /** The percentage the merchant entered, kept only so the form can show it again. */
  discountPercent?: number | null;
  /** The resolved discount, which is what the total is actually built from. */
  discountMinor: number;
  taxPercent?: number | null;
  taxMinor: number;
  totalMinor: number;

  status: OrderStatus;
  /**
   * Whether this order is currently holding stock.
   *
   * Derived from the status, but stored so the one place that moves stock can tell
   * whether it has already done so. Without it, a status change could double-decrement.
   */
  stockCommitted: boolean;
  stockCommittedAt?: Date | null;

  orderDate: Date;
  dueDate?: Date | null;
  completedAt?: Date | null;
  cancelledAt?: Date | null;
  cancelledReason?: string | null;
  returnedAt?: Date | null;
  returnedReason?: string | null;

  notes?: string | null;

  /** Maintained by the payment engine; see `src/modules/payments/paymentEngine.ts`. */
  paidMinor: number;
  paymentStatus: PaymentStatus;

  installments: OrderInstallment[];

  createdAt: Date;
  updatedAt: Date;
}

const orderLineSchema = new Schema<OrderLine>(
  {
    lineType: { type: String, required: true, enum: ORDER_LINE_TYPES },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    unit: { type: String, default: null, enum: [...UNITS, null] },
    billingUnit: { type: String, default: null, enum: [...BILLING_UNITS, null] },
    quantityThousandths: { type: Number, required: true, min: 1 },
    unitRateMinor: { type: Number, required: true, min: 0 },
    durationMinutes: { type: Number, default: null, min: 0 },
    lineTotalMinor: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const installmentSchema = new Schema<OrderInstallment>(
  {
    number: { type: Number, required: true, min: 1 },
    amountMinor: { type: Number, required: true, min: 1 },
    dueDate: { type: Date, required: true },
    paidMinor: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, required: true, enum: INSTALLMENT_STATUSES, default: 'pending' },
    notes: { type: String, default: null, trim: true, maxlength: 300 },
    reminderSentAt: { type: Date, default: null },
  },
  { _id: false },
);

const orderSchema = new Schema<OrderDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    reference: { type: String, required: true, trim: true, maxlength: 20 },

    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null },
    customerName: { type: String, default: null, trim: true, maxlength: 160 },

    lines: { type: [orderLineSchema], required: true },

    subtotalMinor: { type: Number, required: true, min: 0 },
    discountType: { type: String, required: true, enum: DISCOUNT_TYPES, default: 'none' },
    discountPercent: { type: Number, default: null, min: 0, max: 100 },
    discountMinor: { type: Number, required: true, default: 0, min: 0 },
    taxPercent: { type: Number, default: null, min: 0, max: 100 },
    taxMinor: { type: Number, required: true, default: 0, min: 0 },
    totalMinor: { type: Number, required: true, min: 0 },

    status: { type: String, required: true, enum: ORDER_STATUSES, default: 'confirmed' },
    stockCommitted: { type: Boolean, required: true, default: false },
    stockCommittedAt: { type: Date, default: null },

    orderDate: { type: Date, required: true },
    dueDate: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelledReason: { type: String, default: null, trim: true, maxlength: 300 },
    returnedAt: { type: Date, default: null },
    returnedReason: { type: String, default: null, trim: true, maxlength: 300 },

    notes: { type: String, default: null, trim: true, maxlength: 2000 },

    paidMinor: { type: Number, required: true, default: 0, min: 0 },
    paymentStatus: { type: String, required: true, enum: PAYMENT_STATUSES, default: 'unpaid' },

    installments: { type: [installmentSchema], default: [] },
  },
  { collection: 'orders', timestamps: true, toJSON: catalogJsonTransform },
);

orderSchema.index({ merchantId: 1, orderDate: -1 });
orderSchema.index({ merchantId: 1, reference: 1 }, { unique: true });
orderSchema.index({ merchantId: 1, customerId: 1, orderDate: -1 });
orderSchema.index({ merchantId: 1, status: 1, orderDate: -1 });
orderSchema.index({ merchantId: 1, paymentStatus: 1, dueDate: 1 });
// Overdue is a query, not a stored flag: everything unsettled with a due date in the
// past. This index is what keeps that query and the receivables list cheap.
orderSchema.index({ merchantId: 1, status: 1, paymentStatus: 1, dueDate: 1 });
// Finds every order that sold one item, for its sales history.
orderSchema.index({ merchantId: 1, 'lines.subjectId': 1, orderDate: -1 });
// Serves the next-due-installment lookups without scanning every order.
orderSchema.index({ merchantId: 1, 'installments.status': 1, 'installments.dueDate': 1 });

export const Order: Model<OrderDocument> = model<OrderDocument>('Order', orderSchema);
