import type { Request, Response, NextFunction } from 'express';
import { query } from '../db/pool.js';
import { canonicalHash } from '../lib/crypto.js';
import { badRequest, conflict, idempotencyMismatch, unauthorized } from '../lib/errors.js';
import { idempotentReplays } from '../telemetry/metrics.js';
import { logger } from '../lib/logger.js';
import type { AuthenticatedRequest } from './auth.js';

/**
 * Idempotency for unsafe writes.
 *
 * The problem this solves: a client posts a booking, the response is lost to a
 * network blip, the client retries — and the patient is charged twice for two
 * consultations. HTTP gives no guarantee here, so the server has to provide
 * one.
 *
 * The mechanism is insert-first, not check-then-insert:
 *
 *   INSERT ... ON CONFLICT (user_id, idem_key) DO NOTHING RETURNING id
 *
 * Exactly one concurrent request can win that INSERT, because the uniqueness
 * decision is made by the database under its own lock. A SELECT-then-INSERT
 * would leave a window between the two statements in which both requests see
 * "no existing key" and both proceed — which is precisely the double-booking
 * this is meant to prevent.
 *
 * Losing the race resolves to one of three outcomes:
 *   - stored request hash differs  -> 422, the key is being reused wrongly
 *   - the winner has finished      -> replay its exact stored response
 *   - the winner is still running  -> 409, retry shortly
 *
 * Scope is (user_id, key): one tenant's key can never collide with another's.
 */

const REPLAY_HEADER = 'idempotency-replayed';

interface IdempotencyRow {
  id: string;
  request_hash: string;
  state: 'in_progress' | 'completed' | 'failed';
  response_status: number | null;
  response_body: unknown;
}

export function idempotent(endpointName: string) {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) throw unauthorized();

      const key = req.get('idempotency-key');
      if (!key) {
        throw badRequest(
          'This endpoint requires an Idempotency-Key header. ' +
            'Use a UUID that is stable across retries of the same logical request.',
        );
      }
      if (key.length > 255 || !/^[\w.:-]+$/.test(key)) {
        throw badRequest('Idempotency-Key must be <=255 characters of [A-Za-z0-9._:-]');
      }

      const requestHash = canonicalHash({ method: req.method, path: req.path, body: req.body });

      const inserted = await query<{ id: string }>(
        `INSERT INTO idempotency_keys (user_id, idem_key, endpoint, request_hash, state)
         VALUES ($1, $2, $3, $4, 'in_progress')
         ON CONFLICT (user_id, idem_key) DO NOTHING
         RETURNING id`,
        [user.id, key, endpointName, requestHash],
      );

      if (inserted.rowCount === 0) {
        const existing = await query<IdempotencyRow>(
          `SELECT id, request_hash, state, response_status, response_body
             FROM idempotency_keys
            WHERE user_id = $1 AND idem_key = $2`,
          [user.id, key],
        );
        const row = existing.rows[0];

        // Expired and swept between the INSERT and this SELECT: treat as new.
        if (!row) return next();

        if (row.request_hash !== requestHash) throw idempotencyMismatch();

        if (row.state === 'completed' && row.response_status !== null) {
          idempotentReplays.inc({ endpoint: endpointName });
          logger.info({ endpoint: endpointName, key }, 'replaying stored idempotent response');
          res.setHeader(REPLAY_HEADER, 'true');
          res.status(row.response_status).json(row.response_body);
          return;
        }

        if (row.state === 'in_progress') {
          throw conflict(
            'A request with this Idempotency-Key is currently being processed',
            'IDEMPOTENT_REQUEST_IN_PROGRESS',
          );
        }

        // Previous attempt failed: let this one take over the key.
        await query(
          `UPDATE idempotency_keys
              SET state = 'in_progress', response_status = NULL, response_body = NULL
            WHERE id = $1`,
          [row.id],
        );
      }

      captureResponse(req, res, user.id, key, endpointName);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Records the outcome against the key once the handler has responded.
 *
 * Only 2xx responses are stored for replay. A 4xx is a client error that a
 * corrected retry should be allowed to fix, and a 5xx may not have completed
 * its side effects — in both cases the key is released rather than pinned to a
 * response that would be wrong to repeat.
 */
function captureResponse(
  _req: Request,
  res: Response,
  userId: string,
  key: string,
  endpoint: string,
): void {
  const originalJson = res.json.bind(res);

  res.json = function patchedJson(payload: unknown) {
    const status = res.statusCode;

    // Fire-and-forget: persisting the record must not delay the response, and
    // a failure here must not turn a successful booking into an error.
    const persist =
      status >= 200 && status < 300
        ? query(
            `UPDATE idempotency_keys
                SET state = 'completed', response_status = $1, response_body = $2
              WHERE user_id = $3 AND idem_key = $4`,
            [status, JSON.stringify(payload), userId, key],
          )
        : query(
            `UPDATE idempotency_keys SET state = 'failed' WHERE user_id = $1 AND idem_key = $2`,
            [userId, key],
          );

    void persist.catch((err) =>
      logger.error({ err, endpoint, key }, 'failed to record idempotency outcome'),
    );

    return originalJson(payload);
  };
}

/** Sweeps expired keys. Run from the maintenance job, not on the request path. */
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const result = await query('DELETE FROM idempotency_keys WHERE expires_at < now()');
  return result.rowCount ?? 0;
}
