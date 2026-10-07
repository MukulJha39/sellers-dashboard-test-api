import type { Request, Response } from 'express';
import type { PaymentMethod } from '../../config/commerce';
import { AppError } from '../../utils/AppError';
import { parsePagination, parseSort } from '../../utils/pagination';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import type { AuthenticatedMerchant } from '../../types/express';
import type { StockActor } from '../catalog/stockService';
import {
  annotatePayment,
  listPayments,
  PAYMENT_SORT_FIELDS,
  recordPayment,
} from '../payments/paymentEngine';
import {
  cancelPurchase,
  createPurchase,
  listPurchases,
  loadPurchase,
  PURCHASE_SORT_FIELDS,
  purchaseSummary,
  receivePurchase,
  updatePurchase,
  type PurchaseFilters,
  type PurchaseInput,
} from '../purchases/purchaseService';
import {
  presentCustomer,
  presentPaymentEntry,
  presentPurchase,
  presentSupplier,
} from './relationshipPresenters';
import {
  createCustomer,
  CUSTOMER_SORT_FIELDS,
  customerTags,
  listCustomers,
  loadCustomer,
  setCustomerArchived,
  updateCustomer,
  type CustomerFilters,
  type CustomerInput,
} from './customerService';
import {
  createSupplier,
  listSuppliers,
  loadSupplier,
  setSupplierArchived,
  SUPPLIER_SORT_FIELDS,
  updateSupplier,
  type SupplierFilters,
  type SupplierInput,
} from './supplierService';

function merchantContext(req: Request): AuthenticatedMerchant {
  if (!req.merchant) throw AppError.unauthenticated('Sign in to continue.');
  return req.merchant;
}

function merchantActor(req: Request): StockActor {
  const merchant = merchantContext(req);
  return {
    type: 'merchant',
    id: merchant.objectId,
    label: `${merchant.firstName} ${merchant.lastName}`.trim(),
  };
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

/* -------------------------------- customers ------------------------------- */

export async function getCustomers(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, CUSTOMER_SORT_FIELDS, { firstName: 1 });

  const filters: CustomerFilters = {
    search: optionalString(req.query.search),
    tag: optionalString(req.query.tag),
    archived: optionalBoolean(req.query.archived) ?? false,
    outstanding: optionalBoolean(req.query.outstanding),
  };

  const { items, total } = await listCustomers(merchant.objectId, filters, pagination, sort);
  sendList(res, items.map(presentCustomer), buildPageMeta(pagination.page, pagination.limit, total));
}

export async function getCustomerTags(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  sendData(res, { tags: await customerTags(merchant.objectId) });
}

export async function getCustomerById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const customer = await loadCustomer(merchant.objectId, req.params.id!);
  sendData(res, { customer: presentCustomer(customer) });
}

export async function postCustomer(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const customer = await createCustomer({
    merchantId: merchant.objectId,
    data: req.body as CustomerInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { customer: presentCustomer(customer) }, 201);
}

export async function patchCustomer(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const customer = await updateCustomer({
    merchantId: merchant.objectId,
    customerId: req.params.id!,
    data: req.body as CustomerInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { customer: presentCustomer(customer) });
}

export function customerArchiveHandler(archived: boolean) {
  return async (req: Request, res: Response): Promise<void> => {
    const merchant = merchantContext(req);
    const customer = await setCustomerArchived({
      merchantId: merchant.objectId,
      customerId: req.params.id!,
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { customer: presentCustomer(customer) });
  };
}

/* -------------------------------- suppliers ------------------------------- */

export async function getSuppliers(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, SUPPLIER_SORT_FIELDS, { name: 1 });

  const filters: SupplierFilters = {
    search: optionalString(req.query.search),
    archived: optionalBoolean(req.query.archived) ?? false,
    outstanding: optionalBoolean(req.query.outstanding),
  };

  const { items, total } = await listSuppliers(merchant.objectId, filters, pagination, sort);
  sendList(res, items.map(presentSupplier), buildPageMeta(pagination.page, pagination.limit, total));
}

export async function getSupplierById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const supplier = await loadSupplier(merchant.objectId, req.params.id!);
  sendData(res, { supplier: presentSupplier(supplier) });
}

export async function postSupplier(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const supplier = await createSupplier({
    merchantId: merchant.objectId,
    data: req.body as SupplierInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { supplier: presentSupplier(supplier) }, 201);
}

export async function patchSupplier(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const supplier = await updateSupplier({
    merchantId: merchant.objectId,
    supplierId: req.params.id!,
    data: req.body as SupplierInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { supplier: presentSupplier(supplier) });
}

export function supplierArchiveHandler(archived: boolean) {
  return async (req: Request, res: Response): Promise<void> => {
    const merchant = merchantContext(req);
    const supplier = await setSupplierArchived({
      merchantId: merchant.objectId,
      supplierId: req.params.id!,
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { supplier: presentSupplier(supplier) });
  };
}

/* -------------------------------- purchases ------------------------------- */

function purchaseFiltersFrom(req: Request): PurchaseFilters {
  return {
    search: optionalString(req.query.search),
    supplierId: optionalString(req.query.supplierId),
    subjectId: optionalString(req.query.subjectId),
    status: optionalString(req.query.status) as PurchaseFilters['status'],
    paymentStatus: optionalString(req.query.paymentStatus) as PurchaseFilters['paymentStatus'],
    overdue: optionalBoolean(req.query.overdue),
    received: optionalBoolean(req.query.received),
    from: optionalDate(req.query.from),
    to: optionalDate(req.query.to),
  };
}

export async function getPurchases(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, PURCHASE_SORT_FIELDS, { purchaseDate: -1 });

  const { items, total } = await listPurchases(
    merchant.objectId,
    purchaseFiltersFrom(req),
    pagination,
    sort,
  );

  const now = new Date();
  sendList(
    res,
    items.map((purchase) => presentPurchase(purchase, now)),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getPurchaseSummary(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  sendData(res, { summary: await purchaseSummary(merchant.objectId) });
}

export async function getPurchaseById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const purchase = await loadPurchase(merchant.objectId, req.params.id!);

  // The payment entries come with the purchase: a merchant opening it wants to see
  // what they have paid, and a second round trip for three rows is not worth it.
  const { items } = await listPayments(
    merchant.objectId,
    { payableType: 'purchase', payableId: String(purchase._id) },
    { skip: 0, limit: 100 },
  );

  sendData(res, {
    purchase: presentPurchase(purchase),
    payments: items.map(presentPaymentEntry),
  });
}

export async function postPurchase(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const purchase = await createPurchase({
    merchantId: merchant.objectId,
    data: req.body as PurchaseInput,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { purchase: presentPurchase(purchase) }, 201);
}

export async function patchPurchase(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const purchase = await updatePurchase({
    merchantId: merchant.objectId,
    purchaseId: req.params.id!,
    data: req.body as { purchaseDate?: string | null; dueDate?: string | null; notes?: string | null },
    actor: merchantActor(req),
    req,
  });

  sendData(res, { purchase: presentPurchase(purchase) });
}

export async function postPurchaseReceive(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const purchase = await receivePurchase({
    merchantId: merchant.objectId,
    purchaseId: req.params.id!,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { purchase: presentPurchase(purchase) });
}

export async function postPurchaseCancel(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const purchase = await cancelPurchase({
    merchantId: merchant.objectId,
    purchaseId: req.params.id!,
    reason: optionalString((req.body as Record<string, unknown>).reason) ?? null,
    actor: merchantActor(req),
    req,
  });

  sendData(res, { purchase: presentPurchase(purchase) });
}

/* --------------------------------- payments -------------------------------- */

export async function postPurchasePayment(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as Record<string, unknown>;

  const result = await recordPayment({
    merchantId: merchant.objectId,
    payableType: 'purchase',
    payableId: req.params.id!,
    amountMinor: Number(body.amountMinor),
    method: body.method as PaymentMethod,
    reference: optionalString(body.reference) ?? null,
    paidAt: optionalDate(body.paidAt) ?? null,
    notes: optionalString(body.notes) ?? null,
    actor: merchantActor(req),
    req,
  });

  // The purchase is returned alongside the entry so the caller does not have to refetch
  // it to show the new outstanding amount.
  const purchase = await loadPurchase(merchant.objectId, req.params.id!);
  sendData(
    res,
    { payment: presentPaymentEntry(result.entry), purchase: presentPurchase(purchase) },
    201,
  );
}

/**
 * Corrects a payment entry's description.
 *
 * Not its amount: the route's validator refuses one outright, so a client cannot even
 * attempt it by accident.
 */
export async function patchPayment(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const body = req.body as Record<string, unknown>;

  const entry = await annotatePayment({
    merchantId: merchant.objectId,
    paymentId: req.params.id!,
    // Presence checks, so an explicit null clears a field rather than being ignored.
    ...('reference' in body ? { reference: optionalString(body.reference) ?? null } : {}),
    ...('notes' in body ? { notes: optionalString(body.notes) ?? null } : {}),
    ...(optionalDate(body.paidAt) ? { paidAt: optionalDate(body.paidAt)! } : {}),
    actor: merchantActor(req),
    req,
  });

  sendData(res, { payment: presentPaymentEntry(entry) });
}

export async function getPayments(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, PAYMENT_SORT_FIELDS, { paidAt: -1 });

  const { items, total } = await listPayments(
    merchant.objectId,
    {
      payableType: optionalString(req.query.payableType) as 'purchase' | 'order' | undefined,
      payableId: optionalString(req.query.payableId),
      method: optionalString(req.query.method) as PaymentMethod | undefined,
      direction: optionalString(req.query.direction) as 'in' | 'out' | undefined,
      ...(req.query.installmentNumber
        ? { installmentNumber: Number(req.query.installmentNumber) }
        : {}),
      from: optionalDate(req.query.from),
      to: optionalDate(req.query.to),
    },
    pagination,
    sort,
  );

  sendList(
    res,
    items.map(presentPaymentEntry),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}
