/**
 * Granular permission catalogue (PRD section 26).
 *
 * Phase 1 only enforces the merchant, admin, role and audit permissions, but the whole
 * catalogue is seeded now so later phases add endpoints rather than redesigning RBAC.
 * Every label speaks of "merchants", never "users".
 */
export const PERMISSIONS = {
  MERCHANT_VIEW: 'merchant.view',
  MERCHANT_CREATE: 'merchant.create',
  MERCHANT_EDIT: 'merchant.edit',
  MERCHANT_SUSPEND: 'merchant.suspend',

  BUSINESS_VIEW: 'business.view',
  BUSINESS_EDIT: 'business.edit',

  CUSTOMER_VIEW: 'customer.view',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_EDIT: 'customer.edit',
  CUSTOMER_ARCHIVE: 'customer.archive',

  SUPPLIER_VIEW: 'supplier.view',
  SUPPLIER_MANAGE: 'supplier.manage',

  ITEM_VIEW: 'item.view',
  ITEM_MANAGE: 'item.manage',
  SERVICE_VIEW: 'service.view',
  SERVICE_MANAGE: 'service.manage',
  MATERIAL_VIEW: 'material.view',
  MATERIAL_MANAGE: 'material.manage',
  STOCK_VIEW: 'stock.view',
  STOCK_ADJUST: 'stock.adjust',

  PURCHASE_VIEW: 'purchase.view',
  PURCHASE_MANAGE: 'purchase.manage',

  ORDER_VIEW: 'order.view',
  ORDER_CREATE: 'order.create',
  ORDER_EDIT: 'order.edit',
  ORDER_CANCEL: 'order.cancel',

  PAYMENT_VIEW: 'payment.view',
  PAYMENT_MANAGE: 'payment.manage',
  INSTALLMENT_VIEW: 'installment.view',
  INSTALLMENT_MANAGE: 'installment.manage',

  REMINDER_VIEW: 'reminder.view',
  REMINDER_MANAGE: 'reminder.manage',

  REPORT_VIEW: 'report.view',
  REPORT_EXPORT: 'report.export',

  ADMIN_VIEW: 'admin.view',
  ADMIN_MANAGE: 'admin.manage',
  ROLE_VIEW: 'role.view',
  ROLE_MANAGE: 'role.manage',
  AUDIT_VIEW: 'audit.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS);

/** Human-readable grouping used by the admin panel's permission matrix. */
export const PERMISSION_GROUPS: ReadonlyArray<{ group: string; permissions: Permission[] }> = [
  { group: 'Merchants', permissions: [PERMISSIONS.MERCHANT_VIEW, PERMISSIONS.MERCHANT_CREATE, PERMISSIONS.MERCHANT_EDIT, PERMISSIONS.MERCHANT_SUSPEND] },
  { group: 'Businesses', permissions: [PERMISSIONS.BUSINESS_VIEW, PERMISSIONS.BUSINESS_EDIT] },
  { group: 'Customers', permissions: [PERMISSIONS.CUSTOMER_VIEW, PERMISSIONS.CUSTOMER_CREATE, PERMISSIONS.CUSTOMER_EDIT, PERMISSIONS.CUSTOMER_ARCHIVE] },
  { group: 'Suppliers', permissions: [PERMISSIONS.SUPPLIER_VIEW, PERMISSIONS.SUPPLIER_MANAGE] },
  { group: 'Catalog & stock', permissions: [PERMISSIONS.ITEM_VIEW, PERMISSIONS.ITEM_MANAGE, PERMISSIONS.SERVICE_VIEW, PERMISSIONS.SERVICE_MANAGE, PERMISSIONS.MATERIAL_VIEW, PERMISSIONS.MATERIAL_MANAGE, PERMISSIONS.STOCK_VIEW, PERMISSIONS.STOCK_ADJUST] },
  { group: 'Purchases', permissions: [PERMISSIONS.PURCHASE_VIEW, PERMISSIONS.PURCHASE_MANAGE] },
  { group: 'Orders', permissions: [PERMISSIONS.ORDER_VIEW, PERMISSIONS.ORDER_CREATE, PERMISSIONS.ORDER_EDIT, PERMISSIONS.ORDER_CANCEL] },
  { group: 'Payments', permissions: [PERMISSIONS.PAYMENT_VIEW, PERMISSIONS.PAYMENT_MANAGE, PERMISSIONS.INSTALLMENT_VIEW, PERMISSIONS.INSTALLMENT_MANAGE] },
  { group: 'Reminders', permissions: [PERMISSIONS.REMINDER_VIEW, PERMISSIONS.REMINDER_MANAGE] },
  { group: 'Reports', permissions: [PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_EXPORT] },
  { group: 'Administration', permissions: [PERMISSIONS.ADMIN_VIEW, PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_VIEW, PERMISSIONS.ROLE_MANAGE, PERMISSIONS.AUDIT_VIEW] },
];

const VIEW_ONLY_PERMISSIONS: Permission[] = ALL_PERMISSIONS.filter((permission) => permission.endsWith('.view'));

/**
 * Administrative surfaces: the admin team itself, the role matrix and the audit trail.
 * The audit trail records what other admins did, so it is an administrative view rather
 * than an operational one and is not handed out with general read access.
 */
const ADMINISTRATIVE_VIEWS: Permission[] = [PERMISSIONS.ADMIN_VIEW, PERMISSIONS.ROLE_VIEW, PERMISSIONS.AUDIT_VIEW];

/** Everything an operational role may read: all view permissions except the administrative ones. */
const OPERATIONAL_VIEWS: Permission[] = VIEW_ONLY_PERMISSIONS.filter(
  (permission) => !ADMINISTRATIVE_VIEWS.includes(permission),
);

export interface RoleSeed {
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
}

/**
 * Seeded roles demonstrate the permission model end to end (PRD section 26).
 * Each one is deliberately different in what it can reach.
 */
export const ROLE_SEEDS: readonly RoleSeed[] = [
  {
    slug: 'super_admin',
    name: 'Super administrator',
    description: 'Full access to every operational and administrative capability.',
    permissions: [...ALL_PERMISSIONS],
  },
  {
    slug: 'operations_admin',
    name: 'Operations administrator',
    description: 'Runs day-to-day operations across merchants, catalog, orders and reminders, without administering the admin team.',
    permissions: ALL_PERMISSIONS.filter(
      (permission) =>
        !([PERMISSIONS.ADMIN_MANAGE, PERMISSIONS.ROLE_MANAGE, PERMISSIONS.MERCHANT_CREATE] as Permission[]).includes(permission),
    ),
  },
  {
    slug: 'support_admin',
    name: 'Support / merchant operations',
    description: 'Helps merchants: can read operational records, edit customer details and manage reminders.',
    permissions: [
      ...OPERATIONAL_VIEWS,
      PERMISSIONS.MERCHANT_EDIT,
      PERMISSIONS.CUSTOMER_CREATE,
      PERMISSIONS.CUSTOMER_EDIT,
      PERMISSIONS.REMINDER_MANAGE,
    ],
  },
  {
    slug: 'finance_admin',
    name: 'Finance / payment operations',
    description: 'Owns payments, installments and financial reporting. Cannot change merchant identity or the catalog.',
    permissions: [
      PERMISSIONS.MERCHANT_VIEW,
      PERMISSIONS.BUSINESS_VIEW,
      PERMISSIONS.CUSTOMER_VIEW,
      PERMISSIONS.SUPPLIER_VIEW,
      PERMISSIONS.ORDER_VIEW,
      PERMISSIONS.PURCHASE_VIEW,
      PERMISSIONS.PAYMENT_VIEW,
      PERMISSIONS.PAYMENT_MANAGE,
      PERMISSIONS.INSTALLMENT_VIEW,
      PERMISSIONS.INSTALLMENT_MANAGE,
      PERMISSIONS.REPORT_VIEW,
      PERMISSIONS.REPORT_EXPORT,
      PERMISSIONS.AUDIT_VIEW,
    ],
  },
  {
    slug: 'readonly_admin',
    name: 'Read-only',
    description: 'Can inspect operational data but cannot change anything, and cannot reach administrative surfaces.',
    permissions: [...OPERATIONAL_VIEWS],
  },
];
