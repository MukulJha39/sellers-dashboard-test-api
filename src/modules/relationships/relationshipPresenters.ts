import { derivePaymentState, outstandingMinor } from '../payments/paymentEngine';
import type { CustomerDocument } from '../../models/Customer';
import type { PaymentEntryDocument } from '../../models/PaymentEntry';
import type { PurchaseDocument } from '../../models/Purchase';
import type { SupplierDocument } from '../../models/Supplier';
import { fromThousandths } from '../../utils/quantity';

/**
 * API views for customers, suppliers, purchases and payments.
 *
 * Quantities leave as decimals and money as whole minor units, the same conventions
 * the catalog uses. Nothing a client needs is left to be derived from two other
 * fields: `outstandingMinor` and `paymentState` are computed here, once, so the app
 * and the admin panel cannot reach different conclusions from the same document.
 */

export function presentCustomer(customer: CustomerDocument) {
  return {
    id: String(customer._id),
    countryCode: customer.countryCode,
    phone: customer.phone,
    phoneE164: customer.phoneE164,
    firstName: customer.firstName,
    lastName: customer.lastName,
    fullName: customer.fullName,
    gender: customer.gender,

    email: customer.email ?? null,
    address: {
      line1: customer.addressLine1 ?? null,
      line2: customer.addressLine2 ?? null,
      city: customer.city ?? null,
      state: customer.state ?? null,
      postalCode: customer.postalCode ?? null,
      country: customer.country ?? null,
    },
    notes: customer.notes ?? null,
    tags: customer.tags ?? [],
    dateOfBirth: customer.dateOfBirth ? customer.dateOfBirth.toISOString() : null,
    companyName: customer.companyName ?? null,
    preferredChannel: customer.preferredChannel,
    language: customer.language,

    outstandingMinor: customer.outstandingMinor,
    orderCount: customer.orderCount,
    lastOrderAt: customer.lastOrderAt ? customer.lastOrderAt.toISOString() : null,

    archived: customer.archived,
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

export function presentSupplier(supplier: SupplierDocument) {
  return {
    id: String(supplier._id),
    name: supplier.name,
    contactPerson: supplier.contactPerson ?? null,
    countryCode: supplier.countryCode ?? null,
    phone: supplier.phone ?? null,
    phoneE164: supplier.phoneE164 ?? null,
    email: supplier.email ?? null,
    address: {
      line1: supplier.addressLine1 ?? null,
      city: supplier.city ?? null,
      state: supplier.state ?? null,
      postalCode: supplier.postalCode ?? null,
      country: supplier.country ?? null,
    },
    taxNumber: supplier.taxNumber ?? null,
    notes: supplier.notes ?? null,

    outstandingMinor: supplier.outstandingMinor,
    purchaseCount: supplier.purchaseCount,
    totalPurchasedMinor: supplier.totalPurchasedMinor,
    lastPurchaseAt: supplier.lastPurchaseAt ? supplier.lastPurchaseAt.toISOString() : null,

    archived: supplier.archived,
    createdAt: supplier.createdAt.toISOString(),
    updatedAt: supplier.updatedAt.toISOString(),
  };
}

export function presentPurchase(purchase: PurchaseDocument, now: Date = new Date()) {
  const outstanding = outstandingMinor(purchase.totalMinor, purchase.paidMinor);

  return {
    id: String(purchase._id),
    reference: purchase.reference,

    supplierId: String(purchase.supplierId),
    supplierName: purchase.supplierName,

    lines: purchase.lines.map((line) => ({
      subjectType: line.subjectType,
      subjectId: String(line.subjectId),
      name: line.name,
      unit: line.unit,
      quantity: fromThousandths(line.quantityThousandths),
      unitCostMinor: line.unitCostMinor,
      lineTotalMinor: line.lineTotalMinor,
    })),

    subtotalMinor: purchase.subtotalMinor,
    additionalCostMinor: purchase.additionalCostMinor,
    totalMinor: purchase.totalMinor,
    paidMinor: purchase.paidMinor,
    outstandingMinor: outstanding,

    purchaseDate: purchase.purchaseDate.toISOString(),
    dueDate: purchase.dueDate ? purchase.dueDate.toISOString() : null,
    notes: purchase.notes ?? null,

    status: purchase.status,
    cancelledAt: purchase.cancelledAt ? purchase.cancelledAt.toISOString() : null,
    cancelledReason: purchase.cancelledReason ?? null,

    received: purchase.received,
    receivedAt: purchase.receivedAt ? purchase.receivedAt.toISOString() : null,

    paymentStatus: purchase.paymentStatus,
    /**
     * What a client displays. `paymentStatus` is the stored, settled state; this folds
     * in the due date, so an unpaid purchase past its date reads as overdue without
     * anything having to write to the row.
     */
    paymentState:
      purchase.status === 'cancelled'
        ? purchase.paymentStatus
        : derivePaymentState({
            paymentStatus: purchase.paymentStatus,
            dueDate: purchase.dueDate ?? null,
            now,
          }),

    createdAt: purchase.createdAt.toISOString(),
    updatedAt: purchase.updatedAt.toISOString(),
  };
}

export function presentPaymentEntry(entry: PaymentEntryDocument) {
  return {
    id: String(entry._id),
    payableType: entry.payableType,
    payableId: String(entry.payableId),
    payableReference: entry.payableReference,
    direction: entry.direction,
    amountMinor: entry.amountMinor,
    method: entry.method,
    reference: entry.reference ?? null,
    paidAt: entry.paidAt.toISOString(),
    notes: entry.notes ?? null,
    /** Which instalment of a plan this settled, where the payable has one. */
    installmentNumber: entry.installmentNumber ?? null,
    balanceAfterMinor: entry.balanceAfterMinor,
    actorType: entry.actorType,
    actorLabel: entry.actorLabel,
    createdAt: entry.createdAt.toISOString(),
  };
}
