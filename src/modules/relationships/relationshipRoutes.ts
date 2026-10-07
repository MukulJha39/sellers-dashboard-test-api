import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { asyncHandler, validate } from '../../middleware/validate';
import {
  customerArchiveHandler,
  getCustomerById,
  getCustomers,
  getCustomerTags,
  getPayments,
  getPurchaseById,
  getPurchases,
  getPurchaseSummary,
  getSupplierById,
  getSuppliers,
  patchCustomer,
  patchPayment,
  patchPurchase,
  patchSupplier,
  postCustomer,
  postPurchase,
  postPurchaseCancel,
  postPurchasePayment,
  postPurchaseReceive,
  postSupplier,
  supplierArchiveHandler,
} from './relationshipController';
import {
  customerCreateRules,
  customerIdRules,
  customerListRules,
  customerUpdateRules,
  paymentAnnotateRules,
  paymentCreateRules,
  paymentListRules,
  purchaseCancelRules,
  purchaseCreateRules,
  purchaseIdRules,
  purchaseListRules,
  purchaseUpdateRules,
  supplierCreateRules,
  supplierIdRules,
  supplierListRules,
  supplierUpdateRules,
} from './relationshipValidators';

/**
 * Customers, suppliers, purchases and payments.
 *
 * Assembled from one sub-router per resource and mounted on the bare API prefix, for
 * the same reason the catalog router is: a blanket merchant guard on a parent mounted
 * there would intercept every request under the prefix, including the admin routes.
 */
export const relationshipRouter = Router();

function merchantRouter(): Router {
  const router = Router();
  router.use(authenticateMerchant);
  return router;
}

/* -------------------------------- customers ------------------------------- */

const customerRoutes = merchantRouter();
customerRoutes.get('/', ...validate(customerListRules), asyncHandler(getCustomers));
customerRoutes.post('/', ...validate(customerCreateRules), asyncHandler(postCustomer));
// Before `/:id`, or "tags" would be read as a customer id.
customerRoutes.get('/tags', asyncHandler(getCustomerTags));
customerRoutes.get('/:id', ...validate(customerIdRules), asyncHandler(getCustomerById));
customerRoutes.patch('/:id', ...validate(customerUpdateRules), asyncHandler(patchCustomer));
customerRoutes.post(
  '/:id/archive',
  ...validate(customerIdRules),
  asyncHandler(customerArchiveHandler(true)),
);
customerRoutes.post(
  '/:id/restore',
  ...validate(customerIdRules),
  asyncHandler(customerArchiveHandler(false)),
);
relationshipRouter.use('/customers', customerRoutes);

/* -------------------------------- suppliers ------------------------------- */

const supplierRoutes = merchantRouter();
supplierRoutes.get('/', ...validate(supplierListRules), asyncHandler(getSuppliers));
supplierRoutes.post('/', ...validate(supplierCreateRules), asyncHandler(postSupplier));
supplierRoutes.get('/:id', ...validate(supplierIdRules), asyncHandler(getSupplierById));
supplierRoutes.patch('/:id', ...validate(supplierUpdateRules), asyncHandler(patchSupplier));
supplierRoutes.post(
  '/:id/archive',
  ...validate(supplierIdRules),
  asyncHandler(supplierArchiveHandler(true)),
);
supplierRoutes.post(
  '/:id/restore',
  ...validate(supplierIdRules),
  asyncHandler(supplierArchiveHandler(false)),
);
relationshipRouter.use('/suppliers', supplierRoutes);

/* -------------------------------- purchases ------------------------------- */

const purchaseRoutes = merchantRouter();
purchaseRoutes.get('/', ...validate(purchaseListRules), asyncHandler(getPurchases));
purchaseRoutes.post('/', ...validate(purchaseCreateRules), asyncHandler(postPurchase));
purchaseRoutes.get('/summary', asyncHandler(getPurchaseSummary));
purchaseRoutes.get('/:id', ...validate(purchaseIdRules), asyncHandler(getPurchaseById));
purchaseRoutes.patch('/:id', ...validate(purchaseUpdateRules), asyncHandler(patchPurchase));
purchaseRoutes.post(
  '/:id/receive',
  ...validate(purchaseIdRules),
  asyncHandler(postPurchaseReceive),
);
purchaseRoutes.post(
  '/:id/cancel',
  ...validate(purchaseCancelRules),
  asyncHandler(postPurchaseCancel),
);
purchaseRoutes.post(
  '/:id/payments',
  ...validate(paymentCreateRules),
  asyncHandler(postPurchasePayment),
);
relationshipRouter.use('/purchases', purchaseRoutes);

/* --------------------------------- payments -------------------------------- */

const paymentRoutes = merchantRouter();
paymentRoutes.get('/', ...validate(paymentListRules), asyncHandler(getPayments));
// Corrects what an entry says about itself. The amount and method are refused by the
// validator: entries stay append-only where money is concerned.
paymentRoutes.patch('/:id', ...validate(paymentAnnotateRules), asyncHandler(patchPayment));
relationshipRouter.use('/payments', paymentRoutes);
