import { Schema, model, type Document, type Model, type Types } from 'mongoose';
import type { PayableType, PaymentDirection, PaymentMethod } from '../config/commerce';
import { PAYABLE_TYPES, PAYMENT_DIRECTIONS, PAYMENT_METHODS } from '../config/commerce';
import { catalogJsonTransform } from './stockFields';

/**
 * One payment, against one payable (PRD section 9).
 *
 * The collection is the ledger of money the same way `StockMovement` is the ledger of
 * stock: entries are append-only, and the `paidMinor` on the parent document is a
 * projection written in the same transaction. A merchant who paid in three
 * instalments sees three rows with their own dates, amounts, methods and notes —
 * which a single "amount paid" field could never show.
 *
 * Amounts are always positive. Direction says which way the money went, so a total
 * can never be made to disagree with the sum of its entries by a stray sign.
 */
export interface PaymentEntryDocument extends Document<Types.ObjectId> {
  merchantId: Types.ObjectId;

  payableType: PayableType;
  payableId: Types.ObjectId;
  /** Snapshot of the payable's reference, so a payment row reads on its own. */
  payableReference: string;

  direction: PaymentDirection;
  amountMinor: number;
  method: PaymentMethod;
  /** Transaction id, cheque number, UPI reference — whatever the merchant has. */
  reference?: string | null;
  paidAt: Date;
  notes?: string | null;

  /**
   * Which installment this payment settled, where the payable has a plan.
   *
   * Stored on the entry rather than inferred later, so a merchant asking "what did I pay
   * towards the March instalment" gets an answer from the ledger rather than from an
   * allocation rule that might have changed since.
   */
  installmentNumber?: number | null;

  /** The balance on the payable after this entry, so a row is readable in isolation. */
  balanceAfterMinor: number;

  actorType: 'merchant' | 'admin' | 'system';
  actorId?: Types.ObjectId | null;
  actorLabel: string;

  createdAt: Date;
  updatedAt: Date;
}

const paymentEntrySchema = new Schema<PaymentEntryDocument>(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },

    payableType: { type: String, required: true, enum: PAYABLE_TYPES },
    payableId: { type: Schema.Types.ObjectId, required: true },
    payableReference: { type: String, required: true, trim: true, maxlength: 20 },

    direction: { type: String, required: true, enum: PAYMENT_DIRECTIONS },
    amountMinor: { type: Number, required: true, min: 1 },
    method: { type: String, required: true, enum: PAYMENT_METHODS },
    reference: { type: String, default: null, trim: true, maxlength: 80 },
    paidAt: { type: Date, required: true },
    notes: { type: String, default: null, trim: true, maxlength: 500 },
    installmentNumber: { type: Number, default: null, min: 1 },

    balanceAfterMinor: { type: Number, required: true, min: 0 },

    actorType: { type: String, required: true, enum: ['merchant', 'admin', 'system'] },
    actorId: { type: Schema.Types.ObjectId, default: null },
    actorLabel: { type: String, required: true, trim: true, maxlength: 160 },
  },
  { collection: 'payment_entries', timestamps: true, toJSON: catalogJsonTransform },
);

paymentEntrySchema.index({ merchantId: 1, payableType: 1, payableId: 1, paidAt: -1 });
paymentEntrySchema.index({ merchantId: 1, paidAt: -1 });
paymentEntrySchema.index({ merchantId: 1, method: 1, paidAt: -1 });
// Groups a payable's entries by the installment they settled.
paymentEntrySchema.index({ payableId: 1, installmentNumber: 1 });

/**
 * The fields that make an entry a record of money moving.
 *
 * These are what the append-only guarantee is about: a payable's `paidMinor` has to stay
 * equal to the sum of its entries, and that is only true if no entry can be made to say a
 * different amount, a different method, or that it belongs to a different payable.
 */
const IMMUTABLE_FIELDS = [
  'merchantId',
  'payableType',
  'payableId',
  'payableReference',
  'direction',
  'amountMinor',
  'method',
  'installmentNumber',
  'balanceAfterMinor',
  'actorType',
  'actorId',
  'actorLabel',
] as const;

/**
 * Append-only where it counts, for the same reason the stock ledger is: a payment history
 * whose amounts can be edited is not a history. A mistake in an amount is corrected by a
 * further entry, and refunds and credits arrive with returns in Phase 5.
 *
 * What an entry says *about itself* — a mistyped cheque number, a note, the date the money
 * actually changed hands — is not money and can be corrected. Guarding those as well would
 * leave a merchant with a permanently wrong reference and no way to fix it, which is a
 * worse record rather than a safer one. Every correction is audited, and the entry it
 * belongs to keeps its amount.
 */
paymentEntrySchema.pre('save', function (next) {
  if (this.isNew) {
    next();
    return;
  }

  const changed = IMMUTABLE_FIELDS.filter((field) => this.isModified(field));
  if (changed.length > 0) {
    next(
      new Error(
        `A payment entry's ${changed.join(', ')} cannot be modified once written. ` +
          'Record a further entry instead.',
      ),
    );
    return;
  }

  next();
});

export const PaymentEntry: Model<PaymentEntryDocument> = model<PaymentEntryDocument>(
  'PaymentEntry',
  paymentEntrySchema,
);
