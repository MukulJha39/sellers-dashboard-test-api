import type { Server } from 'http';
import { createApp } from './app';
import { assertProductionConfig, env } from './config/env';
import { connectDatabase, disconnectDatabase, syncIndexes } from './db/connect';
import { ensureUploadDir } from './services/storageService';
import { logger } from './utils/logger';

let server: Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down', { signal });

  const forceExit = setTimeout(() => {
    logger.error('Shutdown timed out; exiting immediately');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  try {
    // A listener that never bound (for example a port clash) has nothing to close.
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await disconnectDatabase();
    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (error) {
    logger.error('Shutdown failed', { reason: error instanceof Error ? error.message : 'unknown' });
    process.exit(1);
  }
}

async function start(): Promise<void> {
  assertProductionConfig();
  await ensureUploadDir();
  await connectDatabase();
  await syncIndexes();

  const app = createApp();
  server = app.listen(env.port, () => {
    logger.info('API listening', {
      port: env.port,
      environment: env.nodeEnv,
      apiPrefix: env.apiPrefix,
    });
  });

  server.on('error', (error: NodeJS.ErrnoException) => {
    const reason =
      error.code === 'EADDRINUSE'
        ? `Port ${env.port} is already in use. Set PORT to a free port.`
        : error.message;
    logger.error('Server could not start', { reason });
    void shutdown('listen_error', 1);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
  void shutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { reason: error.message, stack: error.stack });
  void shutdown('uncaughtException', 1);
});

start().catch((error) => {
  logger.error('Failed to start API', { reason: error instanceof Error ? error.message : 'unknown' });
  process.exit(1);
});
