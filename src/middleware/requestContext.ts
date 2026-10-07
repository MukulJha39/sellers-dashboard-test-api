import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Attaches a request id used in logs, audit entries and error responses so a merchant
 * or admin report can be traced without exposing internals to the client.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  res.setHeader('x-request-id', req.requestId);

  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const meta = {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(durationMs),
    };
    if (res.statusCode >= 500) logger.error('Request failed', meta);
    else if (res.statusCode >= 400) logger.warn('Request rejected', meta);
    else logger.debug('Request completed', meta);
  });

  next();
}
