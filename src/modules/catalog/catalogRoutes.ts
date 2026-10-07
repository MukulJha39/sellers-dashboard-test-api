import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { uploadImage } from '../../middleware/upload';
import { asyncHandler, validate } from '../../middleware/validate';
import {
  categoryArchiveHandler,
  deleteItemImage,
  deleteMaterialImage,
  deleteServiceImage,
  getCatalogMeta,
  getCatalogSummary,
  getCategories,
  getItemById,
  getItems,
  getLowStock,
  getMaterialById,
  getMaterials,
  getServiceById,
  getServices,
  getStockHistory,
  itemArchiveHandler,
  materialArchiveHandler,
  patchCategory,
  patchItem,
  patchMaterial,
  patchService,
  postCategory,
  postItem,
  postMaterial,
  postService,
  postStockAdjustment,
  putItemImage,
  putMaterialImage,
  putServiceImage,
  putStockQuantity,
  serviceArchiveHandler,
} from './catalogController';
import {
  categoryCreateRules,
  categoryIdRules,
  categoryListRules,
  categoryRenameRules,
  itemCreateRules,
  itemIdRules,
  itemListRules,
  itemUpdateRules,
  materialCreateRules,
  materialIdRules,
  materialListRules,
  materialUpdateRules,
  rejectDirectStockWrite,
  serviceCreateRules,
  serviceIdRules,
  serviceListRules,
  serviceUpdateRules,
  stockAdjustRules,
  stockHistoryRules,
  stockSetRules,
} from './catalogValidators';

/**
 * The catalog owns several top-level resources, so it is assembled from one sub-router
 * per resource.
 *
 * This matters more than it looks: the parent is mounted on the bare API prefix, and a
 * blanket `use(authenticateMerchant)` there would run for every request under that
 * prefix — including the admin routes mounted afterwards, which would then reject every
 * admin call before it reached its own handler. Scoping the merchant guard to each
 * resource path keeps unrelated requests passing straight through.
 */
export const catalogRouter = Router();

/** A sub-router that only an authenticated merchant can reach. */
function merchantRouter(): Router {
  const router = Router();
  router.use(authenticateMerchant);
  return router;
}

/* ---------------------------- vocabulary & counts --------------------------- */

const catalogMetaRoutes = merchantRouter();
catalogMetaRoutes.get('/meta', asyncHandler(getCatalogMeta));
catalogMetaRoutes.get('/summary', asyncHandler(getCatalogSummary));
catalogMetaRoutes.get('/low-stock', asyncHandler(getLowStock));
catalogRouter.use('/catalog', catalogMetaRoutes);

/* -------------------------------- categories ------------------------------- */

const categoryRoutes = merchantRouter();
categoryRoutes.get('/', ...validate(categoryListRules), asyncHandler(getCategories));
categoryRoutes.post('/', ...validate(categoryCreateRules), asyncHandler(postCategory));
categoryRoutes.patch('/:id', ...validate(categoryRenameRules), asyncHandler(patchCategory));
categoryRoutes.post(
  '/:id/archive',
  ...validate(categoryIdRules),
  asyncHandler(categoryArchiveHandler(true)),
);
categoryRoutes.post(
  '/:id/restore',
  ...validate(categoryIdRules),
  asyncHandler(categoryArchiveHandler(false)),
);
catalogRouter.use('/categories', categoryRoutes);

/* ---------------------------------- items ---------------------------------- */

const itemRoutes = merchantRouter();
itemRoutes.get('/', ...validate(itemListRules), asyncHandler(getItems));
itemRoutes.post('/', ...validate(itemCreateRules), asyncHandler(postItem));
itemRoutes.get('/:id', ...validate(itemIdRules), asyncHandler(getItemById));
// rejectDirectStockWrite runs first: stock never changes through a details update.
itemRoutes.patch('/:id', rejectDirectStockWrite, ...validate(itemUpdateRules), asyncHandler(patchItem));
itemRoutes.post('/:id/archive', ...validate(itemIdRules), asyncHandler(itemArchiveHandler(true)));
itemRoutes.post('/:id/restore', ...validate(itemIdRules), asyncHandler(itemArchiveHandler(false)));
itemRoutes.put(
  '/:id/image',
  uploadImage.single('image'),
  ...validate(itemIdRules),
  asyncHandler(putItemImage),
);
itemRoutes.delete('/:id/image', ...validate(itemIdRules), asyncHandler(deleteItemImage));
catalogRouter.use('/items', itemRoutes);

/* --------------------------------- services -------------------------------- */

const serviceRoutes = merchantRouter();
serviceRoutes.get('/', ...validate(serviceListRules), asyncHandler(getServices));
serviceRoutes.post('/', ...validate(serviceCreateRules), asyncHandler(postService));
serviceRoutes.get('/:id', ...validate(serviceIdRules), asyncHandler(getServiceById));
serviceRoutes.patch('/:id', ...validate(serviceUpdateRules), asyncHandler(patchService));
serviceRoutes.post(
  '/:id/archive',
  ...validate(serviceIdRules),
  asyncHandler(serviceArchiveHandler(true)),
);
serviceRoutes.post(
  '/:id/restore',
  ...validate(serviceIdRules),
  asyncHandler(serviceArchiveHandler(false)),
);
serviceRoutes.put(
  '/:id/image',
  uploadImage.single('image'),
  ...validate(serviceIdRules),
  asyncHandler(putServiceImage),
);
serviceRoutes.delete('/:id/image', ...validate(serviceIdRules), asyncHandler(deleteServiceImage));
catalogRouter.use('/services', serviceRoutes);

/* -------------------------------- materials -------------------------------- */

const materialRoutes = merchantRouter();
materialRoutes.get('/', ...validate(materialListRules), asyncHandler(getMaterials));
materialRoutes.post('/', ...validate(materialCreateRules), asyncHandler(postMaterial));
materialRoutes.get('/:id', ...validate(materialIdRules), asyncHandler(getMaterialById));
materialRoutes.patch(
  '/:id',
  rejectDirectStockWrite,
  ...validate(materialUpdateRules),
  asyncHandler(patchMaterial),
);
materialRoutes.post(
  '/:id/archive',
  ...validate(materialIdRules),
  asyncHandler(materialArchiveHandler(true)),
);
materialRoutes.post(
  '/:id/restore',
  ...validate(materialIdRules),
  asyncHandler(materialArchiveHandler(false)),
);
materialRoutes.put(
  '/:id/image',
  uploadImage.single('image'),
  ...validate(materialIdRules),
  asyncHandler(putMaterialImage),
);
materialRoutes.delete('/:id/image', ...validate(materialIdRules), asyncHandler(deleteMaterialImage));
catalogRouter.use('/materials', materialRoutes);

/* ---------------------------------- stock ---------------------------------- */

const stockRoutes = merchantRouter();
stockRoutes.get('/history', ...validate(stockHistoryRules), asyncHandler(getStockHistory));
stockRoutes.post(
  '/:subjectType/:subjectId/adjust',
  ...validate(stockAdjustRules),
  asyncHandler(postStockAdjustment),
);
stockRoutes.put(
  '/:subjectType/:subjectId/quantity',
  ...validate(stockSetRules),
  asyncHandler(putStockQuantity),
);
catalogRouter.use('/stock', stockRoutes);
