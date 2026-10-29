import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { CategoryKind, StockAdjustmentReason, StockSubjectType } from '../../config/catalog';
import { PERMISSIONS, type Permission } from '../../config/permissions';
import { Category } from '../../models/Category';
import { Merchant } from '../../models/Merchant';
import { AppError } from '../../utils/AppError';
import { toThousandths } from '../../utils/quantity';
import { sendData } from '../../utils/response';
import {
  quantityFromBody,
  readItemInput,
  readMaterialInput,
  readServiceInput,
  uploadedBuffers,
} from '../catalog/catalogController';
import {
  presentCategory,
  presentItem,
  presentRawMaterial,
  presentService,
  presentStockMovement,
} from '../catalog/catalogPresenters';
import {
  createCategory,
  loadCategoryNames,
  renameCategory,
  setCategoryArchived,
} from '../catalog/categoryService';
import {
  addItemImages,
  createItem,
  removeItemImage,
  reorderItemImages,
  type ItemInput,
} from '../catalog/itemService';
import {
  addMaterialImages,
  createMaterial,
  removeMaterialImage,
  reorderMaterialImages,
  type MaterialInput,
} from '../catalog/materialService';
import {
  addServiceImages,
  createService,
  removeServiceImage,
  reorderServiceImages,
  type ServiceInput,
} from '../catalog/serviceCatalogService';
import { setStockQuantity } from '../catalog/stockService';
import { adminActor } from './adminCatalogController';
import {
  adminLoadItem,
  adminLoadMaterial,
  adminLoadService,
  adminLoadStockSubject,
} from './adminCatalogService';

/**
 * Catalog writes made by support on a merchant's behalf: creating products, services
 * and raw materials, managing their photos and categories, and setting stock to a count.
 *
 * Every handler reads the input the way the merchant app's does and calls the same
 * service, so an admin can do nothing a merchant could not, and every change is
 * recorded with the admin as the actor. The owning merchant comes from the URL for a
 * create, and from the record itself for everything else.
 */

async function merchantFromParam(req: Request): Promise<Types.ObjectId> {
  const value = String(req.params.merchantId);
  if (!Types.ObjectId.isValid(value) || !(await Merchant.exists({ _id: value }))) {
    throw AppError.notFound('That merchant was not found.');
  }
  return new Types.ObjectId(value);
}

function requireName(name: string | undefined): void {
  if (!name) {
    throw AppError.validation('Please correct the highlighted fields.', [
      { field: 'name', message: 'Enter a name of 1 to 120 characters.' },
    ]);
  }
}

/* --------------------------------- creating -------------------------------- */

export async function postAdminItem(req: Request, res: Response): Promise<void> {
  const merchantId = await merchantFromParam(req);
  const body = req.body as Record<string, unknown>;
  const input = readItemInput(body);
  requireName(input.name);
  const opening = quantityFromBody(body, 'openingQuantity');

  const item = await createItem({
    merchantId,
    data: input as ItemInput,
    ...(opening === undefined ? {} : { openingQuantityThousandths: opening }),
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(merchantId, [item.categoryId]);
  sendData(res, { item: presentItem(item, names) }, 201);
}

export async function postAdminService(req: Request, res: Response): Promise<void> {
  const merchantId = await merchantFromParam(req);
  const input = readServiceInput(req.body as Record<string, unknown>);
  requireName(input.name);

  const service = await createService({
    merchantId,
    data: input as ServiceInput,
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(merchantId, [service.categoryId]);
  sendData(res, { service: presentService(service, names) }, 201);
}

export async function postAdminMaterial(req: Request, res: Response): Promise<void> {
  const merchantId = await merchantFromParam(req);
  const body = req.body as Record<string, unknown>;
  const input = readMaterialInput(body);
  requireName(input.name);
  const opening = quantityFromBody(body, 'openingQuantity');

  const material = await createMaterial({
    merchantId,
    data: input as MaterialInput,
    ...(opening === undefined ? {} : { openingQuantityThousandths: opening }),
    actor: adminActor(req),
    req,
  });

  const names = await loadCategoryNames(merchantId, [material.categoryId]);
  sendData(res, { material: presentRawMaterial(material, names) }, 201);
}

/* -------------------------------- categories ------------------------------- */

const CATEGORY_PERMISSION: Record<CategoryKind, Permission> = {
  item: PERMISSIONS.ITEM_MANAGE,
  service: PERMISSIONS.SERVICE_MANAGE,
  material: PERMISSIONS.MATERIAL_MANAGE,
};

/** A category is managed with the permission for the records it files. */
function assertCanManageKind(req: Request, kind: CategoryKind): void {
  if (!req.admin?.permissions.includes(CATEGORY_PERMISSION[kind])) {
    throw AppError.forbidden('Your role does not allow this action.');
  }
}

async function adminLoadCategory(categoryId: string) {
  if (!Types.ObjectId.isValid(categoryId)) throw AppError.notFound('That category was not found.');
  const category = await Category.findById(categoryId);
  if (!category) throw AppError.notFound('That category was not found.');
  return category;
}

export async function postAdminCategory(req: Request, res: Response): Promise<void> {
  const kind = String(req.body.kind) as CategoryKind;
  assertCanManageKind(req, kind);
  const merchantId = await merchantFromParam(req);

  const category = await createCategory({
    merchantId,
    kind,
    name: String(req.body.name),
    actor: adminActor(req),
    req,
  });

  sendData(res, { category: presentCategory(category) }, 201);
}

export async function patchAdminCategory(req: Request, res: Response): Promise<void> {
  const existing = await adminLoadCategory(String(req.params.id));
  assertCanManageKind(req, existing.kind);

  const category = await renameCategory({
    merchantId: existing.merchantId,
    categoryId: String(existing._id),
    name: String(req.body.name),
    actor: adminActor(req),
    req,
  });

  sendData(res, { category: presentCategory(category) });
}

export function adminCategoryArchiveHandler(archived: boolean) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const existing = await adminLoadCategory(String(req.params.id));
    assertCanManageKind(req, existing.kind);

    const category = await setCategoryArchived({
      merchantId: existing.merchantId,
      categoryId: String(existing._id),
      archived,
      actor: adminActor(req),
      req,
    });

    sendData(res, { category: presentCategory(category) });
  };
}

/* ---------------------------------- photos --------------------------------- */

/** The same three photo operations for each kind of record, from one description. */
function galleryHandlers<TDoc extends { merchantId: Types.ObjectId; _id: Types.ObjectId }>(spec: {
  key: 'item' | 'service' | 'material';
  load: (id: string) => Promise<TDoc>;
  present: (doc: TDoc) => unknown;
  add: (input: { merchantId: Types.ObjectId; id: string; images: Buffer[] }) => Promise<TDoc>;
  remove: (input: { merchantId: Types.ObjectId; id: string; imageId: string }) => Promise<TDoc>;
  reorder: (input: { merchantId: Types.ObjectId; id: string; imageIds: string[] }) => Promise<TDoc>;
}) {
  return {
    async upload(req: Request, res: Response): Promise<void> {
      const existing = await spec.load(String(req.params.id));
      const doc = await spec.add({ merchantId: existing.merchantId, id: String(existing._id), images: uploadedBuffers(req) });
      sendData(res, { [spec.key]: spec.present(doc) }, 201);
    },
    async remove(req: Request, res: Response): Promise<void> {
      const existing = await spec.load(String(req.params.id));
      const doc = await spec.remove({
        merchantId: existing.merchantId,
        id: String(existing._id),
        imageId: String(req.params.imageId),
      });
      sendData(res, { [spec.key]: spec.present(doc) });
    },
    async reorder(req: Request, res: Response): Promise<void> {
      const existing = await spec.load(String(req.params.id));
      const doc = await spec.reorder({
        merchantId: existing.merchantId,
        id: String(existing._id),
        imageIds: (req.body.imageIds as unknown[]).map(String),
      });
      sendData(res, { [spec.key]: spec.present(doc) });
    },
  };
}

export const adminItemImages = galleryHandlers({
  key: 'item',
  load: adminLoadItem,
  present: (doc) => presentItem(doc),
  add: ({ merchantId, id, images }) => addItemImages({ merchantId, itemId: id, images }),
  remove: ({ merchantId, id, imageId }) => removeItemImage({ merchantId, itemId: id, imageId }),
  reorder: ({ merchantId, id, imageIds }) => reorderItemImages({ merchantId, itemId: id, imageIds }),
});

export const adminServiceImages = galleryHandlers({
  key: 'service',
  load: adminLoadService,
  present: (doc) => presentService(doc),
  add: ({ merchantId, id, images }) => addServiceImages({ merchantId, serviceId: id, images }),
  remove: ({ merchantId, id, imageId }) => removeServiceImage({ merchantId, serviceId: id, imageId }),
  reorder: ({ merchantId, id, imageIds }) => reorderServiceImages({ merchantId, serviceId: id, imageIds }),
});

export const adminMaterialImages = galleryHandlers({
  key: 'material',
  load: adminLoadMaterial,
  present: (doc) => presentRawMaterial(doc),
  add: ({ merchantId, id, images }) => addMaterialImages({ merchantId, materialId: id, images }),
  remove: ({ merchantId, id, imageId }) => removeMaterialImage({ merchantId, materialId: id, imageId }),
  reorder: ({ merchantId, id, imageIds }) => reorderMaterialImages({ merchantId, materialId: id, imageIds }),
});

/* ----------------------------------- stock --------------------------------- */

/** Sets stock to a counted figure, as the merchant's "recount" does. */
export async function putAdminStockQuantity(req: Request, res: Response): Promise<void> {
  const subjectType = String(req.params.subjectType) as StockSubjectType;
  const subject = await adminLoadStockSubject(subjectType, String(req.params.subjectId));
  const body = req.body as Record<string, unknown>;

  const result = await setStockQuantity({
    merchantId: subject.merchantId,
    subjectType,
    subjectId: String(subject._id),
    targetThousandths: toThousandths(Number(body.quantity)),
    reason: (typeof body.reason === 'string' && body.reason ? body.reason : 'recount') as StockAdjustmentReason,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null,
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
