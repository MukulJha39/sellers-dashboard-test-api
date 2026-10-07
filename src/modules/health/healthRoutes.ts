import { Router } from 'express';
import { databaseState } from '../../db/connect';
import { env } from '../../config/env';

export const healthRouter = Router();

/** Liveness: the process is up and serving. */
healthRouter.get('/health', (_req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      environment: env.nodeEnv,
      uptimeSeconds: Math.round(process.uptime()),
    },
  });
});

/** Readiness: the process can actually serve traffic that touches the database. */
healthRouter.get('/ready', (_req, res) => {
  const database = databaseState();
  const ready = database === 'connected';
  res.status(ready ? 200 : 503).json({
    success: ready,
    data: { status: ready ? 'ready' : 'not_ready', database },
  });
});
