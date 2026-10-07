import mongoose, { type ClientSession } from 'mongoose';
import { logger } from '../utils/logger';

let supportsTransactions: boolean | null = null;

/**
 * MongoDB transactions require a replica set. A standalone `mongod` — common on a
 * developer laptop — cannot run them, so this is detected once and cached.
 */
export async function detectTransactionSupport(): Promise<boolean> {
  if (supportsTransactions !== null) return supportsTransactions;

  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) {
      supportsTransactions = false;
      return false;
    }

    const info = (await admin.command({ hello: 1 })) as { setName?: string; msg?: string };
    // A replica set reports setName; a sharded cluster reports msg: 'isdbgrid'.
    supportsTransactions = Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch (error) {
    logger.warn('Could not determine transaction support', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    supportsTransactions = false;
  }

  if (!supportsTransactions) {
    logger.warn('Database does not support transactions', {
      impact:
        'Stock and payment writes will run without a transaction. Use a replica set in any shared or production environment.',
    });
  }

  return supportsTransactions;
}

/** Test seam, and a way to reset the cache after reconnecting. */
export function resetTransactionSupport(): void {
  supportsTransactions = null;
}

/**
 * Runs `work` inside a transaction when the deployment supports one.
 *
 * Stock movements must be written together with the balance they produce, otherwise a
 * crash between the two leaves a quantity that the ledger cannot explain. Where
 * transactions are unavailable the work still runs, and the caller is responsible for
 * ordering its writes so a partial failure is detectable.
 */
export async function withTransaction<T>(
  work: (session: ClientSession | undefined) => Promise<T>,
): Promise<T> {
  const available = await detectTransactionSupport();
  if (!available) return work(undefined);

  const session = await mongoose.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    // withTransaction resolves only after the body succeeded, so result is assigned.
    return result!;
  } finally {
    await session.endSession();
  }
}
