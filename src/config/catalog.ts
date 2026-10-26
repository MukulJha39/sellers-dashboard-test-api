/**
 * Catalog vocabulary shared by the API, the merchant app and the admin panel.
 *
 * Keeping these lists on the server means a client never invents a unit or a reason
 * the server would reject, and the admin panel can label them consistently.
 */

/**
 * Units of measurement are records the admin panel manages (see models/MeasurementUnit).
 * A unit is referred to everywhere by its `code`, a stable slug such as "kilogram".
 */
export type Unit = string;

/** Who a unit can be chosen for. */
export const UNIT_APPLIES_TO = ['item', 'material'] as const;
export type UnitAppliesTo = (typeof UNIT_APPLIES_TO)[number];

/**
 * A unit's icon is a Material Icons name, such as "scale" or "water_drop". The same name
 * works in Flutter (`Icons.scale`), React Native (`MaterialIcons`) and the web font, so
 * every client draws the identical icon.
 */
export const UNIT_ICON_PATTERN = /^[a-z0-9_]{1,40}$/;

/** The sections a unit picker is split into, in display order. */
export const UNIT_GROUPS = [
  { value: 'weight', label: 'By weight' },
  { value: 'volume', label: 'Liquid' },
  { value: 'count', label: 'By count' },
  { value: 'length', label: 'By length' },
  { value: 'other', label: 'Other' },
] as const;
export type UnitGroup = (typeof UNIT_GROUPS)[number]['value'];
export const UNIT_GROUP_VALUES: readonly UnitGroup[] = UNIT_GROUPS.map((group) => group.value);

/** A unit code: lowercase letters, digits and underscores, starting with a letter. */
export const UNIT_CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

export interface DefaultUnit {
  code: string;
  name: string;
  symbol: string;
  /** A Material Icons name. */
  icon: string;
  group: UnitGroup;
  wholeNumbersOnly: boolean;
  /** The emoji this unit shipped with briefly, replaced by `icon` on upgrade. */
  legacyIcon: string;
}

/**
 * The units a fresh installation starts with. They are written to the database the
 * first time the unit catalogue is read, after which the admin panel owns them.
 */
export const DEFAULT_UNITS: readonly DefaultUnit[] = [
  { code: 'piece', name: 'Piece', symbol: 'pieces', icon: 'category', group: 'count', wholeNumbersOnly: true, legacyIcon: '🔢' },
  { code: 'pack', name: 'Pack', symbol: 'packs', icon: 'inventory_2', group: 'count', wholeNumbersOnly: true, legacyIcon: '📦' },
  { code: 'box', name: 'Box', symbol: 'boxes', icon: 'all_inbox', group: 'count', wholeNumbersOnly: true, legacyIcon: '🗃️' },
  { code: 'set', name: 'Set', symbol: 'sets', icon: 'widgets', group: 'count', wholeNumbersOnly: true, legacyIcon: '🧰' },
  { code: 'pair', name: 'Pair', symbol: 'pairs', icon: 'filter_2', group: 'count', wholeNumbersOnly: true, legacyIcon: '🧦' },
  { code: 'dozen', name: 'Dozen', symbol: 'dozen', icon: 'grid_view', group: 'count', wholeNumbersOnly: true, legacyIcon: '🥚' },
  { code: 'bag', name: 'Bag', symbol: 'bags', icon: 'shopping_bag', group: 'count', wholeNumbersOnly: true, legacyIcon: '🛍️' },
  { code: 'bottle', name: 'Bottle', symbol: 'bottles', icon: 'local_drink', group: 'count', wholeNumbersOnly: true, legacyIcon: '🧴' },
  { code: 'roll', name: 'Roll', symbol: 'rolls', icon: 'toll', group: 'count', wholeNumbersOnly: true, legacyIcon: '🧻' },
  { code: 'sheet', name: 'Sheet', symbol: 'sheets', icon: 'description', group: 'count', wholeNumbersOnly: true, legacyIcon: '📄' },
  { code: 'gram', name: 'Gram', symbol: 'g', icon: 'scale', group: 'weight', wholeNumbersOnly: false, legacyIcon: '⚖️' },
  { code: 'kilogram', name: 'Kilogram', symbol: 'kg', icon: 'scale', group: 'weight', wholeNumbersOnly: false, legacyIcon: '⚖️' },
  { code: 'millilitre', name: 'Millilitre', symbol: 'ml', icon: 'water_drop', group: 'volume', wholeNumbersOnly: false, legacyIcon: '💧' },
  { code: 'litre', name: 'Litre', symbol: 'L', icon: 'water_drop', group: 'volume', wholeNumbersOnly: false, legacyIcon: '🥛' },
  { code: 'centimetre', name: 'Centimetre', symbol: 'cm', icon: 'straighten', group: 'length', wholeNumbersOnly: false, legacyIcon: '📏' },
  { code: 'metre', name: 'Metre', symbol: 'm', icon: 'straighten', group: 'length', wholeNumbersOnly: false, legacyIcon: '📏' },
  { code: 'foot', name: 'Foot', symbol: 'ft', icon: 'straighten', group: 'length', wholeNumbersOnly: false, legacyIcon: '📏' },
  { code: 'square_foot', name: 'Square foot', symbol: 'sq ft', icon: 'square_foot', group: 'length', wholeNumbersOnly: false, legacyIcon: '📐' },
];

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
