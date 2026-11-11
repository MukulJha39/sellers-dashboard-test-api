import { Router } from 'express';
import { authenticateMerchant } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { getItems, getMaterials, getServices, getStockHistory } from '../catalog/catalogController';
import { itemListRules, materialListRules, serviceListRules, stockHistoryRules } from '../catalog/catalogValidators';
import { getOrders, getReceivables } from '../orders/orderController';
import { orderListRules, receivablesListRules } from '../orders/orderValidators';
import { getCustomers, getPayments, getPurchases, getSuppliers } from '../relationships/relationshipController';
import {
  customerListRules,
  paymentListRules,
  purchaseListRules,
  supplierListRules,
} from '../relationships/relationshipValidators';
import { excelExport, exportColumns } from './excelExport';

/**
 * Excel downloads for the merchant app: `GET /exports/<report>` with the same query
 * parameters as the matching list (`/items`, `/orders`, …). The response is the
 * .xlsx file itself, ready to share on WhatsApp or email.
 *
 * Mounted on `/exports` only, so the merchant guard never runs for any other path.
 */
export const exportRouter = Router();
exportRouter.use(authenticateMerchant);

const merchantExports = [
  { path: 'items', rules: itemListRules, list: getItems },
  { path: 'services', rules: serviceListRules, list: getServices },
  { path: 'materials', rules: materialListRules, list: getMaterials },
  { path: 'stock-movements', rules: stockHistoryRules, list: getStockHistory },
  { path: 'customers', rules: customerListRules, list: getCustomers },
  { path: 'suppliers', rules: supplierListRules, list: getSuppliers },
  { path: 'purchases', rules: purchaseListRules, list: getPurchases },
  { path: 'payments', rules: paymentListRules, list: getPayments },
  { path: 'orders', rules: orderListRules, list: getOrders },
  { path: 'receivables', rules: receivablesListRules, list: getReceivables },
] as const;

for (const entry of merchantExports) {
  exportRouter.get(`/${entry.path}/columns`, exportColumns({ report: entry.path, scope: 'merchant' }));
  exportRouter.get(`/${entry.path}`, ...validate(entry.rules), excelExport({ report: entry.path, scope: 'merchant', list: entry.list }));
}
