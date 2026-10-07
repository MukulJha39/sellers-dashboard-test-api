import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/error';
import { globalLimiter } from './middleware/rateLimit';
import { requestContext } from './middleware/requestContext';
import { adminRouter } from './modules/admin/adminRoutes';
import { businessRouter } from './modules/business/businessRoutes';
import { catalogRouter } from './modules/catalog/catalogRoutes';
import { orderRouter } from './modules/orders/orderRoutes';
import { relationshipRouter } from './modules/relationships/relationshipRoutes';
import { authRouter } from './modules/auth/authRoutes';
import { healthRouter } from './modules/health/healthRoutes';
import { merchantRouter } from './modules/merchant/merchantRoutes';
import { AppError } from './utils/AppError';

export function createApp(): Express {
  const app = express();

  // Behind a load balancer the client IP arrives in a forwarded header; trusting it in
  // development would let a local caller spoof rate-limit keys.
  if (env.isProduction) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // This is a JSON API that also serves merchant media to the app and admin panel.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // Native app traffic and server-to-server calls arrive without an Origin header.
        if (!origin || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(AppError.forbidden('This origin is not allowed to call the API.'));
      },
      credentials: true,
      exposedHeaders: ['x-request-id'],
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(requestContext);
  app.use(globalLimiter);

  app.use(
    '/uploads',
    express.static(env.upload.dir, {
      index: false,
      dotfiles: 'deny',
      maxAge: '7d',
      setHeaders: (res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // Stored media is only ever displayed, never executed in a document context.
        res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      },
    }),
  );

  app.use(healthRouter);
  app.use(`${env.apiPrefix}/auth`, authRouter);
  app.use(`${env.apiPrefix}/merchants`, merchantRouter);
  app.use(`${env.apiPrefix}/business`, businessRouter);
  // Items, services, materials, categories and the stock ledger share one router.
  app.use(env.apiPrefix, catalogRouter);
  // Customers, suppliers, purchases and payments share another.
  app.use(env.apiPrefix, relationshipRouter);
  // Orders, instalments, receivables and the dashboard share a third.
  app.use(env.apiPrefix, orderRouter);
  app.use(`${env.apiPrefix}/admin`, adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
