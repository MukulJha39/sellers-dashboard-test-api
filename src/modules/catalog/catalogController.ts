import type { Request, Response } from 'express';
import type { Types } from 'mongoose';
import {
  BILLING_UNITS,
  BUSINESS_CATEGORIES,
  CURRENCIES,
  DURATION_BILLING_UNITS,
  STOCK_ADJUSTMENT_REASONS,
  UNITS,
  WHOLE_NUMBER_UNITS,
  type BillingUnit,
  type CategoryKind,
  type StockAdjustmentReason,
  type StockMovementType,
  type StockSubjectType,
  type Unit,
} from '../../config/catalog';
import {
  CONTACT_CHANNELS,
  CONTACT_LANGUAGES,
  PAYMENT_METHODS,
  PAYMENT_STATES,
} from '../../config/commerce';
import {
  DISCOUNT_TYPES,
  EDITABLE_ORDER_STATUSES,
  INSTALLMENT_STATUSES,
  MAX_INSTALLMENTS,
  MAX_ORDER_LINES,
  ORDER_LINE_TYPES,
  ORDER_STATUSES,
  ORDER_TRANSITIONS,
  STOCK_HOLDING_ORDER_STATUSES,
  TERMINAL_ORDER_STATUSES,
} from '../../config/orders';
import { storeImage } from '../../services/storageService';
import { AppError, ErrorCode } from '../../utils/AppError';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import { parsePagination, parseSort } from '../../utils/pagination';
import { toThousandths } from '../../utils/quantity';
import type { AuthenticatedMerchant } from '../../types/express';
import {
  presentCategory,
  presentItem,
  presentRawMaterial,
  presentService,
  presentStockMovement,
} from './catalogPresenters';
import {
  createCategory,
  listCategories,
  loadCategoryNames,
  renameCategory,
  setCategoryArchived,
} from './categoryService';
import {
  createItem,
  ITEM_SORT_FIELDS,
  listItems,
  loadItem,
  replaceItemImage,
  setItemArchived,
  updateItem,
  type ItemFilters,
  type ItemInput,
} from './itemService';
import {
  createMaterial,
  listMaterials,
  loadMaterial,
  MATERIAL_SORT_FIELDS,
  replaceMaterialImage,
  setMaterialArchived,
  updateMaterial,
  type MaterialFilters,
  type MaterialInput,
} from './materialService';
import {
  createService,
  listServices,
  loadService,
  replaceServiceImage,
  SERVICE_SORT_FIELDS,
  setServiceArchived,
  updateService,
  type ServiceFilters,
  type ServiceInput,
} from './serviceCatalogService';
import {
  applyStockMovement,
  listStockMovements,
  loadStockSubject,
  setStockQuantity,
  type StockActor,
} from './stockService';
import { catalogSummary, lowStockRecords } from './summaryService';

/* --------------------------------- helpers -------------------------------- */

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

/** Reads a decimal quantity from the body and returns it in thousandths. */
function quantityFromBody(body: Record<string, unknown>, key: string): number | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  return toThousandths(Number(value));
}

/* ---------------------------------- meta ---------------------------------- */

/**
 * The vocabulary the clients need: units, billing units, adjustment reasons and so on.
 *
 * Served rather than hard-coded in the app and the admin panel, so the three surfaces
 * cannot drift apart.
 */
export async function getCatalogMeta(_req: Request, res: Response): Promise<void> {
  sendData(res, {
    units: UNITS.map((unit) => ({ value: unit, wholeNumbersOnly: WHOLE_NUMBER_UNITS.has(unit) })),
    billingUnits: BILLING_UNITS.map((unit) => ({
      value: unit,
      supportsDuration: DURATION_BILLING_UNITS.has(unit),
    })),
    stockAdjustmentReasons: STOCK_ADJUSTMENT_REASONS,
    businessCategories: BUSINESS_CATEGORIES,
    currencies: CURRENCIES,
    // Phase 3's vocabulary rides along in the same document: one fetch at launch, and
    // one place that can drift rather than two.
    paymentMethods: PAYMENT_METHODS,
    paymentStates: PAYMENT_STATES,
    contactChannels: CONTACT_CHANNELS,
    contactLanguages: CONTACT_LANGUAGES,
    // Phase 4's order vocabulary, including the lifecycle itself. A client that knows
    // which transitions are legal can grey out the rest instead of offering a button
    // that the server will refuse — and it learns the rules from the server rather than
    // keeping a second copy of the map.
    orderStatuses: ORDER_STATUSES.map((status) => ({
      value: status,
      allowedNext: ORDER_TRANSITIONS[status],
      holdsStock: STOCK_HOLDING_ORDER_STATUSES.has(status),
      editable: EDITABLE_ORDER_STATUSES.has(status),
      terminal: TERMINAL_ORDER_STATUSES.has(status),
    })),
    orderLineTypes: ORDER_LINE_TYPES,
    discountTypes: DISCOUNT_TYPES,
    installmentStatuses: INSTALLMENT_STATUSES,
    limits: { maxInstallments: MAX_INSTALLMENTS, maxOrderLines: MAX_ORDER_LINES },
  });
}

export async function getCatalogSummary(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  sendData(res, { summary: await catalogSummary(merchant.objectId) });
}

export async function getLowStock(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
  sendData(res, { records: await lowStockRecords(merchant.objectId, limit) });
}

/* -------------------------------- categories ------------------------------ */

export async function getCategories(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const kind = optionalString(req.query.kind) as CategoryKind | undefined;

  const rows = await listCategories(merchant.objectId, {
    ...(kind ? { kind } : {}),
    includeArchived: optionalBoolean(req.query.includeArchived) ?? false,
  });

  sendData(res, {
    categories: rows.map((row) => presentCategory(row.category, row.usageCount)),
  });
}

export async function postCategory(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const category = await createCategory({
    merchantId: merchant.objectId,
    kind: String(req.body.kind) as CategoryKind,
    name: String(req.body.name),
    actor: merchantActor(req),
    req,
  });

  sendData(res, { category: presentCategory(category) }, 201);
}

export async function patchCategory(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const category = await renameCategory({
    merchantId: merchant.objectId,
    categoryId: String(req.params.id),
    name: String(req.body.name),
    actor: merchantActor(req),
    req,
  });

  sendData(res, { category: presentCategory(category) });
}

export function categoryArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const merchant = merchantContext(req);
    const category = await setCategoryArchived({
      merchantId: merchant.objectId,
      categoryId: String(req.params.id),
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { category: presentCategory(category) });
  };
}

/* ---------------------------------- items --------------------------------- */

function readItemInput(body: Record<string, unknown>): Partial<ItemInput> {
  const input: Partial<ItemInput> = {};

  if (body.name !== undefined) input.name = String(body.name);
  if (body.categoryId !== undefined) input.categoryId = body.categoryId as string | null;
  if (body.description !== undefined) input.description = body.description as string | null;
  if (body.sku !== undefined) input.sku = body.sku as string | null;
  if (body.barcode !== undefined) input.barcode = body.barcode as string | null;
  if (body.unit !== undefined) input.unit = String(body.unit) as Unit;
  if (body.trackStock !== undefined) input.trackStock = Boolean(body.trackStock);
  if (body.sellingPriceMinor !== undefined) input.sellingPriceMinor = Number(body.sellingPriceMinor);
  if (body.costPriceMinor !== undefined) {
    input.costPriceMinor = body.costPriceMinor === null ? null : Number(body.costPriceMinor);
  }
  if (body.taxRatePercent !== undefined) {
    input.taxRatePercent = body.taxRatePercent === null ? null : Number(body.taxRatePercent);
  }

  const threshold = quantityFromBody(body, 'lowStockThreshold');
  if (threshold !== undefined) input.lowStockThresholdThousandths = threshold;

  return input;
}

export async function getItems(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, ITEM_SORT_FIELDS, { createdAt: -1 });

  const filters: ItemFilters = {};
  const search = optionalString(req.query.search);
  const categoryId = optionalString(req.query.categoryId);
  if (search) filters.search = search;
  if (categoryId) filters.categoryId = categoryId;
  const archived = optionalBoolean(req.query.archived);
  if (archived !== undefined) filters.archived = archived;
  if (optionalBoolean(req.query.lowStock)) filters.lowStock = true;
  if (optionalBoolean(req.query.outOfStock)) filters.outOfStock = true;

  const { items, total } = await listItems(merchant.objectId, filters, pagination, sort);
  const names = await loadCategoryNames(merchant.objectId, items.map((item) => item.categoryId));

  sendList(
    res,
    items.map((item) => presentItem(item, names)),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getItemById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const item = await loadItem(merchant.objectId, String(req.params.id));
  const names = await loadCategoryNames(merchant.objectId, [item.categoryId]);

  sendData(res, { item: presentItem(item, names) });
}

export async function postItem(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const input = readItemInput(req.body as Record<string, unknown>);
  if (!input.name) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'name', message: 'Enter a name of 1 to 120 characters.' },
    ]);
  }

  const opening = quantityFromBody(req.body as Record<string, unknown>, 'openingQuantity');

  const item = await createItem({
    merchantId: merchant.objectId,
    data: input as ItemInput,
    ...(opening === undefined ? {} : { openingQuantityThousandths: opening }),
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [item.categoryId]);
  sendData(res, { item: presentItem(item, names) }, 201);
}

export async function patchItem(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const item = await updateItem({
    merchantId: merchant.objectId,
    itemId: String(req.params.id),
    data: readItemInput(req.body as Record<string, unknown>),
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [item.categoryId]);
  sendData(res, { item: presentItem(item, names) });
}

export function itemArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const merchant = merchantContext(req);
    const item = await setItemArchived({
      merchantId: merchant.objectId,
      itemId: String(req.params.id),
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { item: presentItem(item) });
  };
}

export async function putItemImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  if (!req.file?.buffer) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose an image to upload.');
  }

  const stored = await storeImage(req.file.buffer, 'items');
  const item = await replaceItemImage({
    merchantId: merchant.objectId,
    itemId: String(req.params.id),
    imageUrl: stored.url,
  });

  sendData(res, { item: presentItem(item) });
}

export async function deleteItemImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const item = await replaceItemImage({
    merchantId: merchant.objectId,
    itemId: String(req.params.id),
    imageUrl: null,
  });

  sendData(res, { item: presentItem(item) });
}

/* --------------------------------- services ------------------------------- */

function readServiceInput(body: Record<string, unknown>): Partial<ServiceInput> {
  const input: Partial<ServiceInput> = {};

  if (body.name !== undefined) input.name = String(body.name);
  if (body.categoryId !== undefined) input.categoryId = body.categoryId as string | null;
  if (body.description !== undefined) input.description = body.description as string | null;
  if (body.billingUnit !== undefined) input.billingUnit = String(body.billingUnit) as BillingUnit;
  if (body.rateMinor !== undefined) input.rateMinor = Number(body.rateMinor);
  if (body.durationMinutes !== undefined) {
    input.durationMinutes = body.durationMinutes === null ? null : Number(body.durationMinutes);
  }
  if (body.taxRatePercent !== undefined) {
    input.taxRatePercent = body.taxRatePercent === null ? null : Number(body.taxRatePercent);
  }
  if (body.isActive !== undefined) input.isActive = Boolean(body.isActive);

  return input;
}

export async function getServices(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, SERVICE_SORT_FIELDS, { createdAt: -1 });

  const filters: ServiceFilters = {};
  const search = optionalString(req.query.search);
  const categoryId = optionalString(req.query.categoryId);
  const billingUnit = optionalString(req.query.billingUnit) as BillingUnit | undefined;
  if (search) filters.search = search;
  if (categoryId) filters.categoryId = categoryId;
  if (billingUnit) filters.billingUnit = billingUnit;
  const archived = optionalBoolean(req.query.archived);
  if (archived !== undefined) filters.archived = archived;
  const isActive = optionalBoolean(req.query.isActive);
  if (isActive !== undefined) filters.isActive = isActive;

  const { items, total } = await listServices(merchant.objectId, filters, pagination, sort);
  const names = await loadCategoryNames(merchant.objectId, items.map((service) => service.categoryId));

  sendList(
    res,
    items.map((service) => presentService(service, names)),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getServiceById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const service = await loadService(merchant.objectId, String(req.params.id));
  const names = await loadCategoryNames(merchant.objectId, [service.categoryId]);

  sendData(res, { service: presentService(service, names) });
}

export async function postService(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const input = readServiceInput(req.body as Record<string, unknown>);
  if (!input.name) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'name', message: 'Enter a name of 1 to 120 characters.' },
    ]);
  }

  const service = await createService({
    merchantId: merchant.objectId,
    data: input as ServiceInput,
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [service.categoryId]);
  sendData(res, { service: presentService(service, names) }, 201);
}

export async function patchService(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const service = await updateService({
    merchantId: merchant.objectId,
    serviceId: String(req.params.id),
    data: readServiceInput(req.body as Record<string, unknown>),
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [service.categoryId]);
  sendData(res, { service: presentService(service, names) });
}

export function serviceArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const merchant = merchantContext(req);
    const service = await setServiceArchived({
      merchantId: merchant.objectId,
      serviceId: String(req.params.id),
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { service: presentService(service) });
  };
}

export async function putServiceImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  if (!req.file?.buffer) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose an image to upload.');
  }

  const stored = await storeImage(req.file.buffer, 'services');
  const service = await replaceServiceImage({
    merchantId: merchant.objectId,
    serviceId: String(req.params.id),
    imageUrl: stored.url,
  });

  sendData(res, { service: presentService(service) });
}

export async function deleteServiceImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const service = await replaceServiceImage({
    merchantId: merchant.objectId,
    serviceId: String(req.params.id),
    imageUrl: null,
  });

  sendData(res, { service: presentService(service) });
}

/* -------------------------------- materials ------------------------------- */

function readMaterialInput(body: Record<string, unknown>): Partial<MaterialInput> {
  const input: Partial<MaterialInput> = {};

  if (body.name !== undefined) input.name = String(body.name);
  if (body.categoryId !== undefined) input.categoryId = body.categoryId as string | null;
  if (body.notes !== undefined) input.notes = body.notes as string | null;
  if (body.unit !== undefined) input.unit = String(body.unit) as Unit;
  if (body.trackStock !== undefined) input.trackStock = Boolean(body.trackStock);
  if (body.purchaseCostMinor !== undefined) {
    input.purchaseCostMinor = body.purchaseCostMinor === null ? null : Number(body.purchaseCostMinor);
  }
  if (body.batchReference !== undefined) input.batchReference = body.batchReference as string | null;
  if (body.supplierName !== undefined) input.supplierName = body.supplierName as string | null;
  if (body.expiryDate !== undefined) {
    input.expiryDate = body.expiryDate === null ? null : new Date(String(body.expiryDate));
  }

  const threshold = quantityFromBody(body, 'lowStockThreshold');
  if (threshold !== undefined) input.lowStockThresholdThousandths = threshold;

  return input;
}

export async function getMaterials(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);
  const sort = parseSort(req, MATERIAL_SORT_FIELDS, { createdAt: -1 });

  const filters: MaterialFilters = {};
  const search = optionalString(req.query.search);
  const categoryId = optionalString(req.query.categoryId);
  if (search) filters.search = search;
  if (categoryId) filters.categoryId = categoryId;
  const archived = optionalBoolean(req.query.archived);
  if (archived !== undefined) filters.archived = archived;
  if (optionalBoolean(req.query.lowStock)) filters.lowStock = true;
  if (optionalBoolean(req.query.outOfStock)) filters.outOfStock = true;
  if (req.query.expiringWithinDays !== undefined) {
    filters.expiringWithinDays = Number(req.query.expiringWithinDays);
  }

  const { items, total } = await listMaterials(merchant.objectId, filters, pagination, sort);
  const names = await loadCategoryNames(merchant.objectId, items.map((material) => material.categoryId));

  sendList(
    res,
    items.map((material) => presentRawMaterial(material, names)),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getMaterialById(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const material = await loadMaterial(merchant.objectId, String(req.params.id));
  const names = await loadCategoryNames(merchant.objectId, [material.categoryId]);

  sendData(res, { material: presentRawMaterial(material, names) });
}

export async function postMaterial(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const input = readMaterialInput(req.body as Record<string, unknown>);
  if (!input.name) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'name', message: 'Enter a name of 1 to 120 characters.' },
    ]);
  }

  const opening = quantityFromBody(req.body as Record<string, unknown>, 'openingQuantity');

  const material = await createMaterial({
    merchantId: merchant.objectId,
    data: input as MaterialInput,
    ...(opening === undefined ? {} : { openingQuantityThousandths: opening }),
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [material.categoryId]);
  sendData(res, { material: presentRawMaterial(material, names) }, 201);
}

export async function patchMaterial(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const material = await updateMaterial({
    merchantId: merchant.objectId,
    materialId: String(req.params.id),
    data: readMaterialInput(req.body as Record<string, unknown>),
    actor: merchantActor(req),
    req,
  });

  const names = await loadCategoryNames(merchant.objectId, [material.categoryId]);
  sendData(res, { material: presentRawMaterial(material, names) });
}

export function materialArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const merchant = merchantContext(req);
    const material = await setMaterialArchived({
      merchantId: merchant.objectId,
      materialId: String(req.params.id),
      archived,
      actor: merchantActor(req),
      req,
    });

    sendData(res, { material: presentRawMaterial(material) });
  };
}

export async function putMaterialImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  if (!req.file?.buffer) {
    throw AppError.badRequest(ErrorCode.UPLOAD_REJECTED, 'Choose an image to upload.');
  }

  const stored = await storeImage(req.file.buffer, 'materials');
  const material = await replaceMaterialImage({
    merchantId: merchant.objectId,
    materialId: String(req.params.id),
    imageUrl: stored.url,
  });

  sendData(res, { material: presentRawMaterial(material) });
}

export async function deleteMaterialImage(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const material = await replaceMaterialImage({
    merchantId: merchant.objectId,
    materialId: String(req.params.id),
    imageUrl: null,
  });

  sendData(res, { material: presentRawMaterial(material) });
}

/* ---------------------------------- stock --------------------------------- */

function presentSubjectStock(subject: { _id: Types.ObjectId }, subjectType: StockSubjectType) {
  return subjectType === 'item'
    // The subject is the full document; the presenters narrow it.
    ? { item: presentItem(subject as never) }
    : { material: presentRawMaterial(subject as never) };
}

/** A signed adjustment: the merchant says what changed and why. */
export async function postStockAdjustment(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const subjectType = String(req.params.subjectType) as StockSubjectType;

  const result = await applyStockMovement({
    merchantId: merchant.objectId,
    subjectType,
    subjectId: String(req.params.subjectId),
    type: 'adjustment',
    reason: String(req.body.reason) as StockAdjustmentReason,
    deltaThousandths: toThousandths(Number(req.body.change)),
    note: optionalString(req.body.note) ?? null,
    actor: merchantActor(req),
    req,
  });

  sendData(res, {
    ...presentSubjectStock(result.subject, subjectType),
    movement: presentStockMovement(result.movement),
  });
}

/** Sets stock to an exact figure, which is what a recount produces. */
export async function putStockQuantity(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const subjectType = String(req.params.subjectType) as StockSubjectType;

  const result = await setStockQuantity({
    merchantId: merchant.objectId,
    subjectType,
    subjectId: String(req.params.subjectId),
    targetThousandths: toThousandths(Number(req.body.quantity)),
    reason: (optionalString(req.body.reason) as StockAdjustmentReason) ?? 'recount',
    note: optionalString(req.body.note) ?? null,
    actor: merchantActor(req),
    req,
  });

  sendData(res, {
    ...presentSubjectStock(result.subject, subjectType),
    movement: presentStockMovement(result.movement),
  });
}

export async function getStockHistory(req: Request, res: Response): Promise<void> {
  const merchant = merchantContext(req);
  const pagination = parsePagination(req);

  const subjectType = optionalString(req.query.subjectType) as StockSubjectType | undefined;
  const subjectId = optionalString(req.query.subjectId);
  const type = optionalString(req.query.type) as StockMovementType | undefined;
  const reason = optionalString(req.query.reason) as StockAdjustmentReason | undefined;

  // Asking for one record's history confirms the record is the merchant's own first.
  if (subjectId && subjectType) {
    await loadStockSubject(subjectType, subjectId, merchant.objectId);
  }

  const { items, total } = await listStockMovements(
    merchant.objectId,
    {
      ...(subjectType ? { subjectType } : {}),
      ...(subjectId ? { subjectId } : {}),
      ...(type ? { type } : {}),
      ...(reason ? { reason } : {}),
    },
    pagination,
  );

  sendList(
    res,
    items.map(presentStockMovement),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}
