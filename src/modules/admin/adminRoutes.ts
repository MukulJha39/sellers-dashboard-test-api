import { Router } from 'express';
import { param } from 'express-validator';
import { PERMISSIONS } from '../../config/permissions';
import { authenticateAdmin, requirePasswordChanged, requirePermission } from '../../middleware/auth';
import { adminLoginLimiter, refreshLimiter } from '../../middleware/rateLimit';
import { asyncHandler, validate } from '../../middleware/validate';
import { refreshRules } from '../auth/authValidators';
import { rejectPhoneMutation } from '../merchant/merchantValidators';
import {
  getAdminMe,
  getAuditLogs,
  getMerchantById,
  getMerchants,
  patchMerchantById,
  patchMerchantStatus,
  postAdminLogin,
  patchAdminMe,
  postAdminLogout,
  postAdminRefresh,
} from './adminController';
import { getCatalogMeta } from '../catalog/catalogController';
import { deleteAdminUnit, getAdminUnits, patchAdminUnit, postAdminUnit } from './adminUnitController';
import { unitCreateRules, unitIdRules, unitUpdateRules } from './adminUnitValidators';
import {
  deleteRoleById,
  getAdminById,
  getAdmins,
  getRolesWithMembers,
  patchAdmin,
  patchAdminStatus,
  patchRole,
  postAdmin,
  postAdminPasswordReset,
  postChangeOwnPassword,
  postRole,
} from './adminTeamController';
import {
  adminCustomerArchiveHandler,
  adminSupplierArchiveHandler,
  getAdminCustomerById,
  getAdminCustomers,
  getAdminPayments,
  getAdminPurchaseById,
  getAdminPurchases,
  getAdminRelationshipSummary,
  getAdminSupplierById,
  getAdminSuppliers,
  patchAdminCustomer,
  patchAdminSupplier,
  postAdminPurchaseCancel,
  postAdminPurchasePayment,
} from './adminRelationshipController';
import {
  getAdminInstallments,
  getAdminOrderById,
  getAdminOrders,
  getAdminOrderSummary,
  getAdminReceivables,
  postAdminOrderCancel,
  postAdminOrderPayment,
  patchAdminOrderDelivery,
  patchAdminPayment,
  deleteAdminPayment,
  postAdminOrderStatus,
  putAdminInstallmentPlan,
} from './adminOrderController';
import { installmentPlanRules, orderDeliveryRules, orderPaymentRules } from '../orders/orderValidators';
import {
  customerUpdateRules,
  paymentAnnotateRules,
  paymentDeleteRules,
  paymentCreateRules,
  supplierUpdateRules,
} from '../relationships/relationshipValidators';
import {
  adminItemArchiveHandler,
  adminMaterialArchiveHandler,
  adminServiceArchiveHandler,
  getAdminItems,
  getAdminLowStock,
  getAdminMaterials,
  getAdminServices,
  getAdminStockMovements,
  getMerchantBusiness,
  deleteAdminItem,
  deleteAdminMaterial,
  deleteAdminService,
  getMerchantCatalogSummary,
  getMerchantCategories,
  patchAdminItem,
  patchAdminMaterial,
  patchAdminService,
  patchMerchantBusiness,
  postAdminStockAdjustment,
} from './adminCatalogController';
import {
  businessUpdateRules,
  categoryCreateRules,
  categoryIdRules,
  categoryRenameRules,
  itemCreateRules,
  itemIdRules,
  itemImageOrderRules,
  itemImageRules,
  itemUpdateRules,
  materialCreateRules,
  materialIdRules,
  materialImageOrderRules,
  materialImageRules,
  materialUpdateRules,
  rejectDirectStockWrite,
  serviceCreateRules,
  serviceIdRules,
  serviceImageOrderRules,
  serviceImageRules,
  serviceUpdateRules,
  stockAdjustRules,
  stockSetRules,
} from '../catalog/catalogValidators';
import {
  adminCategoryArchiveHandler,
  adminItemImages,
  adminMaterialImages,
  adminServiceImages,
  patchAdminCategory,
  postAdminCategory,
  postAdminItem,
  postAdminMaterial,
  postAdminService,
  putAdminStockQuantity,
} from './adminCatalogWriteController';
import { uploadImages } from '../../middleware/upload';
import {
  adminCatalogListRules,
  adminInstallmentListRules,
  adminOrderListRules,
  adminOrderStatusRules,
  adminPaymentListRules,
  adminPurchaseListRules,
  adminReceivablesListRules,
  adminRelationshipListRules,
  adminLoginRules,
  adminStockHistoryRules,
  auditListRules,
  itemIdParamRules,
  merchantIdParamRules,
  merchantIdRules,
  merchantListRules,
  merchantStatusRules,
  merchantUpdateRules,
  adminCreateRules,
  adminListRules,
  adminPasswordResetRules,
  adminStatusRules,
  adminUpdateRules,
  changeOwnPasswordRules,
  ownProfileRules,
  roleCreateRules,
  roleIdRules,
  roleUpdateRules,
} from './adminValidators';

export const adminRouter = Router();

/* Public admin endpoints */
adminRouter.post('/auth/login', adminLoginLimiter, ...validate(adminLoginRules), asyncHandler(postAdminLogin));
adminRouter.post('/auth/refresh', refreshLimiter, ...validate(refreshRules), asyncHandler(postAdminRefresh));

/* Everything below requires an authenticated admin */
adminRouter.use(authenticateAdmin);

adminRouter.get('/auth/me', asyncHandler(getAdminMe));

/** Correcting your own display name needs no permission; it is your own account. */
adminRouter.patch('/auth/me', ...validate(ownProfileRules), asyncHandler(patchAdminMe));
adminRouter.post('/auth/logout', asyncHandler(postAdminLogout));

/**
 * Changing your own password needs no permission: it is the one thing an admin carrying
 * a password someone else chose is allowed to do, and it sits above the guard below for
 * exactly that reason.
 */
adminRouter.post(
  '/auth/change-password',
  ...validate(changeOwnPasswordRules),
  asyncHandler(postChangeOwnPassword),
);

/**
 * From here on, an admin who still holds a password chosen for them is refused.
 * Reading their own profile, changing that password and signing out are above this line.
 */
adminRouter.use(requirePasswordChanged);

adminRouter.get(
  '/merchants',
  requirePermission(PERMISSIONS.MERCHANT_VIEW),
  ...validate(merchantListRules),
  asyncHandler(getMerchants),
);

adminRouter.get(
  '/merchants/:id',
  requirePermission(PERMISSIONS.MERCHANT_VIEW),
  ...validate(merchantIdRules),
  asyncHandler(getMerchantById),
);

adminRouter.patch(
  '/merchants/:id',
  requirePermission(PERMISSIONS.MERCHANT_EDIT),
  rejectPhoneMutation,
  ...validate(merchantUpdateRules),
  asyncHandler(patchMerchantById),
);

adminRouter.patch(
  '/merchants/:id/status',
  requirePermission(PERMISSIONS.MERCHANT_SUSPEND),
  ...validate(merchantStatusRules),
  asyncHandler(patchMerchantStatus),
);

/* ------------------------------ roles & the team ----------------------------- */

adminRouter.get('/roles', requirePermission(PERMISSIONS.ROLE_VIEW), asyncHandler(getRolesWithMembers));

adminRouter.post(
  '/roles',
  requirePermission(PERMISSIONS.ROLE_MANAGE),
  ...validate(roleCreateRules),
  asyncHandler(postRole),
);

adminRouter.patch(
  '/roles/:id',
  requirePermission(PERMISSIONS.ROLE_MANAGE),
  ...validate(roleUpdateRules),
  asyncHandler(patchRole),
);

adminRouter.delete(
  '/roles/:id',
  requirePermission(PERMISSIONS.ROLE_MANAGE),
  ...validate(roleIdRules),
  asyncHandler(deleteRoleById),
);

adminRouter.get(
  '/admins',
  requirePermission(PERMISSIONS.ADMIN_VIEW),
  ...validate(adminListRules),
  asyncHandler(getAdmins),
);

adminRouter.get(
  '/admins/:id',
  requirePermission(PERMISSIONS.ADMIN_VIEW),
  ...validate(roleIdRules),
  asyncHandler(getAdminById),
);

adminRouter.post(
  '/admins',
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  ...validate(adminCreateRules),
  asyncHandler(postAdmin),
);

adminRouter.patch(
  '/admins/:id',
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  ...validate(adminUpdateRules),
  asyncHandler(patchAdmin),
);

adminRouter.patch(
  '/admins/:id/status',
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  ...validate(adminStatusRules),
  asyncHandler(patchAdminStatus),
);

adminRouter.post(
  '/admins/:id/reset-password',
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  ...validate(adminPasswordResetRules),
  asyncHandler(postAdminPasswordReset),
);

adminRouter.get(
  '/audit-logs',
  requirePermission(PERMISSIONS.AUDIT_VIEW),
  ...validate(auditListRules),
  asyncHandler(getAuditLogs),
);

/* ------------------------- Phase 2: business & catalog ------------------------ */

/**
 * The same vocabulary the merchant app reads: units, billing units and adjustment
 * reasons. Served here too so the admin panel never hard-codes a second copy.
 */
adminRouter.get('/catalog/meta', asyncHandler(getCatalogMeta));

/*
 * Units of measurement. Reading them needs only catalog read access, since every
 * catalog screen labels quantities with them; changing them needs `unit.manage`.
 */
adminRouter.get('/units', requirePermission(PERMISSIONS.ITEM_VIEW), asyncHandler(getAdminUnits));

adminRouter.post(
  '/units',
  requirePermission(PERMISSIONS.UNIT_MANAGE),
  ...validate(unitCreateRules),
  asyncHandler(postAdminUnit),
);

adminRouter.patch(
  '/units/:id',
  requirePermission(PERMISSIONS.UNIT_MANAGE),
  ...validate(unitUpdateRules),
  asyncHandler(patchAdminUnit),
);

adminRouter.delete(
  '/units/:id',
  requirePermission(PERMISSIONS.UNIT_MANAGE),
  ...validate(unitIdRules),
  asyncHandler(deleteAdminUnit),
);

adminRouter.get(
  '/merchants/:merchantId/business',
  requirePermission(PERMISSIONS.BUSINESS_VIEW),
  ...validate(merchantIdParamRules),
  asyncHandler(getMerchantBusiness),
);

adminRouter.patch(
  '/merchants/:merchantId/business',
  requirePermission(PERMISSIONS.BUSINESS_EDIT),
  ...validate([...merchantIdParamRules, ...businessUpdateRules]),
  asyncHandler(patchMerchantBusiness),
);

adminRouter.get(
  '/merchants/:merchantId/catalog-summary',
  requirePermission(PERMISSIONS.MERCHANT_VIEW),
  ...validate(merchantIdParamRules),
  asyncHandler(getMerchantCatalogSummary),
);

adminRouter.get(
  '/merchants/:merchantId/categories',
  requirePermission(PERMISSIONS.ITEM_VIEW),
  ...validate(merchantIdParamRules),
  asyncHandler(getMerchantCategories),
);

/* Catalog lists span merchants, with an optional merchantId filter for drill-down. */

adminRouter.get(
  '/items',
  requirePermission(PERMISSIONS.ITEM_VIEW),
  ...validate(adminCatalogListRules),
  asyncHandler(getAdminItems),
);

adminRouter.get(
  '/services',
  requirePermission(PERMISSIONS.SERVICE_VIEW),
  ...validate(adminCatalogListRules),
  asyncHandler(getAdminServices),
);

adminRouter.get(
  '/materials',
  requirePermission(PERMISSIONS.MATERIAL_VIEW),
  ...validate(adminCatalogListRules),
  asyncHandler(getAdminMaterials),
);

adminRouter.get(
  '/stock-movements',
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ...validate(adminStockHistoryRules),
  asyncHandler(getAdminStockMovements),
);

adminRouter.get(
  '/low-stock',
  requirePermission(PERMISSIONS.STOCK_VIEW),
  ...validate(adminCatalogListRules),
  asyncHandler(getAdminLowStock),
);

/* Catalog mutations. Stock is never writable through a details update. */

adminRouter.patch(
  '/items/:id',
  requirePermission(PERMISSIONS.ITEM_MANAGE),
  rejectDirectStockWrite,
  ...validate(itemUpdateRules),
  asyncHandler(patchAdminItem),
);

adminRouter.post(
  '/items/:id/archive',
  requirePermission(PERMISSIONS.ITEM_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminItemArchiveHandler(true)),
);

adminRouter.post(
  '/items/:id/restore',
  requirePermission(PERMISSIONS.ITEM_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminItemArchiveHandler(false)),
);

/*
 * Permanent catalog deletion.
 *
 * Separate permissions from ITEM_MANAGE and friends, because archiving is reversible
 * and this is not. The service refuses a record that any order or purchase still refers
 * to, so an admin cannot erase something a merchant's history depends on.
 */
adminRouter.delete(
  '/items/:id',
  requirePermission(PERMISSIONS.ITEM_DELETE),
  ...validate(itemIdParamRules),
  asyncHandler(deleteAdminItem),
);

adminRouter.patch(
  '/services/:id',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  ...validate(serviceUpdateRules),
  asyncHandler(patchAdminService),
);

adminRouter.post(
  '/services/:id/archive',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminServiceArchiveHandler(true)),
);

adminRouter.post(
  '/services/:id/restore',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminServiceArchiveHandler(false)),
);

adminRouter.delete(
  '/services/:id',
  requirePermission(PERMISSIONS.SERVICE_DELETE),
  ...validate(itemIdParamRules),
  asyncHandler(deleteAdminService),
);

adminRouter.patch(
  '/materials/:id',
  requirePermission(PERMISSIONS.MATERIAL_MANAGE),
  rejectDirectStockWrite,
  ...validate(materialUpdateRules),
  asyncHandler(patchAdminMaterial),
);

adminRouter.post(
  '/materials/:id/archive',
  requirePermission(PERMISSIONS.MATERIAL_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminMaterialArchiveHandler(true)),
);

adminRouter.post(
  '/materials/:id/restore',
  requirePermission(PERMISSIONS.MATERIAL_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminMaterialArchiveHandler(false)),
);

adminRouter.delete(
  '/materials/:id',
  requirePermission(PERMISSIONS.MATERIAL_DELETE),
  ...validate(itemIdParamRules),
  asyncHandler(deleteAdminMaterial),
);

/* An admin correcting stock goes through the same ledger as the merchant app. */
adminRouter.post(
  '/stock/:subjectType/:subjectId/adjust',
  requirePermission(PERMISSIONS.STOCK_ADJUST),
  ...validate(stockAdjustRules),
  asyncHandler(postAdminStockAdjustment),
);

/* Setting stock to a counted figure, as the merchant app's recount does. */
adminRouter.put(
  '/stock/:subjectType/:subjectId/quantity',
  requirePermission(PERMISSIONS.STOCK_ADJUST),
  ...validate(stockSetRules),
  asyncHandler(putAdminStockQuantity),
);

/*
 * Creating catalog records on a merchant's behalf. The merchant is named in the URL,
 * the body is exactly what the merchant app sends, and the same service writes it.
 */
const merchantParam = param('merchantId').isMongoId().withMessage('That merchant was not found.');

adminRouter.post(
  '/merchants/:merchantId/items',
  requirePermission(PERMISSIONS.ITEM_MANAGE),
  ...validate([merchantParam, ...itemCreateRules]),
  asyncHandler(postAdminItem),
);
adminRouter.post(
  '/merchants/:merchantId/services',
  requirePermission(PERMISSIONS.SERVICE_MANAGE),
  ...validate([merchantParam, ...serviceCreateRules]),
  asyncHandler(postAdminService),
);
adminRouter.post(
  '/merchants/:merchantId/materials',
  requirePermission(PERMISSIONS.MATERIAL_MANAGE),
  ...validate([merchantParam, ...materialCreateRules]),
  asyncHandler(postAdminMaterial),
);

/* Categories: managed with the permission for the kind of record they file. */
adminRouter.post(
  '/merchants/:merchantId/categories',
  ...validate([merchantParam, ...categoryCreateRules]),
  asyncHandler(postAdminCategory),
);
adminRouter.patch('/categories/:id', ...validate(categoryRenameRules), asyncHandler(patchAdminCategory));
adminRouter.post('/categories/:id/archive', ...validate(categoryIdRules), asyncHandler(adminCategoryArchiveHandler(true)));
adminRouter.post('/categories/:id/restore', ...validate(categoryIdRules), asyncHandler(adminCategoryArchiveHandler(false)));

/* Photo galleries, on the merchant's behalf. */
const galleries = [
  { path: 'items', permission: PERMISSIONS.ITEM_MANAGE, handlers: adminItemImages, imageRules: itemImageRules, orderRules: itemImageOrderRules, idRules: itemIdRules },
  { path: 'services', permission: PERMISSIONS.SERVICE_MANAGE, handlers: adminServiceImages, imageRules: serviceImageRules, orderRules: serviceImageOrderRules, idRules: serviceIdRules },
  { path: 'materials', permission: PERMISSIONS.MATERIAL_MANAGE, handlers: adminMaterialImages, imageRules: materialImageRules, orderRules: materialImageOrderRules, idRules: materialIdRules },
];
for (const gallery of galleries) {
  adminRouter.post(
    `/${gallery.path}/:id/images`,
    requirePermission(gallery.permission),
    uploadImages.array('images'),
    ...validate(gallery.idRules),
    asyncHandler(gallery.handlers.upload),
  );
  adminRouter.put(
    `/${gallery.path}/:id/images/order`,
    requirePermission(gallery.permission),
    ...validate(gallery.orderRules),
    asyncHandler(gallery.handlers.reorder),
  );
  adminRouter.delete(
    `/${gallery.path}/:id/images/:imageId`,
    requirePermission(gallery.permission),
    ...validate(gallery.imageRules),
    asyncHandler(gallery.handlers.remove),
  );
}


/* --------------------- Phase 3: customers, suppliers, purchases -------------------- */

adminRouter.get(
  '/customers',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  ...validate(adminRelationshipListRules),
  asyncHandler(getAdminCustomers),
);

adminRouter.get(
  '/customers/:id',
  requirePermission(PERMISSIONS.CUSTOMER_VIEW),
  ...validate(itemIdParamRules),
  asyncHandler(getAdminCustomerById),
);

adminRouter.patch(
  '/customers/:id',
  requirePermission(PERMISSIONS.CUSTOMER_EDIT),
  ...validate([...itemIdParamRules, ...customerUpdateRules.slice(1)]),
  asyncHandler(patchAdminCustomer),
);

adminRouter.post(
  '/customers/:id/archive',
  requirePermission(PERMISSIONS.CUSTOMER_ARCHIVE),
  ...validate(itemIdParamRules),
  asyncHandler(adminCustomerArchiveHandler(true)),
);

adminRouter.post(
  '/customers/:id/restore',
  requirePermission(PERMISSIONS.CUSTOMER_ARCHIVE),
  ...validate(itemIdParamRules),
  asyncHandler(adminCustomerArchiveHandler(false)),
);

adminRouter.get(
  '/suppliers',
  requirePermission(PERMISSIONS.SUPPLIER_VIEW),
  ...validate(adminRelationshipListRules),
  asyncHandler(getAdminSuppliers),
);

adminRouter.get(
  '/suppliers/:id',
  requirePermission(PERMISSIONS.SUPPLIER_VIEW),
  ...validate(itemIdParamRules),
  asyncHandler(getAdminSupplierById),
);

adminRouter.patch(
  '/suppliers/:id',
  requirePermission(PERMISSIONS.SUPPLIER_MANAGE),
  ...validate([...itemIdParamRules, ...supplierUpdateRules.slice(1)]),
  asyncHandler(patchAdminSupplier),
);

adminRouter.post(
  '/suppliers/:id/archive',
  requirePermission(PERMISSIONS.SUPPLIER_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminSupplierArchiveHandler(true)),
);

adminRouter.post(
  '/suppliers/:id/restore',
  requirePermission(PERMISSIONS.SUPPLIER_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(adminSupplierArchiveHandler(false)),
);

adminRouter.get(
  '/purchases',
  requirePermission(PERMISSIONS.PURCHASE_VIEW),
  ...validate(adminPurchaseListRules),
  asyncHandler(getAdminPurchases),
);

adminRouter.get(
  '/purchases/:id',
  requirePermission(PERMISSIONS.PURCHASE_VIEW),
  ...validate(itemIdParamRules),
  asyncHandler(getAdminPurchaseById),
);

adminRouter.post(
  '/purchases/:id/cancel',
  requirePermission(PERMISSIONS.PURCHASE_MANAGE),
  ...validate(itemIdParamRules),
  asyncHandler(postAdminPurchaseCancel),
);

/* Support recording a payment a merchant could not: same engine, actor marked admin. */
adminRouter.post(
  '/purchases/:id/payments',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  ...validate([...itemIdParamRules, ...paymentCreateRules.slice(1)]),
  asyncHandler(postAdminPurchasePayment),
);

adminRouter.get(
  '/payments',
  requirePermission(PERMISSIONS.PAYMENT_VIEW),
  ...validate(adminPaymentListRules),
  asyncHandler(getAdminPayments),
);

/* Corrects a payment, including a wrong amount; the payable is rebuilt from its ledger. */
adminRouter.patch(
  '/payments/:id',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  ...validate(paymentAnnotateRules),
  asyncHandler(patchAdminPayment),
);

/* Deletes a payment recorded by mistake. */
adminRouter.delete(
  '/payments/:id',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  ...validate(paymentDeleteRules),
  asyncHandler(deleteAdminPayment),
);

adminRouter.get(
  '/merchants/:merchantId/relationship-summary',
  requirePermission(PERMISSIONS.MERCHANT_VIEW),
  ...validate(merchantIdParamRules),
  asyncHandler(getAdminRelationshipSummary),
);

/* ------------------- Phase 4: orders, instalments, receivables ------------------- */

adminRouter.get(
  '/orders',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  ...validate(adminOrderListRules),
  asyncHandler(getAdminOrders),
);

adminRouter.get(
  '/orders/:id',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  ...validate(itemIdParamRules),
  asyncHandler(getAdminOrderById),
);

/* Delivery date, time and location only; lines and totals stay the merchant's. */
adminRouter.patch(
  '/orders/:id/delivery',
  requirePermission(PERMISSIONS.ORDER_EDIT),
  ...validate(orderDeliveryRules),
  asyncHandler(patchAdminOrderDelivery),
);

adminRouter.post(
  '/orders/:id/status',
  requirePermission(PERMISSIONS.ORDER_EDIT),
  ...validate([...itemIdParamRules, ...adminOrderStatusRules]),
  asyncHandler(postAdminOrderStatus),
);

/* Cancelling has its own permission, so it has its own endpoint. */
adminRouter.post(
  '/orders/:id/cancel',
  requirePermission(PERMISSIONS.ORDER_CANCEL),
  ...validate(itemIdParamRules),
  asyncHandler(postAdminOrderCancel),
);

/* Support recording a payment a merchant could not: same engine, actor marked admin. */
adminRouter.post(
  '/orders/:id/payments',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  // The order rules rather than the purchase ones: only these validate the instalment
  // number, and an unvalidated one would reach the engine as NaN.
  ...validate([...itemIdParamRules, ...orderPaymentRules.slice(1)]),
  asyncHandler(postAdminOrderPayment),
);

adminRouter.put(
  '/orders/:id/installments',
  requirePermission(PERMISSIONS.INSTALLMENT_MANAGE),
  ...validate([...itemIdParamRules, ...installmentPlanRules.slice(1)]),
  asyncHandler(putAdminInstallmentPlan),
);

adminRouter.get(
  '/installments',
  requirePermission(PERMISSIONS.INSTALLMENT_VIEW),
  ...validate(adminInstallmentListRules),
  asyncHandler(getAdminInstallments),
);

adminRouter.get(
  '/receivables',
  requirePermission(PERMISSIONS.PAYMENT_VIEW),
  ...validate(adminReceivablesListRules),
  asyncHandler(getAdminReceivables),
);

adminRouter.get(
  '/merchants/:merchantId/order-summary',
  requirePermission(PERMISSIONS.ORDER_VIEW),
  ...validate(merchantIdParamRules),
  asyncHandler(getAdminOrderSummary),
);
