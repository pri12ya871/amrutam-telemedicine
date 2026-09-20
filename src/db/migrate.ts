import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { pool, closePool } from './pool.js';
import { logger } from '../lib/logger.js';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Minimal forward-only migration runner.
 *
 * Two properties matter more than features: it takes an advisory lock so two
 * instances booting at once cannot race, and it records a checksum so an
 * already-applied migration that has been edited is an error rather than a
 * silent divergence between environments.
 */
const LOCK_ID = 8_427_311;

export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
  try {
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await pool.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(migrationsDir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = applied.get(file);

      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `migration ${file} has changed since it was applied ` +
              `(${previous} -> ${checksum}). Add a new migration instead of editing this one.`,
          );
        }
        continue;
      }

      logger.info({ migration: file }, 'applying migration');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      } finally {
        client.release();
      }
    }
    logger.info({ count: files.length }, 'migrations up to date');
  } finally {
    await pool.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  }
}

// Allow `npm run migrate` as well as being called from the server bootstrap.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
