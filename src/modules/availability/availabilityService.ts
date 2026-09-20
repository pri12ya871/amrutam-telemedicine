import { z } from 'zod';
import { query } from '../../db/pool.js';
import { cacheDelPrefix, cacheGet, cacheKeys, cacheSet } from '../../cache/redis.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../audit/auditService.js';

export const availabilityRuleSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM'),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM'),
  slotMinutes: z.number().int().min(5).max(240).default(30),
  timezone: z.string().default('Asia/Kolkata'),
  validFrom: z.string().date().optional(),
  validTo: z.string().date().optional(),
});

export const slotQuerySchema = z.object({
  from: z.string().date(),
  to: z.string().date(),
});

export interface Slot {
  id: string;
  doctor_id: string;
  start_at: Date;
  end_at: Date;
  status: string;
}

/**
 * Availability is stored as recurring weekly rules and *materialised* into
 * concrete slots ahead of time.
 *
 * Computing a recurrence at read time would mean every availability lookup
 * expands rules, applies timezone conversion and subtracts existing bookings —
 * far too much work for a p95 under 200ms on the busiest read in the product.
 * Materialised rows are a plain indexed range scan instead.
 */
export const availabilityService = {
  async addRule(doctorId: string, input: z.infer<typeof availabilityRuleSchema>) {
    if (input.endTime <= input.startTime) {
      throw badRequest('endTime must be after startTime');
    }
    const { rows } = await query<{ id: string }>(
      `INSERT INTO availability_rules
         (doctor_id, weekday, start_time, end_time, slot_minutes, timezone, valid_from, valid_to)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::date, CURRENT_DATE), $8::date)
       RETURNING id`,
      [
        doctorId, input.weekday, input.startTime, input.endTime,
        input.slotMinutes, input.timezone, input.validFrom ?? null, input.validTo ?? null,
      ],
    );
    await cacheDelPrefix(cacheKeys.slotsPrefix(doctorId));
    await audit({
      action: 'availability.rule_created', resourceType: 'doctor', resourceId: doctorId,
      metadata: { weekday: input.weekday, startTime: input.startTime, endTime: input.endTime },
    });
    return rows[0]!;
  },

  async listRules(doctorId: string) {
    const { rows } = await query(
      `SELECT id, weekday, start_time, end_time, slot_minutes, timezone, valid_from, valid_to
         FROM availability_rules WHERE doctor_id = $1 ORDER BY weekday, start_time`,
      [doctorId],
    );
    return rows;
  },

  /**
   * Expand rules into slots for a date range.
   *
   * Done entirely in SQL for two reasons: generate_series does the expansion
   * in one round trip instead of N inserts, and `AT TIME ZONE` delegates DST
   * and offset arithmetic to Postgres's tz database rather than reimplementing
   * it in application code.
   *
   * Idempotent by construction — ON CONFLICT DO NOTHING against
   * uq_slot_per_doctor — so the generator can safely be re-run, retried, or
   * scheduled to overlap its previous window.
   */
  async generateSlots(doctorId: string, from: string, to: string): Promise<number> {
    const { rows } = await query<{ id: string }>(
      `WITH days AS (
         SELECT generate_series($2::date, $3::date, interval '1 day')::date AS d
       ),
       expanded AS (
         SELECT r.doctor_id,
                r.slot_minutes,
                generate_series(
                  (d.d + r.start_time) AT TIME ZONE r.timezone,
                  ((d.d + r.end_time) AT TIME ZONE r.timezone)
                    - make_interval(mins => r.slot_minutes),
                  make_interval(mins => r.slot_minutes)
                ) AS start_at
           FROM availability_rules r
           JOIN days d ON EXTRACT(DOW FROM d.d)::int = r.weekday
          WHERE r.doctor_id = $1
            AND d.d >= r.valid_from
            AND (r.valid_to IS NULL OR d.d <= r.valid_to)
       )
       INSERT INTO availability_slots (doctor_id, start_at, end_at)
       SELECT doctor_id, start_at, start_at + make_interval(mins => slot_minutes)
         FROM expanded
        WHERE start_at > now()
       ON CONFLICT (doctor_id, start_at) DO NOTHING
       RETURNING id`,
      [doctorId, from, to],
    );

    await cacheDelPrefix(cacheKeys.slotsPrefix(doctorId));
    return rows.length;
  },

  /**
   * Available slots for a doctor over a date range.
   *
   * Cached for 30 seconds. The TTL is short deliberately: availability is the
   * most-read and fastest-changing resource here, and a stale slot shown to a
   * patient costs them a 409 at booking time. Writes also invalidate the
   * prefix, so the TTL is only a backstop against a missed invalidation.
   */
  async listAvailableSlots(doctorId: string, from: string, to: string) {
    const key = cacheKeys.slots(doctorId, `${from}_${to}`);
    const cached = await cacheGet<unknown[]>(key);
    if (cached) return cached;

    const { rows } = await query(
      `SELECT id, start_at, end_at
         FROM availability_slots
        WHERE doctor_id = $1
          AND start_at >= $2::date
          AND start_at <  ($3::date + interval '1 day')
          AND start_at > now()
          AND (status = 'available' OR (status = 'held' AND held_until < now()))
        ORDER BY start_at
        LIMIT 500`,
      [doctorId, from, to],
    );

    await cacheSet(key, rows, 30);
    return rows;
  },

  async blockSlot(doctorId: string, slotId: string) {
    // Only a slot that is not already booked can be blocked; the status guard
    // in the WHERE clause is what makes this safe against a concurrent booking.
    const result = await query(
      `UPDATE availability_slots
          SET status = 'blocked', version = version + 1
        WHERE id = $1 AND doctor_id = $2 AND status IN ('available', 'held')`,
      [slotId, doctorId],
    );
    if (result.rowCount === 0) throw notFound('Available slot');
    await cacheDelPrefix(cacheKeys.slotsPrefix(doctorId));
  },
};
