import type { Request, Response } from 'express';
import { AppError } from '../../utils/AppError';
import { parsePagination, parseSort } from '../../utils/pagination';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import type { AuthenticatedAdmin } from '../../types/express';
import {
  presentCustomer,
  presentPaymentEntry,
  presentPurchase,
  presentSupplier,
} from '../relationships/relationshipPresenters';
import { setCustomerArchived, updateCustomer, type CustomerInput } from '../relationships/customerService';
import { setSupplierArchived, updateSupplier, type SupplierInput } from '../relationships/supplierService';
import { cancelPurchase } from '../purchases/purchaseService';
import { recordPayment } from '../payments/paymentEngine';
import type { PaymentMethod } from '../../config/commerce';
import type { StockActor } from '../catalog/stockService';
import { loadMerchantNames } from './adminCatalogService';
import {
  ADMIN_CUSTOMER_SORT_FIELDS,
  ADMIN_PURCHASE_SORT_FIELDS,
  ADMIN_SUPPLIER_SORT_FIELDS,
  adminListCustomers,
  adminListPayments,
  adminListPurchases,
  adminListSuppliers,
  adminLoadCustomer,
  adminLoadPurchase,
  adminLoadSupplier,
  adminRelationshipSummary,
  type AdminPurchaseFilters,
  type AdminRelationshipFilters,
} from './adminRelationshipService';

function adminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

/**
 * An administrator acting on a merchant's record.
 *
 * `actorType: 'admin'` reaches the audit trail and the payment ledger, so the merchant
 * can see that support made the change rather than finding an unexplained entry
 * (PRD section 36).
 */
function adminActor(req: Request): StockActor {
  const admin = adminContext(req);
  return { type: 'admin', id: admin.objectId, label: admin.name };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function optionalDate(value: unknown): Date | undefined {
  const text = optionalString(value);
  if (!text) return undefined;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function readFilters(req: Request): AdminRelationshipFilters {
  return {
    merchantId: optionalString(req.query.merchantId),
    search: optionalString(req.query.search),
    archived: optionalBoolean(req.query.archived) ?? false,
    outstanding: optionalBoolean(req.query.outstanding),
  };
}

/* -------------------------------- customers ------------------------------- */

export async function getAdminCustomers(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_CUSTOMER_SORT_FIELDS, { createdAt: -1 });

  const { items, total } = await adminListCustomers(readFilters(req), pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((customer) => customer.merchantId));

  sendList(
    res,
    items.map((customer) => ({
      ...presentCustomer(customer),
      merchantId: String(customer.merchantId),
      merchantName: merchantNames.get(String(customer.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminCustomerById(req: Request, res: Response): Promise<void> {
  const customer = await adminLoadCustomer(req.params.id!);
  const merchantNames = await loadMerchantNames([customer.merchantId]);

  sendData(res, {
    customer: {
      ...presentCustomer(customer),
      merchantId: String(customer.merchantId),
      merchantName: merchantNames.get(String(customer.merchantId)) ?? null,
    },
  });
}

export async function patchAdminCustomer(req: Request, res: Response): Promise<void> {
  const customer = await adminLoadCustomer(req.params.id!);
  const updated = await updateCustomer({
    merchantId: customer.merchantId,
    customerId: String(customer._id),
    data: req.body as CustomerInput,
    actor: adminActor(req),
    req,
  });

  sendData(res, { customer: presentCustomer(updated) });
}

export function adminCustomerArchiveHandler(archived: boolean) {
  return async (req: Request, res: Response): Promise<void> => {
    const customer = await adminLoadCustomer(req.params.id!);
    const updated = await setCustomerArchived({
      merchantId: customer.merchantId,
      customerId: String(customer._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { customer: presentCustomer(updated) });
  };
}

/* -------------------------------- suppliers ------------------------------- */

export async function getAdminSuppliers(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_SUPPLIER_SORT_FIELDS, { createdAt: -1 });

  const { items, total } = await adminListSuppliers(readFilters(req), pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((supplier) => supplier.merchantId));

  sendList(
    res,
    items.map((supplier) => ({
      ...presentSupplier(supplier),
      merchantId: String(supplier.merchantId),
      merchantName: merchantNames.get(String(supplier.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminSupplierById(req: Request, res: Response): Promise<void> {
  const supplier = await adminLoadSupplier(req.params.id!);
  const merchantNames = await loadMerchantNames([supplier.merchantId]);

  sendData(res, {
    supplier: {
      ...presentSupplier(supplier),
      merchantId: String(supplier.merchantId),
      merchantName: merchantNames.get(String(supplier.merchantId)) ?? null,
    },
  });
}

export async function patchAdminSupplier(req: Request, res: Response): Promise<void> {
  const supplier = await adminLoadSupplier(req.params.id!);
  const updated = await updateSupplier({
    merchantId: supplier.merchantId,
    supplierId: String(supplier._id),
    data: req.body as SupplierInput,
    actor: adminActor(req),
    req,
  });

  sendData(res, { supplier: presentSupplier(updated) });
}

export function adminSupplierArchiveHandler(archived: boolean) {
  return async (req: Request, res: Response): Promise<void> => {
    const supplier = await adminLoadSupplier(req.params.id!);
    const updated = await setSupplierArchived({
      merchantId: supplier.merchantId,
      supplierId: String(supplier._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { supplier: presentSupplier(updated) });
  };
}

/* -------------------------------- purchases ------------------------------- */

export async function getAdminPurchases(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_PURCHASE_SORT_FIELDS, { purchaseDate: -1 });

  const filters: AdminPurchaseFilters = {
    merchantId: optionalString(req.query.merchantId),
    search: optionalString(req.query.search),
    supplierId: optionalString(req.query.supplierId),
    status: optionalString(req.query.status),
    paymentStatus: optionalString(req.query.paymentStatus),
    overdue: optionalBoolean(req.query.overdue),
    received: optionalBoolean(req.query.received),
  };

  const { items, total } = await adminListPurchases(filters, pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((purchase) => purchase.merchantId));
  const now = new Date();

  sendList(
    res,
    items.map((purchase) => ({
      ...presentPurchase(purchase, now),
      merchantId: String(purchase.merchantId),
      merchantName: merchantNames.get(String(purchase.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminPurchaseById(req: Request, res: Response): Promise<void> {
  const purchase = await adminLoadPurchase(req.params.id!);
  const merchantNames = await loadMerchantNames([purchase.merchantId]);

  const { items } = await adminListPayments(
    { payableType: 'purchase', payableId: String(purchase._id) },
    { page: 1, limit: 100, skip: 0 },
    { paidAt: -1 },
  );

  sendData(res, {
    purchase: {
      ...presentPurchase(purchase),
      merchantId: String(purchase.merchantId),
      merchantName: merchantNames.get(String(purchase.merchantId)) ?? null,
    },
    payments: items.map(presentPaymentEntry),
  });
}

export async function postAdminPurchaseCancel(req: Request, res: Response): Promise<void> {
  const purchase = await adminLoadPurchase(req.params.id!);
  const updated = await cancelPurchase({
    merchantId: purchase.merchantId,
    purchaseId: String(purchase._id),
    reason: optionalString((req.body as Record<string, unknown>).reason) ?? null,
    actor: adminActor(req),
    req,
  });

  sendData(res, { purchase: presentPurchase(updated) });
}

export async function postAdminPurchasePayment(req: Request, res: Response): Promise<void> {
  const purchase = await adminLoadPurchase(req.params.id!);
  const body = req.body as Record<string, unknown>;

  const result = await recordPayment({
    merchantId: purchase.merchantId,
    payableType: 'purchase',
    payableId: String(purchase._id),
    amountMinor: Number(body.amountMinor),
    method: body.method as PaymentMethod,
    reference: optionalString(body.reference) ?? null,
    paidAt: optionalDate(body.paidAt) ?? null,
    notes: optionalString(body.notes) ?? null,
    actor: adminActor(req),
    req,
  });

  const updated = await adminLoadPurchase(String(purchase._id));
  sendData(
    res,
    { payment: presentPaymentEntry(result.entry), purchase: presentPurchase(updated) },
    201,
  );
}

/* --------------------------------- payments -------------------------------- */

export async function getAdminPayments(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ['paidAt', 'amountMinor', 'createdAt'], { paidAt: -1 });

  const { items, total } = await adminListPayments(
    {
      merchantId: optionalString(req.query.merchantId),
      payableType: optionalString(req.query.payableType),
      payableId: optionalString(req.query.payableId),
      method: optionalString(req.query.method),
      from: optionalDate(req.query.from),
      to: optionalDate(req.query.to),
    },
    pagination,
    sort,
  );

  const merchantNames = await loadMerchantNames(items.map((entry) => entry.merchantId));

  sendList(
    res,
    items.map((entry) => ({
      ...presentPaymentEntry(entry),
      merchantId: String(entry.merchantId),
      merchantName: merchantNames.get(String(entry.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminRelationshipSummary(req: Request, res: Response): Promise<void> {
  sendData(res, { summary: await adminRelationshipSummary(req.params.merchantId!) });
}
