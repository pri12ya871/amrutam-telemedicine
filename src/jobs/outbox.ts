import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { outboxLag } from '../telemetry/metrics.js';

/**
 * Transactional outbox.
 *
 * A domain event is inserted in the same transaction as the state change it
 * describes, so the two cannot disagree. A relay then publishes pending rows
 * and marks them done.
 *
 * This gives at-least-once delivery, not exactly-once — the relay can publish
 * and then die before recording success. Consumers must therefore be
 * idempotent, which is stated in docs/architecture.md rather than left as a
 * surprise.
 */
export async function enqueue(topic: string, payload: unknown, client: PoolClient): Promise<void> {
  await query(
    `INSERT INTO outbox (topic, payload) VALUES ($1, $2)`,
    [topic, JSON.stringify(payload)],
    client,
  );
}

export type EventHandler = (payload: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, EventHandler[]>();

export function on(topic: string, handler: EventHandler): void {
  const existing = handlers.get(topic) ?? [];
  existing.push(handler);
  handlers.set(topic, existing);
}

const MAX_ATTEMPTS = 8;

/**
 * Relay one batch.
 *
 * FOR UPDATE SKIP LOCKED is what lets several worker instances drain the same
 * table concurrently: each claims rows the others are not holding, with no
 * coordination and no duplicate processing within a batch.
 */
export async function drainOutbox(batchSize = 100): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await query<{
      id: string; topic: string; payload: Record<string, unknown>; attempts: number;
    }>(
      `SELECT id, topic, payload, attempts
         FROM outbox
        WHERE status = 'pending' AND next_attempt_at <= now()
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
      client,
    );

    for (const event of rows) {
      const topicHandlers = handlers.get(event.topic) ?? [];
      try {
        await Promise.all(topicHandlers.map((h) => h(event.payload)));
        await query(`UPDATE outbox SET status = 'done' WHERE id = $1`, [event.id], client);
      } catch (err) {
        const attempts = event.attempts + 1;
        const dead = attempts >= MAX_ATTEMPTS;
        // Exponential backoff, capped at an hour. A dead-lettered event stays
        // in the table for inspection rather than being dropped.
        const backoffSeconds = Math.min(3600, 2 ** attempts);
        await query(
          `UPDATE outbox
              SET attempts = $2,
                  status = $3,
                  last_error = $4,
                  next_attempt_at = now() + make_interval(secs => $5::int)
            WHERE id = $1`,
          [event.id, attempts, dead ? 'dead' : 'pending', (err as Error).message.slice(0, 500), backoffSeconds],
          client,
        );
        logger.error(
          { err, topic: event.topic, eventId: event.id, attempts, dead },
          dead ? 'outbox event dead-lettered' : 'outbox event failed, will retry',
        );
      }
    }

    return rows.length;
  });
}

export async function refreshOutboxGauge(): Promise<void> {
  const { rows } = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM outbox WHERE status = 'pending'`,
  );
  outboxLag.set(rows[0]?.count ?? 0);
}
