/**
 * Vocabulary for the relationship and money side of the product: customers,
 * suppliers, purchases and payments (PRD sections 7, 9 and 11).
 *
 * Served to the clients through `/catalog/meta` for the same reason the catalog
 * vocabulary is: a list that exists in three places drifts in three directions.
 */

/**
 * Payment methods. The PRD asks for this list to stay configurable, so it lives here
 * rather than being spelled into a schema in several places; a merchant-specific list
 * layers on top in Phase 4 without changing the stored values.
 */
export const PAYMENT_METHODS = ['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * How much of a payable has been settled.
 *
 * Deliberately only three values. "Overdue" is not stored: it is true when a payable
 * is not fully paid and its due date has passed, which changes with the clock rather
 * than with a write. Storing it would need a nightly job to flip rows, and a row the
 * job had not reached yet would be lying. Clients receive `paymentState`, which folds
 * the stored status together with the due date — see `derivePaymentState`.
 */
export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'fully_paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** What a client displays: the stored status, plus the time-derived overdue case. */
export const PAYMENT_STATES = [...PAYMENT_STATUSES, 'overdue'] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * What a payment is recorded against.
 *
 * `order` is registered in Phase 4; the engine is written against this union now so
 * orders become a second consumer rather than a second engine.
 */
export const PAYABLE_TYPES = ['purchase', 'order'] as const;
export type PayableType = (typeof PAYABLE_TYPES)[number];

/**
 * Which way the money moved. A purchase payment leaves the business, an order payment
 * arrives, and the sign is never carried on the amount itself — amounts stay positive
 * so a total can never be made to disagree with the sum of its entries.
 */
export const PAYMENT_DIRECTIONS = ['in', 'out'] as const;
export type PaymentDirection = (typeof PAYMENT_DIRECTIONS)[number];

export const PURCHASE_STATUSES = ['recorded', 'cancelled'] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** How a customer prefers to hear from the business (PRD section 10). */
export const CONTACT_CHANNELS = ['sms', 'whatsapp', 'both', 'none'] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** Languages a customer-facing message can be written in (PRD section 16). */
export const CONTACT_LANGUAGES = ['en', 'hi'] as const;
export type ContactLanguage = (typeof CONTACT_LANGUAGES)[number];

/** Sequence prefixes for human-readable references. */
export const REFERENCE_PREFIXES = {
  purchase: 'PUR',
  order: 'ORD',
  payment: 'PAY',
} as const;

/** How many days before a due date counts as "due soon" on a dashboard. */
export const DUE_SOON_DAYS = 7;
