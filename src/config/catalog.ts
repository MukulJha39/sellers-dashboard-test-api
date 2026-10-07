/**
 * Catalog vocabulary shared by the API, the merchant app and the admin panel.
 *
 * Keeping these lists on the server means a client never invents a unit or a reason
 * the server would reject, and the admin panel can label them consistently.
 */

/** Units of measurement a merchant can choose for an item or raw material. */
export const UNITS = [
  'piece',
  'pack',
  'box',
  'set',
  'pair',
  'dozen',
  'bag',
  'bottle',
  'roll',
  'sheet',
  'gram',
  'kilogram',
  'millilitre',
  'litre',
  'centimetre',
  'metre',
  'foot',
  'square_foot',
] as const;

export type Unit = (typeof UNITS)[number];

/** Units that only make sense in whole numbers. */
export const WHOLE_NUMBER_UNITS: ReadonlySet<Unit> = new Set<Unit>([
  'piece',
  'pack',
  'box',
  'set',
  'pair',
  'dozen',
  'bag',
  'bottle',
  'roll',
  'sheet',
]);

export function isWholeNumberUnit(unit: string): boolean {
  return WHOLE_NUMBER_UNITS.has(unit as Unit);
}

/** How a service is billed (PRD section 6.4). */
export const BILLING_UNITS = ['one_time', 'hourly', 'per_session', 'per_unit', 'package'] as const;
export type BillingUnit = (typeof BILLING_UNITS)[number];

/** Billing units where a duration is meaningful. */
export const DURATION_BILLING_UNITS: ReadonlySet<BillingUnit> = new Set<BillingUnit>([
  'hourly',
  'per_session',
]);

/** What a category groups. */
export const CATEGORY_KINDS = ['item', 'service', 'material'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** What a stock movement was for. */
export const STOCK_MOVEMENT_TYPES = [
  'opening',
  'adjustment',
  'receipt',
  'sale',
  'return',
  'reversal',
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/**
 * Why stock changed. A manual adjustment always records one of these, so no quantity
 * change is ever unexplained (PRD section 12).
 */
export const STOCK_ADJUSTMENT_REASONS = [
  'opening_stock',
  'damaged',
  'lost',
  'expired',
  'found',
  'manual_correction',
  'recount',
  'other',
] as const;
export type StockAdjustmentReason = (typeof STOCK_ADJUSTMENT_REASONS)[number];

/** What a stock-tracked record can be. Services are deliberately absent. */
export const STOCK_SUBJECT_TYPES = ['item', 'material'] as const;
export type StockSubjectType = (typeof STOCK_SUBJECT_TYPES)[number];

/** Currencies the product understands today. */
export const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** Business categories offered during setup; every one is optional to choose. */
export const BUSINESS_CATEGORIES = [
  'retail',
  'wholesale',
  'grocery',
  'restaurant_cafe',
  'bakery',
  'salon_spa',
  'clinic_health',
  'fitness',
  'repair_service',
  'manufacturing',
  'tailoring',
  'electronics',
  'pharmacy',
  'education_coaching',
  'professional_services',
  'construction',
  'logistics',
  'agriculture',
  'other',
] as const;

export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
