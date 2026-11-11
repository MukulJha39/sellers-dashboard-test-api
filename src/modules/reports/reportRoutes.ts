import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { asyncHandler, validate } from '../../middleware/validate';
import {
  getBestSellersReport,
  getMoneyInOutReport,
  getMoneyToCollectReport,
  getNotSellingReport,
  getProfitLossReport,
  getSalesByCustomerReport,
  getSalesByProductReport,
  getSalesReport,
  getStockReport,
} from './reportController';
import {
  customerSalesRules,
  moneyInOutReportRules,
  moneyToCollectRules,
  notSellingRules,
  productSalesRules,
  profitLossReportRules,
  salesReportRules,
  stockReportRules,
} from './reportValidators';

/**
 * The merchant's Reports screen: one endpoint per question it answers. Every report reads
 * only the signed-in merchant's own records.
 *
 * Mounted on `/reports` only, so the merchant guard never runs for any other path.
 */
export const reportRouter = Router();
reportRouter.use(authenticateMerchant);

// Money
reportRouter.get('/sales', ...validate(salesReportRules), asyncHandler(getSalesReport));
reportRouter.get('/profit-loss', ...validate(profitLossReportRules), asyncHandler(getProfitLossReport));
reportRouter.get('/money-in-out', ...validate(moneyInOutReportRules), asyncHandler(getMoneyInOutReport));
reportRouter.get('/money-to-collect', ...validate(moneyToCollectRules), asyncHandler(getMoneyToCollectReport));

// Goods (stock)
reportRouter.get('/stock', ...validate(stockReportRules), asyncHandler(getStockReport));
reportRouter.get('/best-sellers', ...validate(productSalesRules), asyncHandler(getBestSellersReport));
reportRouter.get('/not-selling', ...validate(notSellingRules), asyncHandler(getNotSellingReport));

// Sales
reportRouter.get('/sales-by-product', ...validate(productSalesRules), asyncHandler(getSalesByProductReport));
reportRouter.get('/sales-by-customer', ...validate(customerSalesRules), asyncHandler(getSalesByCustomerReport));
