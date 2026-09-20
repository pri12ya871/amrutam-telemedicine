import { z } from 'zod';
import { query } from '../../db/pool.js';
import { cacheGet, cacheSet } from '../../cache/redis.js';
import { audit } from '../audit/auditService.js';

export const analyticsRangeSchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
  /** Closed set — this value is interpolated into GROUP BY, never bound. */
  groupBy: z.enum(['day', 'week', 'month']).default('day'),
});

const GROUP_TRUNC: Record<string, string> = { day: 'day', week: 'week', month: 'month' };

/**
 * Admin analytics.
 *
 * Aggregates run against the same OLTP tables here, which is fine at this
 * scale but is not the shape that survives growth: the roadmap in
 * docs/architecture.md routes these at a read replica and then at a
 * materialised rollup table, so a slow analytics scan can never contend with
 * the booking path.
 *
 * Results are cached for five minutes. Nobody makes a decision on
 * thirty-second-old dashboard data, and the query is heavy enough to matter.
 */
export const analyticsService = {
  async overview(adminId: string) {
    const cached = await cacheGet<Record<string, unknown>>('analytics:overview');
    if (cached) return cached;

    // One round trip. Six sequential COUNTs would be six times the latency
    // for the same information.
    const { rows } = await query<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM users WHERE role = 'patient' AND status = 'active')::int AS active_patients,
         (SELECT count(*) FROM doctors WHERE status = 'active')::int                    AS active_doctors,
         (SELECT count(*) FROM doctors WHERE status = 'pending_verification')::int      AS pending_doctors,
         (SELECT count(*) FROM consultations
           WHERE created_at >= date_trunc('day', now()))::int                           AS consultations_today,
         (SELECT count(*) FROM consultations
           WHERE status = 'scheduled' AND scheduled_at > now())::int                    AS upcoming_consultations,
         (SELECT coalesce(sum(amount_paise), 0) FROM payments
           WHERE status = 'captured'
             AND created_at >= date_trunc('month', now()))::bigint                      AS revenue_month_paise,
         (SELECT count(*) FROM availability_slots
           WHERE status = 'available' AND start_at > now())::int                        AS open_slots`,
    );

    const result = rows[0]!;
    await cacheSet('analytics:overview', result, 300);
    await audit({ action: 'analytics.overview', resourceType: 'analytics', actorId: adminId });
    return result;
  },

  async consultationTrend(input: z.infer<typeof analyticsRangeSchema>) {
    const trunc = GROUP_TRUNC[input.groupBy]!;
    const { rows } = await query(
      `SELECT date_trunc('${trunc}', created_at) AS bucket,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'completed')::int AS completed,
              count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE status = 'no_show')::int   AS no_show
         FROM consultations
        WHERE created_at >= $1::date AND created_at < $2::date + interval '1 day'
        GROUP BY bucket
        ORDER BY bucket`,
      [input.from, input.to],
    );
    return rows;
  },

  async topDoctors(limit = 10) {
    const { rows } = await query(
      `SELECT d.id, p.full_name, d.specializations, d.rating,
              count(c.id)::int AS consultation_count,
              coalesce(sum(pay.amount_paise) FILTER (WHERE pay.status = 'captured'), 0)::bigint AS revenue_paise
         FROM doctors d
         JOIN profiles p ON p.user_id = d.user_id
         LEFT JOIN consultations c ON c.doctor_id = d.id AND c.status = 'completed'
         LEFT JOIN payments pay    ON pay.consultation_id = c.id
        WHERE d.status = 'active'
        GROUP BY d.id, p.full_name
        ORDER BY consultation_count DESC, d.rating DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  },

  /**
   * Utilisation: how much of the published availability actually converts.
   * The metric the business cares about, and the one that tells you whether
   * doctors are publishing slots nobody wants.
   */
  async slotUtilisation(from: string, to: string) {
    const { rows } = await query(
      `SELECT count(*)::int AS total_slots,
              count(*) FILTER (WHERE status = 'booked')::int    AS booked,
              count(*) FILTER (WHERE status = 'available')::int AS available,
              count(*) FILTER (WHERE status = 'blocked')::int   AS blocked,
              round(
                100.0 * count(*) FILTER (WHERE status = 'booked')
                / nullif(count(*), 0), 2
              ) AS utilisation_pct
         FROM availability_slots
        WHERE start_at >= $1::date AND start_at < $2::date + interval '1 day'`,
      [from, to],
    );
    return rows[0];
  },
};
