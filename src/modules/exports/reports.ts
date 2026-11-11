/**
 * What each Excel report contains: its title and columns, in the order a reader expects.
 *
 * Columns read the same rows the list endpoints return, so they are written against
 * those response shapes. `admin` exports add the merchant each row belongs to; a
 * merchant's own export does not need it.
 */

export type ReportScope = 'admin' | 'merchant';

type Cell = string | number | boolean | null | undefined;

export interface ExportColumn {
  header: string;
  width?: number;
  /** How the cell is written: money is in paise and becomes rupees. */
  kind?: 'text' | 'money' | 'number' | 'date' | 'datetime' | 'boolean';
  value: (row: Row) => Cell;
}

// Rows are JSON from the list endpoints, so fields are read loosely and typed per column.
type Row = Record<string, unknown> & { address?: Record<string, unknown> | null; lines?: unknown[] };

/**
 * A column's stable key, from its header: "Selling price" → "selling-price". Clients
 * send these keys to choose columns, so a header's wording is its contract.
 */
export function columnKey(column: Pick<ExportColumn, 'header'>): string {
  return column.header.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** "partially_paid" → "Partially paid". */
export function humanize(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const text = (field: string, header: string, width?: number): ExportColumn => ({
  header,
  ...(width ? { width } : {}),
  value: (row) => row[field] as Cell,
});
const money = (field: string, header: string): ExportColumn => ({ header, kind: 'money', width: 16, value: (row) => row[field] as Cell });
const number = (field: string, header: string): ExportColumn => ({ header, kind: 'number', width: 12, value: (row) => row[field] as Cell });
const date = (field: string, header: string): ExportColumn => ({ header, kind: 'date', width: 14, value: (row) => row[field] as Cell });
const datetime = (field: string, header: string): ExportColumn => ({ header, kind: 'datetime', width: 19, value: (row) => row[field] as Cell });
const yesNo = (field: string, header: string): ExportColumn => ({ header, kind: 'boolean', width: 10, value: (row) => row[field] as Cell });
const label = (field: string, header: string, width = 16): ExportColumn => ({ header, width, value: (row) => humanize(row[field]) });

const merchant: ExportColumn = { header: 'Merchant', width: 24, value: (row) => (row.merchantName as Cell) ?? null };

function withMerchant(scope: ReportScope, columns: ExportColumn[]): ExportColumn[] {
  return scope === 'admin' ? [merchant, ...columns] : columns;
}

const stockStatus: ExportColumn = {
  header: 'Stock status',
  width: 14,
  value: (row) => (!row.trackStock ? 'Not tracked' : row.isOutOfStock ? 'Out of stock' : row.isLowStock ? 'Low' : 'In stock'),
};

const status: ExportColumn = { header: 'Status', width: 10, value: (row) => (row.archived ? 'Archived' : 'Active') };

const city: ExportColumn = { header: 'City', width: 16, value: (row) => (row.address?.city as Cell) ?? null };

export interface ReportSpec {
  title: string;
  columns: (scope: ReportScope) => ExportColumn[];
}

export const REPORTS = {
  items: {
    title: 'Products',
    columns: (scope) =>
      withMerchant(scope, [
        text('name', 'Product', 28),
        text('sku', 'SKU', 14),
        text('barcode', 'Barcode', 16),
        text('categoryName', 'Category', 18),
        label('unit', 'Unit', 12),
        number('quantity', 'Available'),
        number('lowStockThreshold', 'Low stock at'),
        stockStatus,
        money('sellingPriceMinor', 'Selling price'),
        money('costPriceMinor', 'Cost price'),
        number('taxRatePercent', 'Tax %'),
        status,
        datetime('updatedAt', 'Updated'),
      ]),
  },
  services: {
    title: 'Services',
    columns: (scope) =>
      withMerchant(scope, [
        text('name', 'Service', 28),
        text('categoryName', 'Category', 18),
        label('billingUnit', 'Billed'),
        money('rateMinor', 'Rate'),
        number('durationMinutes', 'Minutes'),
        number('taxRatePercent', 'Tax %'),
        { header: 'Offered', width: 10, kind: 'boolean', value: (row) => row.isActive as Cell },
        status,
        datetime('updatedAt', 'Updated'),
      ]),
  },
  materials: {
    title: 'Raw materials',
    columns: (scope) =>
      withMerchant(scope, [
        text('name', 'Raw material', 28),
        text('categoryName', 'Category', 18),
        label('unit', 'Unit', 12),
        number('quantity', 'Available'),
        number('lowStockThreshold', 'Low stock at'),
        stockStatus,
        money('purchaseCostMinor', 'Purchase cost'),
        text('batchReference', 'Batch', 14),
        date('expiryDate', 'Expiry'),
        text('supplierName', 'Supplier', 20),
        status,
        datetime('updatedAt', 'Updated'),
      ]),
  },
  'stock-movements': {
    title: 'Stock activity',
    columns: (scope) =>
      withMerchant(scope, [
        datetime('createdAt', 'When'),
        label('subjectType', 'Kind', 10),
        text('subjectName', 'Record', 26),
        label('type', 'Movement', 12),
        label('reason', 'Reason', 16),
        number('delta', 'Change'),
        number('balanceAfter', 'Balance after'),
        text('note', 'Note', 30),
        text('actorLabel', 'By', 24),
      ]),
  },
  'low-stock': {
    title: 'Needs attention',
    columns: (scope) =>
      withMerchant(scope, [
        text('name', 'Name', 28),
        label('type', 'Kind', 10),
        label('unit', 'Unit', 12),
        number('quantity', 'Available'),
        number('lowStockThreshold', 'Low stock at'),
        { header: 'Out of stock', width: 12, kind: 'boolean', value: (row) => row.isOutOfStock as Cell },
      ]),
  },
  customers: {
    title: 'Customers',
    columns: (scope) =>
      withMerchant(scope, [
        text('fullName', 'Customer', 24),
        text('phoneE164', 'Phone', 16),
        text('email', 'Email', 24),
        text('companyName', 'Company', 20),
        city,
        number('orderCount', 'Orders'),
        money('outstandingMinor', 'Outstanding'),
        datetime('lastOrderAt', 'Last order'),
        status,
      ]),
  },
  suppliers: {
    title: 'Suppliers',
    columns: (scope) =>
      withMerchant(scope, [
        text('name', 'Supplier', 24),
        text('contactPerson', 'Contact', 18),
        text('phoneE164', 'Phone', 16),
        text('email', 'Email', 24),
        text('taxNumber', 'Tax number', 18),
        city,
        number('purchaseCount', 'Purchases'),
        money('totalPurchasedMinor', 'Total purchased'),
        money('outstandingMinor', 'Outstanding'),
        datetime('lastPurchaseAt', 'Last purchase'),
        status,
      ]),
  },
  purchases: {
    title: 'Purchases',
    columns: (scope) =>
      withMerchant(scope, [
        text('reference', 'Purchase', 12),
        date('purchaseDate', 'Date'),
        text('supplierName', 'Supplier', 22),
        { header: 'Lines', kind: 'number', width: 8, value: (row) => row.lines?.length ?? 0 },
        money('subtotalMinor', 'Subtotal'),
        money('additionalCostMinor', 'Additional cost'),
        money('totalMinor', 'Total'),
        money('paidMinor', 'Paid'),
        money('outstandingMinor', 'Outstanding'),
        label('paymentState', 'Payment'),
        date('dueDate', 'Due'),
        label('status', 'Status', 12),
        yesNo('received', 'Received'),
        text('notes', 'Notes', 30),
      ]),
  },
  payments: {
    title: 'Payments',
    columns: (scope) =>
      withMerchant(scope, [
        datetime('paidAt', 'Paid on'),
        { header: 'Direction', width: 11, value: (row) => (row.direction === 'in' ? 'Received' : 'Paid out') },
        label('payableType', 'Against', 10),
        text('payableReference', 'Reference', 12),
        money('amountMinor', 'Amount'),
        label('method', 'Method', 14),
        text('reference', 'Transaction ref', 18),
        number('installmentNumber', 'Instalment'),
        money('balanceAfterMinor', 'Left after this'),
        text('actorLabel', 'Recorded by', 24),
        text('notes', 'Notes', 30),
      ]),
  },
  orders: {
    title: 'Orders',
    columns: (scope) =>
      withMerchant(scope, [
        text('reference', 'Order', 12),
        datetime('orderDate', 'Ordered'),
        { header: 'Customer', width: 22, value: (row) => (row.customerName as Cell) ?? 'Walk-in sale' },
        label('status', 'Status', 12),
        { header: 'Lines', kind: 'number', width: 8, value: (row) => row.lines?.length ?? 0 },
        money('subtotalMinor', 'Subtotal'),
        money('discountMinor', 'Discount'),
        money('taxMinor', 'Tax'),
        money('totalMinor', 'Total'),
        money('paidMinor', 'Paid'),
        money('outstandingMinor', 'Outstanding'),
        label('paymentState', 'Payment'),
        date('dueDate', 'Due'),
        date('deliveryDate', 'Delivery date'),
        text('deliveryTime', 'Delivery time', 12),
        text('deliveryLocation', 'Delivery location', 30),
        text('notes', 'Notes', 30),
      ]),
  },
  installments: {
    title: 'Instalments',
    columns: (scope) =>
      withMerchant(scope, [
        text('reference', 'Order', 12),
        { header: 'Customer', width: 22, value: (row) => (row.customerName as Cell) ?? 'Walk-in sale' },
        number('number', 'Instalment'),
        money('amountMinor', 'Amount'),
        money('paidMinor', 'Paid'),
        money('outstandingMinor', 'Outstanding'),
        date('dueDate', 'Due'),
        label('status', 'Status', 14),
        yesNo('isOverdue', 'Overdue'),
      ]),
  },
  receivables: {
    title: 'Receivables',
    columns: (scope) =>
      scope === 'admin'
        ? [
            merchant,
            number('orderCount', 'Orders owing'),
            money('outstandingMinor', 'Outstanding'),
            money('overdueMinor', 'Overdue amount'),
            number('overdueOrders', 'Overdue orders'),
            money('dueSoonMinor', 'Due soon'),
            date('nextDueDate', 'Next due'),
          ]
        : [
            text('customerName', 'Customer', 24),
            number('orderCount', 'Orders owing'),
            money('outstandingMinor', 'Outstanding'),
            money('overdueMinor', 'Overdue amount'),
            date('nextDueDate', 'Next due'),
            yesNo('isOverdue', 'Overdue'),
          ],
  },
} satisfies Record<string, ReportSpec>;

export type ReportKey = keyof typeof REPORTS;
