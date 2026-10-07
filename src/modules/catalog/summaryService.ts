import type { Types } from 'mongoose';
import { Category } from '../../models/Category';
import { Item, type ItemDocument } from '../../models/Item';
import { RawMaterial, type RawMaterialDocument } from '../../models/RawMaterial';
import { ServiceOffering } from '../../models/ServiceOffering';
import { fromThousandths } from '../../utils/quantity';

export interface CatalogSummary {
  items: { active: number; archived: number; lowStock: number; outOfStock: number };
  services: { active: number; inactive: number; archived: number };
  materials: { active: number; archived: number; lowStock: number; expiringSoon: number };
  categories: number;
}

const EXPIRING_SOON_DAYS = 30;

/**
 * Counts for the app's home screen and the admin merchant overview.
 *
 * Counted rather than estimated, and every count is backed by an index, so this stays
 * cheap as a catalog grows (PRD section 30).
 */
export async function catalogSummary(merchantId: Types.ObjectId): Promise<CatalogSummary> {
  const expiringCutoff = new Date(Date.now() + EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000);

  const [
    activeItems,
    archivedItems,
    lowStockItems,
    outOfStockItems,
    activeServices,
    inactiveServices,
    archivedServices,
    activeMaterials,
    archivedMaterials,
    lowStockMaterials,
    expiringMaterials,
    categories,
  ] = await Promise.all([
    Item.countDocuments({ merchantId, archived: false }),
    Item.countDocuments({ merchantId, archived: true }),
    Item.countDocuments({ merchantId, archived: false, isLowStock: true }),
    Item.countDocuments({ merchantId, archived: false, trackStock: true, quantityThousandths: { $lte: 0 } }),
    ServiceOffering.countDocuments({ merchantId, archived: false, isActive: true }),
    ServiceOffering.countDocuments({ merchantId, archived: false, isActive: false }),
    ServiceOffering.countDocuments({ merchantId, archived: true }),
    RawMaterial.countDocuments({ merchantId, archived: false }),
    RawMaterial.countDocuments({ merchantId, archived: true }),
    RawMaterial.countDocuments({ merchantId, archived: false, isLowStock: true }),
    RawMaterial.countDocuments({
      merchantId,
      archived: false,
      expiryDate: { $ne: null, $lte: expiringCutoff },
    }),
    Category.countDocuments({ merchantId, archived: false }),
  ]);

  return {
    items: {
      active: activeItems,
      archived: archivedItems,
      lowStock: lowStockItems,
      outOfStock: outOfStockItems,
    },
    services: { active: activeServices, inactive: inactiveServices, archived: archivedServices },
    materials: {
      active: activeMaterials,
      archived: archivedMaterials,
      lowStock: lowStockMaterials,
      expiringSoon: expiringMaterials,
    },
    categories,
  };
}

export interface LowStockRecord {
  id: string;
  type: 'item' | 'material';
  name: string;
  unit: string;
  quantity: number;
  lowStockThreshold: number;
  isOutOfStock: boolean;
}

function toLowStockRecord(
  record: ItemDocument | RawMaterialDocument,
  type: 'item' | 'material',
): LowStockRecord {
  return {
    id: String(record._id),
    type,
    name: record.name,
    unit: record.unit,
    quantity: fromThousandths(record.quantityThousandths),
    lowStockThreshold: fromThousandths(record.lowStockThresholdThousandths),
    isOutOfStock: record.quantityThousandths <= 0,
  };
}

/**
 * Items and materials that need attention, worst first.
 *
 * Returned as one list because a merchant thinks in terms of "what am I about to run
 * out of", not in terms of which collection something lives in.
 */
export async function lowStockRecords(
  merchantId: Types.ObjectId,
  limit = 20,
): Promise<LowStockRecord[]> {
  const [items, materials] = await Promise.all([
    Item.find({ merchantId, archived: false, isLowStock: true })
      .sort({ quantityThousandths: 1 })
      .limit(limit),
    RawMaterial.find({ merchantId, archived: false, isLowStock: true })
      .sort({ quantityThousandths: 1 })
      .limit(limit),
  ]);

  return [
    ...items.map((item) => toLowStockRecord(item, 'item')),
    ...materials.map((material) => toLowStockRecord(material, 'material')),
  ]
    .sort((a, b) => a.quantity - b.quantity)
    .slice(0, limit);
}
