import type { ClientSession, Types } from 'mongoose';
import { Order } from '../../models/Order';
import { Purchase } from '../../models/Purchase';
import { StockMovement } from '../../models/StockMovement';
import { AppError, ErrorCode } from '../../utils/AppError';

/** The three catalog records a merchant can delete. */
export type CatalogRecordType = 'item' | 'service' | 'material';

const LABELS: Record<CatalogRecordType, string> = {
  item: 'item',
  service: 'service',
  material: 'raw material',
};

export interface CatalogReferenceCounts {
  orders: number;
  purchases: number;
}

/**
 * Counts the orders and purchases whose lines point at a catalog record.
 *
 * Only the combinations the data model allows are queried: an order sells items and
 * services, a purchase receives items and raw materials. Nothing buys a service, and
 * nothing sells a raw material, so those pairings are reported as zero without a trip
 * to the database.
 */
export async function countCatalogReferences(
  merchantId: Types.ObjectId,
  recordType: CatalogRecordType,
  recordId: Types.ObjectId,
): Promise<CatalogReferenceCounts> {
  const [orders, purchases] = await Promise.all([
    recordType === 'material'
      ? Promise.resolve(0)
      : Order.countDocuments({
          merchantId,
          lines: { $elemMatch: { lineType: recordType, subjectId: recordId } },
        }),
    recordType === 'service'
      ? Promise.resolve(0)
      : Purchase.countDocuments({
          merchantId,
          lines: { $elemMatch: { subjectType: recordType, subjectId: recordId } },
        }),
  ]);

  return { orders, purchases };
}

/**
 * Refuses to delete a catalog record that an order or purchase still points at.
 *
 * An order line keeps its own `name` and rate, so deleting the record would not corrupt
 * what a customer was charged. What it would break is the link back: the indexes on
 * `lines.subjectId` exist so a merchant can ask "what did I sell of this?", and the
 * stock ledger for the record would be destroyed along with it. Archiving keeps both
 * and is what the caller is pointed at, which is why the counts travel in `meta` —
 * the app and admin panel use them to say how much history is at stake.
 */
export async function assertCatalogRecordDeletable(
  merchantId: Types.ObjectId,
  recordType: CatalogRecordType,
  recordId: Types.ObjectId,
): Promise<void> {
  const counts = await countCatalogReferences(merchantId, recordType, recordId);
  const total = counts.orders + counts.purchases;
  if (total === 0) return;

  const parts: string[] = [];
  if (counts.orders > 0) parts.push(`${counts.orders} order${counts.orders === 1 ? '' : 's'}`);
  if (counts.purchases > 0) {
    parts.push(`${counts.purchases} purchase${counts.purchases === 1 ? '' : 's'}`);
  }

  throw AppError.conflict(
    `This ${LABELS[recordType]} is used by ${parts.join(' and ')} and cannot be deleted. Archive it instead to hide it without losing that history.`,
    { code: ErrorCode.RECORD_IN_USE, meta: { orders: counts.orders, purchases: counts.purchases } },
  );
}

/** Session-aware delete of the stock ledger belonging to a record that is going away. */
export async function deleteStockLedgerFor(
  merchantId: Types.ObjectId,
  subjectType: 'item' | 'material',
  subjectId: Types.ObjectId,
  session: ClientSession | undefined,
): Promise<number> {
  const result = await StockMovement.deleteMany(
    { merchantId, subjectType, subjectId },
    session ? { session } : {},
  );
  return result.deletedCount ?? 0;
}
