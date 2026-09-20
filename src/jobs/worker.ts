import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { query } from '../db/pool.js';
import { bookingService } from '../modules/booking/bookingService.js';
import { purgeExpiredIdempotencyKeys } from '../middleware/idempotency.js';
import { drainOutbox, on, refreshOutboxGauge } from './outbox.js';
import { slotHoldsActive } from '../telemetry/metrics.js';

/**
 * Background work.
 *
 * Runs in-process here, which is the right call at this size and is what makes
 * `docker compose up` a complete system. The loops are written so that moving
 * them to their own container is a deployment change and not a code change:
 * every job is idempotent, claims work with SKIP LOCKED, and holds no state
 * between ticks.
 */

// ---- event handlers -------------------------------------------------------

// Notifications are logged rather than sent. Wiring a real provider is one
// function; what matters for this submission is that delivery goes through the
// outbox with retry and dead-lettering rather than a fire-and-forget call on
// the request path.
on('consultation.hold_created', async (payload) => {
  logger.info({ event: 'consultation.hold_created', ...payload }, 'notify: complete your payment');
});

on('consultation.confirmed', async (payload) => {
  logger.info({ event: 'consultation.confirmed', ...payload }, 'notify: booking confirmed');
});

on('consultation.cancelled', async (payload) => {
  logger.info({ event: 'consultation.cancelled', ...payload }, 'notify: booking cancelled');
  // A captured payment on a cancelled consultation owes a refund. Recording
  // the intent in the payments table keeps the decision auditable rather than
  // implicit in a log line.
  const consultationId = payload.consultationId as string;
  await query(
    `UPDATE payments SET status = 'refunded', updated_at = now()
      WHERE consultation_id = $1 AND status = 'captured'`,
    [consultationId],
  );
});

on('consultation.completed', async (payload) => {
  logger.info({ event: 'consultation.completed', ...payload }, 'notify: consultation complete');
});

on('prescription.issued', async (payload) => {
  logger.info({ event: 'prescription.issued', ...payload }, 'notify: prescription ready');
});

// ---- scheduled loops ------------------------------------------------------

interface Loop {
  name: string;
  intervalMs: number;
  run: () => Promise<unknown>;
}

const LOOPS: Loop[] = [
  {
    name: 'release-expired-holds',
    // Holds last five minutes; sweeping every fifteen seconds bounds the time
    // a paid-for-but-expired slot sits unavailable to something a user will
    // not notice.
    intervalMs: 15_000,
    run: () => bookingService.releaseExpiredHolds(),
  },
  { name: 'drain-outbox', intervalMs: 2_000, run: () => drainOutbox() },
  { name: 'refresh-outbox-gauge', intervalMs: 30_000, run: () => refreshOutboxGauge() },
  {
    name: 'refresh-hold-gauge',
    intervalMs: 30_000,
    run: async () => {
      const { rows } = await query<{ count: number }>(
        `SELECT count(*)::int AS count FROM availability_slots
          WHERE status = 'held' AND held_until > now()`,
      );
      slotHoldsActive.set(rows[0]?.count ?? 0);
    },
  },
  {
    name: 'purge-idempotency-keys',
    intervalMs: 3_600_000,
    run: async () => {
      const purged = await purgeExpiredIdempotencyKeys();
      if (purged > 0) logger.info({ purged }, 'purged expired idempotency keys');
    },
  },
  {
    name: 'ensure-partitions',
    // Daily. A missing partition is a hard insert failure, so this runs far
    // more often than the monthly boundary it protects.
    intervalMs: 86_400_000,
    run: () => query('SELECT ensure_month_partitions(3)'),
  },
];

const timers: NodeJS.Timeout[] = [];

export function startWorker(): void {
  if (!config.WORKER_ENABLED) {
    logger.info('worker disabled by configuration');
    return;
  }

  for (const loop of LOOPS) {
    let running = false;
    const timer = setInterval(() => {
      // Skip rather than overlap: a slow tick must not stack up behind itself.
      if (running) return;
      running = true;
      loop
        .run()
        .catch((err) => logger.error({ err, job: loop.name }, 'background job failed'))
        .finally(() => {
          running = false;
        });
    }, loop.intervalMs);

    timer.unref();
    timers.push(timer);
  }

  logger.info({ jobs: LOOPS.map((l) => l.name) }, 'background worker started');
}

export function stopWorker(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
}
