import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { config } from './config.js';
import { createContainer, type ContainerOverrides } from './container.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { metricsMiddleware, registry } from './telemetry/metrics.js';
import { healthCheck } from './db/pool.js';
import { cacheHealth, isCacheEnabled } from './cache/redis.js';
import { areMigrationsApplied } from './lib/readiness.js';
import { forbidden } from './lib/errors.js';
import { authRoutes } from './modules/auth/authRoutes.js';
import { doctorRoutes } from './modules/doctors/doctorRoutes.js';
import { bookingRoutes } from './modules/booking/bookingRoutes.js';
import { consultationRoutes } from './modules/consultations/consultationRoutes.js';
import { prescriptionRoutes } from './modules/prescriptions/prescriptionRoutes.js';
import { paymentRoutes } from './modules/payments/paymentRoutes.js';
import { adminRoutes } from './modules/admin/adminRoutes.js';

export function createApp(overrides: ContainerOverrides = {}): Express {
  const container = createContainer(overrides);
  const app = express();

  // Behind a load balancer, req.ip must come from X-Forwarded-For or every
  // client shares the proxy's address and per-IP rate limiting collapses.
  // `1` — trust exactly one hop — rather than `true`, which lets a client
  // spoof the header and choose its own rate-limit bucket.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // An API serves JSON to programmatic clients; the browser-oriented
      // policies are set to their strictest useful values rather than
      // defaults tuned for HTML.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );

  app.use(
    cors({
      // Allow-list, never a reflected origin. Credentials are on, and
      // `origin: true` with credentials is the classic account-takeover CORS
      // misconfiguration.
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        // An AppError, not a bare Error. A bare Error reaches the handler as
        // an unrecognised failure and becomes a 500, which is both wrong (the
        // client's origin is a client problem) and actively harmful: rejected
        // origins would count against the 5xx error budget and page someone.
        callback(forbidden('Origin not allowed by CORS'));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit-Remaining', 'Idempotency-Replayed'],
      maxAge: 600,
    }),
  );

  // 100kb: large enough for a prescription with thirty medicines, small enough
  // that a body-size attack is not free.
  app.use(express.json({ limit: '100kb' }));
  app.use(requestContext);
  app.use(metricsMiddleware);

  // ---- operational endpoints, unauthenticated and unmetered -------------

  /** Liveness: is the process up? Never touches a dependency. */
  app.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  /**
   * Readiness: should this instance receive traffic?
   *
   * Postgres down means not ready. Redis down does not — the service degrades
   * to uncached reads and still serves correctly, and pulling every instance
   * out of the load balancer over a cache outage would turn a degradation
   * into an outage.
   */
  app.get('/health/ready', async (_req, res) => {
    const [db, cache] = await Promise.all([healthCheck(), cacheHealth()]);
    const migrated = areMigrationsApplied();
    const ready = db && migrated;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        database: db ? 'up' : 'down',
        migrations: migrated ? 'applied' : 'pending',
        cache: isCacheEnabled() ? (cache ? 'up' : 'down') : 'disabled',
      },
    });
  });

  app.get('/metrics', async (_req, res) => {
    // In production this is reachable only from the metrics network, not the
    // public ingress — see docs/threat-model.md.
    res.set('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });

  // ---- API ---------------------------------------------------------------

  const v1 = express.Router();
  v1.use('/auth', authRoutes(container.authService));
  v1.use('/doctors', doctorRoutes());
  v1.use('/bookings', bookingRoutes());
  v1.use('/consultations', consultationRoutes());
  v1.use('/prescriptions', prescriptionRoutes());
  v1.use('/payments', paymentRoutes(container.paymentService));
  v1.use('/admin', adminRoutes());

  app.use('/api/v1', v1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
