import { config } from './config.js';
import { logger } from './lib/logger.js';
import { startTracing } from './telemetry/tracing.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { closeCache } from './cache/redis.js';
import { createApp } from './app.js';
import { startWorker, stopWorker } from './jobs/worker.js';
import { withRetry } from './lib/retry.js';
import { markMigrationsApplied } from './lib/readiness.js';

async function main(): Promise<void> {
  // Tracing first: the SDK patches modules as they load, so anything imported
  // before it starts is invisible to instrumentation.
  const stopTracing = await startTracing();

  const app = createApp();
  const server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'amrutam-telemedicine listening');
  });

  /**
   * Migrate after the server is listening, not before.
   *
   * A pod that cannot reach its database yet is alive but not ready. Blocking
   * the listen on migrations makes it fail its liveness probe instead, and the
   * orchestrator restarts a process whose only problem is that Postgres is
   * thirty seconds behind it in the rollout.
   *
   * Readiness stays false — and no traffic arrives — until this succeeds.
   */
  void withRetry(() => migrate(), {
    attempts: 10,
    baseMs: 500,
    maxMs: 15_000,
    onRetry: (err, attempt) =>
      logger.warn({ attempt, err: (err as Error).message }, 'migration attempt failed, retrying'),
  })
    .then(() => {
      markMigrationsApplied();
      startWorker();
      logger.info('service ready');
    })
    .catch((err) => {
      // Still not fatal: liveness holds, readiness stays false, and the
      // orchestrator routes around this instance while it keeps trying on the
      // next restart. Alerting fires on the readiness gauge.
      logger.fatal({ err }, 'could not apply migrations — instance will stay unready');
    });

  // Requests that take longer than this are already failing their SLO; the
  // timeouts stop a slow client from pinning a socket indefinitely.
  server.headersTimeout = 20_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000; // longer than a typical ALB's 60s idle

  /**
   * Graceful shutdown.
   *
   * On a rolling deploy the orchestrator sends SIGTERM and removes the
   * instance from the load balancer. Draining in-flight requests before
   * exiting is the difference between a deploy nobody notices and a burst of
   * 502s — which, repeated across deploys, is most of a 99.95% error budget.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    server.close(async () => {
      stopWorker();
      await Promise.allSettled([stopTracing(), closeCache(), closePool()]);
      logger.info('shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection leaves the process in an unknown state. Log it and
  // exit so the orchestrator replaces the instance, rather than serving
  // traffic from something that may be half-broken.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'unhandled rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
