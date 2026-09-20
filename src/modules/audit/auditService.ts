import { query, type Queryable } from '../../db/pool.js';
import { getContext } from '../../lib/context.js';
import { logger } from '../../lib/logger.js';

export interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome?: 'success' | 'failure' | 'denied';
  actorId?: string | null;
  actorRole?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Compliance audit trail.
 *
 * Two rules, both load-bearing:
 *
 * 1. Every access to personal or clinical data is recorded — reads included.
 *    "Who looked at this patient's prescription" is exactly the question an
 *    audit is for, and a write-only log cannot answer it.
 *
 * 2. The metadata column never receives the data itself. Recording that
 *    prescription X was read is the point; copying its contents into a second
 *    table would double the blast radius of a leak for no investigative gain.
 */
export async function audit(entry: AuditEntry, client?: Queryable): Promise<void> {
  const ctx = getContext();
  try {
    await query(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, resource_type, resource_id,
          outcome, ip_hash, user_agent, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        entry.actorId ?? ctx?.userId ?? null,
        entry.actorRole ?? ctx?.role ?? null,
        entry.action,
        entry.resourceType,
        entry.resourceId ?? null,
        entry.outcome ?? 'success',
        ctx?.ipHash ?? null,
        ctx?.userAgent ?? null,
        ctx?.requestId ?? null,
        JSON.stringify(entry.metadata ?? {}),
      ],
      client,
    );
  } catch (err) {
    // An audit write must never break the operation it describes. It is
    // logged at error level so the gap is visible to alerting.
    logger.error({ err, action: entry.action }, 'AUDIT WRITE FAILED');
  }
}

/**
 * Audit inside the caller's transaction.
 *
 * For state changes this is the correct variant: the audit row commits with
 * the change, so there is no window where a consultation exists with no record
 * of who created it. It deliberately does not swallow errors — if the audit
 * cannot be written, the change should not commit either.
 */
export async function auditInTransaction(entry: AuditEntry, client: Queryable): Promise<void> {
  const ctx = getContext();
  await query(
    `INSERT INTO audit_logs
       (actor_id, actor_role, action, resource_type, resource_id,
        outcome, ip_hash, user_agent, request_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorId ?? ctx?.userId ?? null,
      entry.actorRole ?? ctx?.role ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.outcome ?? 'success',
      ctx?.ipHash ?? null,
      ctx?.userAgent ?? null,
      ctx?.requestId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
    client,
  );
}

export interface AuditQuery {
  actorId?: string;
  resourceType?: string;
  resourceId?: string;
  action?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

export async function searchAuditLogs(filters: AuditQuery) {
  const where: string[] = [];
  const params: unknown[] = [];

  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace('?', `$${params.length}`));
  };

  if (filters.actorId) add('actor_id = ?', filters.actorId);
  if (filters.resourceType) add('resource_type = ?', filters.resourceType);
  if (filters.resourceId) add('resource_id = ?', filters.resourceId);
  if (filters.action) add('action = ?', filters.action);
  if (filters.from) add('created_at >= ?', filters.from);
  if (filters.to) add('created_at < ?', filters.to);

  params.push(filters.limit, filters.offset);

  const { rows } = await query(
    `SELECT id, actor_id, actor_role, action, resource_type, resource_id,
            outcome, request_id, metadata, created_at
       FROM audit_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
}
