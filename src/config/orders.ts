/**
 * Order vocabulary and the status lifecycle (PRD section 8).
 *
 * Served to the clients through `/catalog/meta`, like the rest of the vocabulary, so
 * the app and the admin panel never keep their own copy of these lists.
 */

/**
 * The order lifecycle.
 *
 * `draft` is a held order or a quote — nothing is committed. Everything from `confirmed`
 * onwards means the merchant has committed the goods, which is what moves stock.
 * `cancelled` and `returned` are terminal and both put stock back.
 */
export const ORDER_STATUSES = [
  'draft',
  'confirmed',
  'in_progress',
  'ready',
  'completed',
  'cancelled',
  'returned',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * Which status may follow which.
 *
 * An explicit map rather than scattered `if` statements, so the whole lifecycle can be
 * read in one place and tested as a unit. A transition that is not listed here is
 * refused, which means a new status cannot quietly become reachable from everywhere.
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  draft: ['confirmed', 'in_progress', 'ready', 'completed', 'cancelled'],
  confirmed: ['in_progress', 'ready', 'completed', 'cancelled'],
  in_progress: ['ready', 'completed', 'cancelled'],
  ready: ['completed', 'cancelled'],
  // A completed order can still come back. Nothing else follows it.
  completed: ['returned'],
  cancelled: [],
  returned: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Statuses from which nothing further can happen. */
export const TERMINAL_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'cancelled',
  'returned',
]);

/**
 * Statuses in which the goods are considered committed to the customer.
 *
 * This is the single rule that decides whether an order is holding stock. A draft holds
 * none; a cancelled or returned order has given it back. Everything between holds it.
 */
export const STOCK_HOLDING_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'confirmed',
  'in_progress',
  'ready',
  'completed',
]);

export function holdsStock(status: OrderStatus): boolean {
  return STOCK_HOLDING_ORDER_STATUSES.has(status);
}

/** Statuses an order may still be edited in: once stock has moved, lines are history. */
export const EDITABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['draft']);

/** What an order line sells. A service never touches stock (PRD section 6.4). */
export const ORDER_LINE_TYPES = ['item', 'service'] as const;
export type OrderLineType = (typeof ORDER_LINE_TYPES)[number];

/**
 * How a discount is expressed.
 *
 * Both kinds are stored as the resolved amount in minor units as well, so a total is
 * never recomputed from a percentage at read time and cannot drift by a rounding step.
 */
export const DISCOUNT_TYPES = ['none', 'amount', 'percent'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** Where an installment stands. Overdue is derived from the due date, never stored. */
export const INSTALLMENT_STATUSES = ['pending', 'partially_paid', 'paid'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

/**
 * The statuses that still owe money.
 *
 * Named here because a query for "orders with an unpaid instalment" has to be written as
 * `$in` over these rather than `$ne: 'paid'`. Against an array field, `$ne` matches only
 * documents where *no* element equals the value — so `$ne: 'paid'` silently drops every
 * order that has had one instalment settled, which is most of the ones worth chasing.
 */
export const UNPAID_INSTALLMENT_STATUSES: readonly InstallmentStatus[] = [
  'pending',
  'partially_paid',
];

/** The most installments one plan may hold, so a plan stays readable and bounded. */
export const MAX_INSTALLMENTS = 36;

/** How many lines one order may hold. */
export const MAX_ORDER_LINES = 200;
