import { Types } from 'mongoose';
import { Customer, type CustomerDocument } from '../../models/Customer';
import { PaymentEntry, type PaymentEntryDocument } from '../../models/PaymentEntry';
import { Purchase, type PurchaseDocument } from '../../models/Purchase';
import { Supplier, type SupplierDocument } from '../../models/Supplier';
import { AppError } from '../../utils/AppError';
import { escapeRegex, type Pagination } from '../../utils/pagination';

/**
 * Admin-side reads for customers, suppliers, purchases and payments.
 *
 * These span every merchant, with an optional `merchantId` to drill into one, which is
 * what the support workflows need: "show me this merchant's customers" and "show me
 * every overdue purchase" are both questions an administrator asks.
 */

export interface AdminRelationshipFilters {
  merchantId?: string;
  search?: string;
  archived?: boolean;
  outstanding?: boolean;
}

function scopeQuery(filters: AdminRelationshipFilters): Record<string, unknown> {
  const query: Record<string, unknown> = {};

  if (filters.archived !== undefined) query.archived = filters.archived;
  if (filters.outstanding) query.outstandingMinor = { $gt: 0 };

  if (filters.merchantId) {
    if (!Types.ObjectId.isValid(filters.merchantId)) {
      throw AppError.notFound('That merchant was not found.');
    }
    query.merchantId = new Types.ObjectId(filters.merchantId);
  }

  return query;
}

export const ADMIN_CUSTOMER_SORT_FIELDS = [
  'firstName',
  'createdAt',
  'outstandingMinor',
  'lastOrderAt',
] as const;

export async function adminListCustomers(
  filters: AdminRelationshipFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: CustomerDocument[]; total: number }> {
  const query = scopeQuery(filters);

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [
      { firstName: pattern },
      { lastName: pattern },
      { phone: pattern },
      { phoneE164: pattern },
      { companyName: pattern },
      { email: pattern },
    ];
  }

  const [items, total] = await Promise.all([
    Customer.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Customer.countDocuments(query),
  ]);

  return { items, total };
}

/** One customer, found without a merchant scope: support works from an id. */
export async function adminLoadCustomer(customerId: string): Promise<CustomerDocument> {
  if (!Types.ObjectId.isValid(customerId)) {
    throw AppError.notFound('That customer was not found.');
  }

  const customer = await Customer.findById(customerId);
  if (!customer) throw AppError.notFound('That customer was not found.');
  return customer;
}

export const ADMIN_SUPPLIER_SORT_FIELDS = [
  'name',
  'createdAt',
  'outstandingMinor',
  'lastPurchaseAt',
] as const;

export async function adminListSuppliers(
  filters: AdminRelationshipFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: SupplierDocument[]; total: number }> {
  const query = scopeQuery(filters);

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [
      { name: pattern },
      { contactPerson: pattern },
      { phone: pattern },
      { phoneE164: pattern },
      { email: pattern },
    ];
  }

  const [items, total] = await Promise.all([
    Supplier.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Supplier.countDocuments(query),
  ]);

  return { items, total };
}

export async function adminLoadSupplier(supplierId: string): Promise<SupplierDocument> {
  if (!Types.ObjectId.isValid(supplierId)) {
    throw AppError.notFound('That supplier was not found.');
  }

  const supplier = await Supplier.findById(supplierId);
  if (!supplier) throw AppError.notFound('That supplier was not found.');
  return supplier;
}

export const ADMIN_PURCHASE_SORT_FIELDS = [
  'purchaseDate',
  'createdAt',
  'totalMinor',
  'dueDate',
] as const;

export interface AdminPurchaseFilters {
  merchantId?: string;
  search?: string;
  supplierId?: string;
  status?: string;
  paymentStatus?: string;
  overdue?: boolean;
  received?: boolean;
}

export async function adminListPurchases(
  filters: AdminPurchaseFilters,
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
  now: Date = new Date(),
): Promise<{ items: PurchaseDocument[]; total: number }> {
  const query: Record<string, unknown> = {};

  if (filters.merchantId) {
    if (!Types.ObjectId.isValid(filters.merchantId)) {
      throw AppError.notFound('That merchant was not found.');
    }
    query.merchantId = new Types.ObjectId(filters.merchantId);
  }
  if (filters.supplierId) {
    if (!Types.ObjectId.isValid(filters.supplierId)) {
      throw AppError.notFound('That supplier was not found.');
    }
    query.supplierId = new Types.ObjectId(filters.supplierId);
  }
  if (filters.status) query.status = filters.status;
  if (filters.paymentStatus) query.paymentStatus = filters.paymentStatus;
  if (filters.received !== undefined) query.received = filters.received;

  // Overdue is derived from the clock rather than stored, so it is expressed here as
  // a query the index can serve.
  if (filters.overdue) {
    query.status = 'recorded';
    query.paymentStatus = { $ne: 'fully_paid' };
    query.dueDate = { $ne: null, $lt: now };
  }

  if (filters.search) {
    const pattern = new RegExp(escapeRegex(filters.search), 'i');
    query.$or = [{ reference: pattern }, { supplierName: pattern }, { 'lines.name': pattern }];
  }

  const [items, total] = await Promise.all([
    Purchase.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    Purchase.countDocuments(query),
  ]);

  return { items, total };
}

export async function adminLoadPurchase(purchaseId: string): Promise<PurchaseDocument> {
  if (!Types.ObjectId.isValid(purchaseId)) {
    throw AppError.notFound('That purchase was not found.');
  }

  const purchase = await Purchase.findById(purchaseId);
  if (!purchase) throw AppError.notFound('That purchase was not found.');
  return purchase;
}

/** One payment entry, found without a merchant scope: support works from an id. */
export async function adminLoadPayment(paymentId: string): Promise<PaymentEntryDocument> {
  if (!Types.ObjectId.isValid(paymentId)) {
    throw AppError.notFound('That payment was not found.');
  }

  const entry = await PaymentEntry.findById(paymentId);
  if (!entry) throw AppError.notFound('That payment was not found.');
  return entry;
}

export async function adminListPayments(
  filters: {
    merchantId?: string;
    payableType?: string;
    payableId?: string;
    method?: string;
    from?: Date;
    to?: Date;
  },
  pagination: Pagination,
  sort: Record<string, 1 | -1>,
): Promise<{ items: PaymentEntryDocument[]; total: number }> {
  const query: Record<string, unknown> = {};

  if (filters.merchantId) {
    if (!Types.ObjectId.isValid(filters.merchantId)) {
      throw AppError.notFound('That merchant was not found.');
    }
    query.merchantId = new Types.ObjectId(filters.merchantId);
  }
  if (filters.payableType) query.payableType = filters.payableType;
  if (filters.method) query.method = filters.method;
  if (filters.payableId) {
    if (!Types.ObjectId.isValid(filters.payableId)) {
      throw AppError.notFound('That record was not found.');
    }
    query.payableId = new Types.ObjectId(filters.payableId);
  }
  // Filtered on when the money moved, not when the row was written: a payment back-dated
  // to last week belongs in last week's figures.
  if (filters.from || filters.to) {
    query.paidAt = {
      ...(filters.from ? { $gte: filters.from } : {}),
      ...(filters.to ? { $lte: filters.to } : {}),
    };
  }

  const [items, total] = await Promise.all([
    PaymentEntry.find(query).sort(sort).skip(pagination.skip).limit(pagination.limit),
    PaymentEntry.countDocuments(query),
  ]);

  return { items, total };
}

/**
 * Counts for a merchant's drill-down.
 *
 * One query per collection rather than a lookup-heavy aggregation: these are four
 * indexed counts, and a support screen that loads quickly is worth more than clever.
 */
export async function adminRelationshipSummary(merchantId: string): Promise<{
  customers: { active: number; archived: number; withOutstanding: number };
  suppliers: { active: number; archived: number; withOutstanding: number };
  purchases: { recorded: number; cancelled: number; awaitingStock: number; overdue: number };
  outstandingPayableMinor: number;
}> {
  if (!Types.ObjectId.isValid(merchantId)) {
    throw AppError.notFound('That merchant was not found.');
  }

  const id = new Types.ObjectId(merchantId);
  const now = new Date();

  const [
    activeCustomers,
    archivedCustomers,
    customersOwing,
    activeSuppliers,
    archivedSuppliers,
    suppliersOwed,
    recorded,
    cancelled,
    awaitingStock,
    overdue,
    payable,
  ] = await Promise.all([
    Customer.countDocuments({ merchantId: id, archived: false }),
    Customer.countDocuments({ merchantId: id, archived: true }),
    Customer.countDocuments({ merchantId: id, archived: false, outstandingMinor: { $gt: 0 } }),
    Supplier.countDocuments({ merchantId: id, archived: false }),
    Supplier.countDocuments({ merchantId: id, archived: true }),
    Supplier.countDocuments({ merchantId: id, archived: false, outstandingMinor: { $gt: 0 } }),
    Purchase.countDocuments({ merchantId: id, status: 'recorded' }),
    Purchase.countDocuments({ merchantId: id, status: 'cancelled' }),
    Purchase.countDocuments({ merchantId: id, status: 'recorded', received: false }),
    Purchase.countDocuments({
      merchantId: id,
      status: 'recorded',
      paymentStatus: { $ne: 'fully_paid' },
      dueDate: { $ne: null, $lt: now },
    }),
    Purchase.aggregate<{ total: number }>([
      { $match: { merchantId: id, status: 'recorded' } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$totalMinor', '$paidMinor'] } } } },
    ]),
  ]);

  return {
    customers: { active: activeCustomers, archived: archivedCustomers, withOutstanding: customersOwing },
    suppliers: { active: activeSuppliers, archived: archivedSuppliers, withOutstanding: suppliersOwed },
    purchases: { recorded, cancelled, awaitingStock, overdue },
    outstandingPayableMinor: Math.max(0, payable[0]?.total ?? 0),
  };
}
