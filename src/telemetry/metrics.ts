import client from 'prom-client';
import type { Request, Response, NextFunction } from 'express';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'amrutam_' });

/**
 * RED metrics (Rate, Errors, Duration) on the HTTP surface, plus the handful of
 * domain counters that actually tell you whether the product is working.
 *
 * Buckets are chosen around the SLO, not logarithmically spread: the ones that
 * matter are the two either side of 200ms (read target) and 500ms (write
 * target), because that is where the alert threshold sits.
 */
export const httpRequestDuration = new client.Histogram({
  name: 'amrutam_http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 1, 2, 5],
  registers: [registry],
});

export const httpRequestsTotal = new client.Counter({
  name: 'amrutam_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const dbQueryDuration = new client.Histogram({
  name: 'amrutam_db_query_duration_seconds',
  help: 'Postgres query latency in seconds',
  labelNames: ['operation'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2],
  registers: [registry],
});

export const cacheOps = new client.Counter({
  name: 'amrutam_cache_operations_total',
  help: 'Cache hits, misses and failures',
  labelNames: ['result'] as const,
  registers: [registry],
});

/**
 * The booking counter is the one to alert on. A rising `slot_taken` rate is
 * normal contention; a rising `error` rate is not.
 */
export const bookingAttempts = new client.Counter({
  name: 'amrutam_booking_attempts_total',
  help: 'Booking attempts by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const idempotentReplays = new client.Counter({
  name: 'amrutam_idempotent_replays_total',
  help: 'Requests served from a stored idempotent response',
  labelNames: ['endpoint'] as const,
  registers: [registry],
});

export const authEvents = new client.Counter({
  name: 'amrutam_auth_events_total',
  help: 'Authentication events by type and outcome',
  labelNames: ['event', 'outcome'] as const,
  registers: [registry],
});

export const outboxLag = new client.Gauge({
  name: 'amrutam_outbox_pending',
  help: 'Domain events waiting to be relayed',
  registers: [registry],
});

export const slotHoldsActive = new client.Gauge({
  name: 'amrutam_slot_holds_active',
  help: 'Slots currently held pending payment',
  registers: [registry],
});

/**
 * Records latency against the matched Express route (`/api/v1/doctors/:id`),
 * never the raw URL — per-id labels would blow up Prometheus cardinality.
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path
      ? `${req.baseUrl ?? ''}${req.route.path}`
      : (req.baseUrl || 'unmatched');
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    httpRequestsTotal.inc(labels);
  });
  next();
}
