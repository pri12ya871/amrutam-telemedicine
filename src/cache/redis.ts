import { Redis } from 'ioredis';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { cacheOps } from '../telemetry/metrics.js';

/**
 * Redis is an optimisation, never a dependency.
 *
 * Every helper here fails soft: if Redis is down, reads miss, writes are
 * dropped and the request completes against Postgres. Making a request path
 * hard-depend on the cache converts a cache outage into a service outage, and
 * the availability target does not survive that.
 */

let client: Redis | null = null;

if (config.REDIS_URL) {
  client = new Redis(config.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false, // fail now rather than queue behind a dead socket
    connectTimeout: 3_000,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    ...(config.REDIS_URL.startsWith('rediss://') ? { tls: {} } : {}),
  });

  client.on('error', (err: Error) =>
    logger.warn({ err: err.message }, 'redis error (degrading to no cache)'),
  );
  client.on('connect', () => logger.info('redis connected'));
} else {
  logger.warn('REDIS_URL not set — running without cache and with in-memory rate limiting');
}

export const isCacheEnabled = (): boolean => client !== null && client.status === 'ready';

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isCacheEnabled()) return null;
  try {
    const raw = await client!.get(key);
    cacheOps.inc({ result: raw ? 'hit' : 'miss' });
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (err) {
    cacheOps.inc({ result: 'error' });
    logger.warn({ err: (err as Error).message, key }, 'cache get failed');
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  if (!isCacheEnabled()) return;
  try {
    await client!.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    cacheOps.inc({ result: 'error' });
    logger.warn({ err: (err as Error).message, key }, 'cache set failed');
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (!isCacheEnabled() || keys.length === 0) return;
  try {
    await client!.del(...keys);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'cache delete failed');
  }
}

/**
 * Invalidate by prefix using SCAN, never KEYS. KEYS blocks the single Redis
 * thread for the whole keyspace, which on a warm cache is a self-inflicted
 * stall measured in seconds.
 */
export async function cacheDelPrefix(prefix: string): Promise<void> {
  if (!isCacheEnabled()) return;
  try {
    let cursor = '0';
    do {
      const [next, keys] = await client!.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      if (keys.length) await client!.del(...keys);
    } while (cursor !== '0');
  } catch (err) {
    logger.warn({ err: (err as Error).message, prefix }, 'cache prefix invalidation failed');
  }
}

/**
 * Fixed-window counter, evaluated atomically server-side so two concurrent
 * requests cannot both read the pre-increment value.
 * Returns null when Redis is unavailable — callers treat that as "allow".
 */
export async function incrementWindow(key: string, windowSeconds: number): Promise<number | null> {
  if (!isCacheEnabled()) return null;
  try {
    const results = await client!.multi().incr(key).expire(key, windowSeconds, 'NX').exec();
    const count = results?.[0]?.[1];
    return typeof count === 'number' ? count : null;
  } catch {
    return null;
  }
}

export async function cacheHealth(): Promise<boolean> {
  if (!client) return false;
  try {
    return (await client.ping()) === 'PONG';
  } catch {
    return false;
  }
}

export async function closeCache(): Promise<void> {
  if (client) await client.quit().catch(() => client?.disconnect());
}

export const cacheKeys = {
  doctor: (id: string) => `doctor:${id}`,
  doctorSearch: (hash: string) => `search:doctors:${hash}`,
  slots: (doctorId: string, date: string) => `slots:${doctorId}:${date}`,
  slotsPrefix: (doctorId: string) => `slots:${doctorId}:`,
  searchPrefix: () => 'search:doctors:',
} as const;
