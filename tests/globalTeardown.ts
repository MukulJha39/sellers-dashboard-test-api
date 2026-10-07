import fs from 'fs/promises';
import path from 'path';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const server = (globalThis as Record<string, unknown>).__MONGO_SERVER__ as MongoMemoryReplSet | undefined;
  if (server) await server.stop();

  // Remove anything the upload tests wrote.
  await fs.rm(path.resolve(process.cwd(), 'uploads-test'), { recursive: true, force: true });
}
