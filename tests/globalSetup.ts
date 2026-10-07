import { MongoMemoryReplSet } from 'mongodb-memory-server';

/**
 * One in-memory MongoDB for the whole run, started as a single-member replica set.
 *
 * A replica set rather than a standalone because MongoDB only offers transactions on
 * one, and the stock ledger depends on writing a movement and the balance it produces
 * together. Testing against a standalone would exercise a code path the product does
 * not use in any real deployment.
 */
export default async function globalSetup(): Promise<void> {
  const server = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
  });

  (globalThis as Record<string, unknown>).__MONGO_SERVER__ = server;
  process.env.MONGODB_URI = server.getUri('sellersdash_test');
}
