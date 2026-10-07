import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { asyncHandler, validate } from '../../middleware/validate';
import {
  getDashboard,
  getOrderActivity,
  getOrderById,
  getOrders,
  getReceivables,
  getUpcomingInstallments,
  patchOrder,
  postEvenInstallmentPlan,
  postOrder,
  postOrderPayment,
  postOrderStatus,
  putInstallmentPlan,
} from './orderController';
import {
  evenPlanRules,
  installmentListRules,
  installmentPlanRules,
  orderCreateRules,
  orderIdRules,
  orderListRules,
  orderPaymentRules,
  orderTransitionRules,
  orderUpdateRules,
  receivablesListRules,
} from './orderValidators';

/**
 * Orders, their instalment plans, receivables and the dashboard.
 *
 * Assembled from one sub-router per resource and mounted on the bare API prefix, for the
 * same reason the catalog and relationship routers are: a blanket merchant guard on a
 * parent mounted there would intercept every request under the prefix, including the
 * admin routes.
 */
export const orderRouter = Router();

function merchantRouter(): Router {
  const router = Router();
  router.use(authenticateMerchant);
  return router;
}

/* ---------------------------------- orders --------------------------------- */

const orderRoutes = merchantRouter();
orderRoutes.get('/', ...validate(orderListRules), asyncHandler(getOrders));
orderRoutes.post('/', ...validate(orderCreateRules), asyncHandler(postOrder));
orderRoutes.get('/:id', ...validate(orderIdRules), asyncHandler(getOrderById));
orderRoutes.patch('/:id', ...validate(orderUpdateRules), asyncHandler(patchOrder));
orderRoutes.get('/:id/activity', ...validate(orderIdRules), asyncHandler(getOrderActivity));
orderRoutes.post('/:id/status', ...validate(orderTransitionRules), asyncHandler(postOrderStatus));
orderRoutes.post('/:id/payments', ...validate(orderPaymentRules), asyncHandler(postOrderPayment));
// A plan is replaced wholesale rather than patched row by row: a schedule has to add up to
// the order total, and that can only be checked against the whole of it.
orderRoutes.put(
  '/:id/installments',
  ...validate(installmentPlanRules),
  asyncHandler(putInstallmentPlan),
);
orderRoutes.post(
  '/:id/installments/even',
  ...validate(evenPlanRules),
  asyncHandler(postEvenInstallmentPlan),
);
orderRouter.use('/orders', orderRoutes);

/* ------------------------------- receivables ------------------------------- */

const receivableRoutes = merchantRouter();
receivableRoutes.get('/', ...validate(receivablesListRules), asyncHandler(getReceivables));
receivableRoutes.get(
  '/installments',
  ...validate(installmentListRules),
  asyncHandler(getUpcomingInstallments),
);
orderRouter.use('/receivables', receivableRoutes);

/* -------------------------------- dashboard -------------------------------- */

const dashboardRoutes = merchantRouter();
dashboardRoutes.get('/', asyncHandler(getDashboard));
orderRouter.use('/dashboard', dashboardRoutes);
