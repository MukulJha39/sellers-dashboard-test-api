import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

mongoose.set('strictQuery', true);

let connecting: Promise<typeof mongoose> | null = null;

export async function connectDatabase(uri: string = env.mongoUri, attempts = 5): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (connecting) return connecting;

  connecting = (async () => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await mongoose.connect(uri, {
          serverSelectionTimeoutMS: 10_000,
          maxPoolSize: 20,
          autoIndex: !env.isProduction,
        });
        logger.info('Database connected', { attempt });
        return mongoose;
      } catch (error) {
        lastError = error;
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
        logger.warn('Database connection failed, retrying', {
          attempt,
          attempts,
          backoffMs,
          reason: error instanceof Error ? error.message : 'unknown',
        });
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    connecting = null;
    throw lastError instanceof Error ? lastError : new Error('Unable to connect to the database');
  })();

  return connecting;
}

export async function disconnectDatabase(): Promise<void> {
  connecting = null;
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    logger.info('Database disconnected');
  }
}

/**
 * Builds every declared index. Called explicitly at boot so a cold production start
 * does not silently run without the indexes the list endpoints depend on.
 */
export async function syncIndexes(): Promise<void> {
  const modelNames = mongoose.modelNames();
  await Promise.all(modelNames.map((name) => mongoose.model(name).syncIndexes()));
  logger.info('Indexes synchronised', { models: modelNames.length });
}

export function databaseState(): 'disconnected' | 'connected' | 'connecting' | 'disconnecting' | 'unknown' {
  switch (mongoose.connection.readyState) {
    case 0:
      return 'disconnected';
    case 1:
      return 'connected';
    case 2:
      return 'connecting';
    case 3:
      return 'disconnecting';
    default:
      return 'unknown';
  }
}
