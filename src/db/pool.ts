import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { dbQueryDuration } from '../telemetry/metrics.js';

const { Pool } = pg;

// bigint (int8) arrives as a string so large values survive the trip. Money is
// stored in paise as bigint, and those values fit comfortably in a JS number,
// so parse them rather than leaking strings into the API contract.
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number(v));

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Every statement gets an upper bound. Without it one pathological query
  // holds a pool slot indefinitely and the whole service queues behind it.
  statement_timeout: 10_000,
  query_timeout: 10_000,
  ...(config.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
});

pool.on('error', (err) => {
  // An idle client erroring is not fatal — pg replaces it — but it is a signal.
  logger.error({ err }, 'idle postgres client error');
});

export type Queryable = Pick<pg.PoolClient, 'query'>;

export interface Row {
  [column: string]: unknown;
}

/**
 * Deliberately not pg's own QueryResult. Row shapes here are declared as
 * plain interfaces, which TypeScript does not consider assignable to an
 * index-signature constraint; narrowing the surface to what callers actually
 * use keeps those interfaces usable without polluting every one of them with
 * `[column: string]: unknown`.
 */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

export async function query<T = Row>(
  text: string,
  params: readonly unknown[] = [],
  client: Queryable = pool,
): Promise<QueryResult<T>> {
  const started = process.hrtime.bigint();
  try {
    const result = await client.query(text, params as unknown[]);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  } finally {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    dbQueryDuration.observe({ operation: operationOf(text) }, seconds);
  }
}

/** First word of the statement, for metric cardinality that stays bounded. */
function operationOf(sql: string): string {
  const match = /^\s*(\w+)/.exec(sql);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

/**
 * Run a function inside a transaction, releasing the client whatever happens.
 *
 * Services take a `Queryable` rather than reaching for the pool directly, so
 * the same repository method composes into a transaction or runs standalone.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  isolation: 'read committed' | 'repeatable read' | 'serializable' = 'read committed',
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, 'rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthCheck(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export const closePool = () => pool.end();

/** Postgres unique-violation. Used to turn a race into a clean 409. */
export const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
