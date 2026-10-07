import type { BusinessDocument } from '../../models/Business';
import { PAYMENT_METHODS } from '../../config/commerce';
import type { CategoryDocument } from '../../models/Category';
import type { ItemDocument } from '../../models/Item';
import type { RawMaterialDocument } from '../../models/RawMaterial';
import type { ServiceOfferingDocument } from '../../models/ServiceOffering';
import type { StockMovementDocument } from '../../models/StockMovement';
import { fromThousandths } from '../../utils/quantity';

/** Category names keyed by id, so a list can label rows without N extra queries. */
export type CategoryNames = Map<string, string>;

function categoryName(
  categoryId: unknown,
  names: CategoryNames | undefined,
): string | null {
  if (!categoryId) return null;
  return names?.get(String(categoryId)) ?? null;
}

export interface StockView {
  unit: string;
  trackStock: boolean;
  /** Current available quantity. */
  quantity: number;
  /** Everything ever received, which is not the same as what is available now. */
  totalReceived: number;
  lowStockThreshold: number;
  isLowStock: boolean;
  isOutOfStock: boolean;
}

function presentStock(source: {
  unit: string;
  trackStock: boolean;
  quantityThousandths: number;
  totalReceivedThousandths: number;
  lowStockThresholdThousandths: number;
  isLowStock: boolean;
}): StockView {
  return {
    unit: source.unit,
    trackStock: source.trackStock,
    quantity: fromThousandths(source.quantityThousandths),
    totalReceived: fromThousandths(source.totalReceivedThousandths),
    lowStockThreshold: fromThousandths(source.lowStockThresholdThousandths),
    isLowStock: source.isLowStock,
    isOutOfStock: source.trackStock && source.quantityThousandths <= 0,
  };
}

export function presentItem(item: ItemDocument, names?: CategoryNames) {
  return {
    id: String(item._id),
    merchantId: String(item.merchantId),
    name: item.name,
    categoryId: item.categoryId ? String(item.categoryId) : null,
    categoryName: categoryName(item.categoryId, names),
    description: item.description ?? null,
    imageUrl: item.imageUrl ?? null,
    sku: item.sku ?? null,
    barcode: item.barcode ?? null,
    ...presentStock(item),
    sellingPriceMinor: item.sellingPriceMinor,
    costPriceMinor: item.costPriceMinor ?? null,
    taxRatePercent: item.taxRatePercent ?? null,
    archived: item.archived,
    archivedAt: item.archivedAt ? item.archivedAt.toISOString() : null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}

export function presentRawMaterial(material: RawMaterialDocument, names?: CategoryNames) {
  return {
    id: String(material._id),
    merchantId: String(material.merchantId),
    name: material.name,
    categoryId: material.categoryId ? String(material.categoryId) : null,
    categoryName: categoryName(material.categoryId, names),
    notes: material.notes ?? null,
    imageUrl: material.imageUrl ?? null,
    ...presentStock(material),
    purchaseCostMinor: material.purchaseCostMinor ?? null,
    batchReference: material.batchReference ?? null,
    expiryDate: material.expiryDate ? material.expiryDate.toISOString() : null,
    supplierName: material.supplierName ?? null,
    archived: material.archived,
    archivedAt: material.archivedAt ? material.archivedAt.toISOString() : null,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  };
}

export function presentService(service: ServiceOfferingDocument, names?: CategoryNames) {
  return {
    id: String(service._id),
    merchantId: String(service.merchantId),
    name: service.name,
    categoryId: service.categoryId ? String(service.categoryId) : null,
    categoryName: categoryName(service.categoryId, names),
    description: service.description ?? null,
    imageUrl: service.imageUrl ?? null,
    billingUnit: service.billingUnit,
    rateMinor: service.rateMinor,
    durationMinutes: service.durationMinutes ?? null,
    taxRatePercent: service.taxRatePercent ?? null,
    isActive: service.isActive,
    /** Stated in the contract: a service can never affect physical stock. */
    affectsStock: false as const,
    archived: service.archived,
    archivedAt: service.archivedAt ? service.archivedAt.toISOString() : null,
    createdAt: service.createdAt.toISOString(),
    updatedAt: service.updatedAt.toISOString(),
  };
}

export function presentCategory(category: CategoryDocument, usageCount?: number) {
  return {
    id: String(category._id),
    kind: category.kind,
    name: category.name,
    archived: category.archived,
    archivedAt: category.archivedAt ? category.archivedAt.toISOString() : null,
    ...(usageCount === undefined ? {} : { usageCount }),
    createdAt: category.createdAt.toISOString(),
    updatedAt: category.updatedAt.toISOString(),
  };
}

export function presentStockMovement(movement: StockMovementDocument) {
  return {
    id: String(movement._id),
    subjectType: movement.subjectType,
    subjectId: String(movement.subjectId),
    subjectName: movement.subjectName,
    type: movement.type,
    reason: movement.reason ?? null,
    delta: fromThousandths(movement.deltaThousandths),
    balanceAfter: fromThousandths(movement.balanceAfterThousandths),
    note: movement.note ?? null,
    actorType: movement.actorType,
    actorLabel: movement.actorLabel,
    referenceType: movement.referenceType ?? null,
    referenceId: movement.referenceId ? String(movement.referenceId) : null,
    createdAt: movement.createdAt.toISOString(),
  };
}

/** Fields that count towards a complete business profile, in the order we prompt for them. */
const BUSINESS_COMPLETION_FIELDS: ReadonlyArray<keyof BusinessDocument> = [
  'name',
  'category',
  'city',
  'contactPhone',
  'logoUrl',
];

export function presentBusiness(business: BusinessDocument) {
  const missing = BUSINESS_COMPLETION_FIELDS.filter((field) => {
    const value = business[field];
    return value === null || value === undefined || value === '';
  }).map(String);

  return {
    id: String(business._id),
    merchantId: String(business.merchantId),
    name: business.name ?? null,
    logoUrl: business.logoUrl ?? null,
    category: business.category ?? null,
    taxNumber: business.taxNumber ?? null,
    address: {
      line1: business.addressLine1 ?? null,
      line2: business.addressLine2 ?? null,
      city: business.city ?? null,
      state: business.state ?? null,
      postalCode: business.postalCode ?? null,
      country: business.country ?? null,
    },
    contact: {
      email: business.contactEmail ?? null,
      countryCode: business.contactCountryCode ?? null,
      phone: business.contactPhone ?? null,
      website: business.website ?? null,
    },
    currency: business.currency,
    invoice: {
      showLogo: business.invoiceShowLogo,
      showAddress: business.invoiceShowAddress,
      showTaxNumber: business.invoiceShowTaxNumber,
      footerNote: business.invoiceFooterNote ?? null,
    },
    defaultPaymentTermsDays: business.defaultPaymentTermsDays ?? null,
    lowStockAlertsEnabled: business.lowStockAlertsEnabled,
    /**
     * The merchant's own order and payment preferences.
     *
     * `paymentMethods` is always the resolved list rather than what is stored: an empty
     * stored list means "all of them", and a client should not have to know that.
     */
    preferences: {
      paymentMethods: business.enabledPaymentMethods.length > 0
          ? business.enabledPaymentMethods
          : [...PAYMENT_METHODS],
      defaultOrderStatus: business.defaultOrderStatus,
      defaultTaxPercent: business.defaultTaxPercent ?? null,
    },
    status: business.status,
    /**
     * Drives the app's gentle completion prompts. Setup is never blocking, so this is
     * guidance rather than a gate (PRD section 5).
     */
    completion: {
      total: BUSINESS_COMPLETION_FIELDS.length,
      completed: BUSINESS_COMPLETION_FIELDS.length - missing.length,
      percent: Math.round(
        ((BUSINESS_COMPLETION_FIELDS.length - missing.length) / BUSINESS_COMPLETION_FIELDS.length) * 100,
      ),
      missing,
    },
    createdAt: business.createdAt.toISOString(),
    updatedAt: business.updatedAt.toISOString(),
  };
}
