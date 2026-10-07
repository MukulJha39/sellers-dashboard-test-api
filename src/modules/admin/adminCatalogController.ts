import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { StockAdjustmentReason, StockSubjectType } from '../../config/catalog';
import { AppError } from '../../utils/AppError';
import { buildPageMeta, sendData, sendList } from '../../utils/response';
import { parsePagination, parseSort } from '../../utils/pagination';
import { toThousandths } from '../../utils/quantity';
import type { AuthenticatedAdmin } from '../../types/express';
import { getOrCreateBusiness, updateBusiness } from '../business/businessService';
import {
  presentBusiness,
  presentCategory,
  presentItem,
  presentRawMaterial,
  presentService,
  presentStockMovement,
} from '../catalog/catalogPresenters';
import { listCategories, loadCategoryNames } from '../catalog/categoryService';
import { setItemArchived, updateItem } from '../catalog/itemService';
import { setMaterialArchived, updateMaterial } from '../catalog/materialService';
import { setServiceArchived, updateService } from '../catalog/serviceCatalogService';
import { applyStockMovement, type StockActor } from '../catalog/stockService';
import { catalogSummary } from '../catalog/summaryService';
import {
  ADMIN_CATALOG_SORT_FIELDS,
  adminListItems,
  adminListMaterials,
  adminListServices,
  adminListStockMovements,
  adminLoadItem,
  adminLoadMaterial,
  adminLoadService,
  adminLoadStockSubject,
  adminLowStock,
  loadMerchantNames,
  type AdminCatalogFilters,
} from './adminCatalogService';

function adminContext(req: Request): AuthenticatedAdmin {
  if (!req.admin) throw AppError.unauthenticated('Sign in to continue.');
  return req.admin;
}

/** The admin acting, recorded in the ledger and the audit trail. */
function adminActor(req: Request): StockActor {
  const admin = adminContext(req);
  return { type: 'admin', id: admin.objectId, label: `${admin.name} (${admin.email})` };
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

function readCatalogFilters(req: Request): AdminCatalogFilters {
  const filters: AdminCatalogFilters = {};
  const merchantId = optionalString(req.query.merchantId);
  const search = optionalString(req.query.search);
  if (merchantId) filters.merchantId = merchantId;
  if (search) filters.search = search;

  const archived = optionalBoolean(req.query.archived);
  if (archived !== undefined) filters.archived = archived;
  if (optionalBoolean(req.query.lowStock)) filters.lowStock = true;

  return filters;
}

function merchantObjectId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) throw AppError.notFound('That merchant was not found.');
  return new Types.ObjectId(value);
}

/* --------------------------------- business -------------------------------- */

export async function getMerchantBusiness(req: Request, res: Response): Promise<void> {
  const business = await getOrCreateBusiness(merchantObjectId(String(req.params.merchantId)));
  sendData(res, { business: presentBusiness(business) });
}

export async function patchMerchantBusiness(req: Request, res: Response): Promise<void> {
  const business = await updateBusiness({
    merchantId: merchantObjectId(String(req.params.merchantId)),
    data: req.body as Record<string, never>,
    actor: adminActor(req),
    req,
  });

  sendData(res, { business: presentBusiness(business) });
}

export async function getMerchantCatalogSummary(req: Request, res: Response): Promise<void> {
  const summary = await catalogSummary(merchantObjectId(String(req.params.merchantId)));
  sendData(res, { summary });
}

export async function getMerchantCategories(req: Request, res: Response): Promise<void> {
  const rows = await listCategories(merchantObjectId(String(req.params.merchantId)), {
    includeArchived: true,
  });

  sendData(res, {
    categories: rows.map((row) => presentCategory(row.category, row.usageCount)),
  });
}

/* ---------------------------------- lists --------------------------------- */

export async function getAdminItems(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_CATALOG_SORT_FIELDS, { updatedAt: -1 });

  const { items, total } = await adminListItems(readCatalogFilters(req), pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((item) => item.merchantId));

  sendList(
    res,
    items.map((item) => ({
      ...presentItem(item),
      merchantName: merchantNames.get(String(item.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminServices(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_CATALOG_SORT_FIELDS, { updatedAt: -1 });

  const { items, total } = await adminListServices(readCatalogFilters(req), pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((service) => service.merchantId));

  sendList(
    res,
    items.map((service) => ({
      ...presentService(service),
      merchantName: merchantNames.get(String(service.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminMaterials(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const sort = parseSort(req, ADMIN_CATALOG_SORT_FIELDS, { updatedAt: -1 });

  const { items, total } = await adminListMaterials(readCatalogFilters(req), pagination, sort);
  const merchantNames = await loadMerchantNames(items.map((material) => material.merchantId));

  sendList(
    res,
    items.map((material) => ({
      ...presentRawMaterial(material),
      merchantName: merchantNames.get(String(material.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminStockMovements(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);

  const merchantId = optionalString(req.query.merchantId);
  const subjectType = optionalString(req.query.subjectType) as StockSubjectType | undefined;
  const subjectId = optionalString(req.query.subjectId);

  const { items, total } = await adminListStockMovements(
    {
      ...(merchantId ? { merchantId } : {}),
      ...(subjectType ? { subjectType } : {}),
      ...(subjectId ? { subjectId } : {}),
    },
    pagination,
  );
  const merchantNames = await loadMerchantNames(items.map((movement) => movement.merchantId));

  sendList(
    res,
    items.map((movement) => ({
      ...presentStockMovement(movement),
      merchantId: String(movement.merchantId),
      merchantName: merchantNames.get(String(movement.merchantId)) ?? null,
    })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

export async function getAdminLowStock(req: Request, res: Response): Promise<void> {
  const pagination = parsePagination(req);
  const merchantId = optionalString(req.query.merchantId);

  const { rows, total } = await adminLowStock(pagination, merchantId);
  const merchantNames = await loadMerchantNames(
    rows.map((row) => new Types.ObjectId(row.merchantId)),
  );

  sendList(
    res,
    rows.map((row) => ({ ...row, merchantName: merchantNames.get(row.merchantId) ?? null })),
    buildPageMeta(pagination.page, pagination.limit, total),
  );
}

/* -------------------------------- mutations ------------------------------- */

export async function patchAdminItem(req: Request, res: Response): Promise<void> {
  const existing = await adminLoadItem(String(req.params.id));

  const item = await updateItem({
    merchantId: existing.merchantId,
    itemId: String(existing._id),
    data: req.body as Record<string, never>,
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(existing.merchantId, [item.categoryId]);
  sendData(res, { item: presentItem(item, names) });
}

export function adminItemArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const existing = await adminLoadItem(String(req.params.id));
    const item = await setItemArchived({
      merchantId: existing.merchantId,
      itemId: String(existing._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { item: presentItem(item) });
  };
}

export async function patchAdminService(req: Request, res: Response): Promise<void> {
  const existing = await adminLoadService(String(req.params.id));

  const service = await updateService({
    merchantId: existing.merchantId,
    serviceId: String(existing._id),
    data: req.body as Record<string, never>,
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(existing.merchantId, [service.categoryId]);
  sendData(res, { service: presentService(service, names) });
}

export function adminServiceArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const existing = await adminLoadService(String(req.params.id));
    const service = await setServiceArchived({
      merchantId: existing.merchantId,
      serviceId: String(existing._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { service: presentService(service) });
  };
}

export async function patchAdminMaterial(req: Request, res: Response): Promise<void> {
  const existing = await adminLoadMaterial(String(req.params.id));

  const material = await updateMaterial({
    merchantId: existing.merchantId,
    materialId: String(existing._id),
    data: req.body as Record<string, never>,
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(existing.merchantId, [material.categoryId]);
  sendData(res, { material: presentRawMaterial(material, names) });
}

export function adminMaterialArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const existing = await adminLoadMaterial(String(req.params.id));
    const material = await setMaterialArchived({
      merchantId: existing.merchantId,
      materialId: String(existing._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { material: presentRawMaterial(material) });
  };
}

/**
 * An admin correcting stock on a merchant's behalf.
 *
 * Goes through the same ledger path as the app, so the movement records that an admin
 * made it and why (PRD section 27).
 */
export async function postAdminStockAdjustment(req: Request, res: Response): Promise<void> {
  const subjectType = String(req.params.subjectType) as StockSubjectType;
  const subject = await adminLoadStockSubject(subjectType, String(req.params.subjectId));

  const result = await applyStockMovement({
    merchantId: subject.merchantId,
    subjectType,
    subjectId: String(subject._id),
    type: 'adjustment',
    reason: String(req.body.reason) as StockAdjustmentReason,
    deltaThousandths: toThousandths(Number(req.body.change)),
    note: optionalString(req.body.note) ?? null,
    actor: adminActor(req),
    req,
  });

  sendData(res, {
    ...(subjectType === 'item'
      ? { item: presentItem(result.subject as never) }
      : { material: presentRawMaterial(result.subject as never) }),
    movement: presentStockMovement(result.movement),
  });
}
