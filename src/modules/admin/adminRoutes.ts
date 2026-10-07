import { Router } from 'express';
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
  patchAdminPayment,
  postAdminOrderStatus,
  putAdminInstallmentPlan,
} from './adminOrderController';
import { installmentPlanRules, orderPaymentRules } from '../orders/orderValidators';
import {
  customerUpdateRules,
  paymentAnnotateRules,
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
  itemUpdateRules,
  materialUpdateRules,
  rejectDirectStockWrite,
  serviceUpdateRules,
  stockAdjustRules,
} from '../catalog/catalogValidators';
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

/* An admin correcting stock goes through the same ledger as the merchant app. */
adminRouter.post(
  '/stock/:subjectType/:subjectId/adjust',
  requirePermission(PERMISSIONS.STOCK_ADJUST),
  ...validate(stockAdjustRules),
  asyncHandler(postAdminStockAdjustment),
);


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

/* Corrects what an entry says about itself; the amount is refused by the validator. */
adminRouter.patch(
  '/payments/:id',
  requirePermission(PERMISSIONS.PAYMENT_MANAGE),
  ...validate(paymentAnnotateRules),
  asyncHandler(patchAdminPayment),
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
