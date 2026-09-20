import { z } from 'zod';
import type { PoolClient } from 'pg';
import { config } from '../../config.js';
import { query, withTransaction } from '../../db/pool.js';
import { cacheDelPrefix, cacheKeys } from '../../cache/redis.js';
import { encryptField } from '../../lib/crypto.js';
import { conflict, forbidden, notFound, slotUnavailable, badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { bookingAttempts } from '../../telemetry/metrics.js';
import { auditInTransaction } from '../audit/auditService.js';
import { enqueue } from '../../jobs/outbox.js';

export const createBookingSchema = z.object({
  slotId: z.string().uuid(),
  mode: z.enum(['video', 'audio', 'chat', 'in_person']).default('video'),
  chiefComplaint: z.string().min(3).max(2000).optional(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().min(3).max(500),
});

export interface BookingResult {
  consultationId: string;
  status: string;
  scheduledAt: Date;
  doctorId: string;
  holdExpiresAt: Date;
  payment: { id: string; amountPaise: number; currency: string; status: string };
}

/**
 * Booking: the one flow where correctness under concurrency is the whole job.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 * Two patients open the same doctor's 10:00 slot and tap Book at the same
 * instant. Both requests read "available". Both write a consultation. The
 * doctor is now double-booked, both patients are charged, and the failure is
 * invisible until someone joins the call.
 *
 * ── What does NOT solve it ────────────────────────────────────────────────
 * • SELECT status, then INSERT if available. There is a window between the two
 *   statements; under READ COMMITTED both transactions see the pre-write state.
 * • SELECT ... FOR UPDATE then UPDATE. Correct, but it holds a row lock across
 *   application round trips, and the queue it forms shows up directly in p95.
 * • An advisory lock per slot. Also correct, also serialising, and it moves the
 *   invariant out of the schema into a convention nothing enforces.
 *
 * ── What does ─────────────────────────────────────────────────────────────
 * A single conditional UPDATE that carries the precondition in its WHERE
 * clause:
 *
 *     UPDATE availability_slots SET status = 'held', ...
 *      WHERE id = $1 AND (status = 'available' OR hold expired)
 *
 * Postgres evaluates the predicate while holding the row lock it just took, so
 * exactly one concurrent statement can match. The loser gets rowCount = 0 —
 * not an exception, not a stale read, just a fact — and returns 409. No
 * application-level lock, no retry loop, one round trip.
 *
 * `uq_slot_consultation` is the backstop underneath: even a future caller that
 * bypasses this function cannot attach two consultations to one slot.
 *
 * ── Why a hold rather than a booking ──────────────────────────────────────
 * Payment is a separate, slow, failure-prone step against a third party. The
 * slot is held for SLOT_HOLD_MINUTES so the patient can pay without the slot
 * being sold underneath them, and a sweeper releases holds that were never
 * confirmed. This is the compensating action of the booking saga; the states
 * and transitions are in docs/architecture.md.
 */
export const bookingService = {
  async book(
    patientId: string,
    input: z.infer<typeof createBookingSchema>,
  ): Promise<BookingResult> {
    const holdMinutes = config.SLOT_HOLD_MINUTES;

    try {
      const result = await withTransaction(async (client) => {
        // ─── Step 1: claim the slot atomically ───────────────────────────
        // An expired hold is treated as available: the previous holder had
        // their window and did not pay. Reclaiming it here rather than waiting
        // for the sweeper means a slot is never dead time.
        const claim = await query<{
          id: string; doctor_id: string; start_at: Date; end_at: Date;
        }>(
          `UPDATE availability_slots
              SET status      = 'held',
                  hold_token  = gen_random_uuid(),
                  held_by     = $2,
                  held_until  = now() + make_interval(mins => $3::int),
                  version     = version + 1
            WHERE id = $1
              AND consultation_id IS NULL
              AND (status = 'available'
                   OR (status = 'held' AND held_until < now()))
            RETURNING id, doctor_id, start_at, end_at`,
          [input.slotId, patientId, holdMinutes],
          client,
        );

        // Zero rows means one of: the slot does not exist, it is blocked, or
        // another transaction claimed it microseconds ago. All are 409 to the
        // client — distinguishing them would leak other patients' activity.
        const slot = claim.rows[0];
        if (!slot) {
          bookingAttempts.inc({ outcome: 'slot_taken' });
          throw slotUnavailable();
        }

        if (slot.start_at <= new Date()) {
          throw badRequest('Cannot book a slot in the past');
        }

        // ─── Step 2: doctor must still be bookable ───────────────────────
        const doctorResult = await query<{
          id: string; consultation_fee_paise: number; status: string; user_id: string;
        }>(
          `SELECT id, consultation_fee_paise, status, user_id
             FROM doctors WHERE id = $1`,
          [slot.doctor_id],
          client,
        );
        const doctor = doctorResult.rows[0];
        if (!doctor) throw notFound('Doctor');
        if (doctor.status !== 'active') {
          throw conflict('This doctor is not currently accepting consultations', 'DOCTOR_INACTIVE');
        }
        if (doctor.user_id === patientId) {
          throw badRequest('A doctor cannot book a consultation with themselves');
        }

        // ─── Step 3: the consultation, pending payment ───────────────────
        const consultationResult = await query<{ id: string; created_at: Date; status: string }>(
          `INSERT INTO consultations
             (patient_id, doctor_id, slot_id, status, mode, scheduled_at, chief_complaint_enc)
           VALUES ($1, $2, $3, 'pending_payment', $4, $5, $6)
           RETURNING id, created_at, status`,
          [
            patientId,
            slot.doctor_id,
            slot.id,
            input.mode,
            slot.start_at,
            // Free-text symptoms are health data the moment they are written.
            input.chiefComplaint ? JSON.stringify(encryptField(input.chiefComplaint)) : null,
          ],
          client,
        );
        const consultation = consultationResult.rows[0]!;

        // ─── Step 4: bind slot to consultation ───────────────────────────
        // Trips uq_slot_consultation if anything else has already bound this
        // slot — the last line of defence, and it commits atomically with the
        // consultation row it points at.
        await query(
          `UPDATE availability_slots SET consultation_id = $2 WHERE id = $1`,
          [slot.id, consultation.id],
          client,
        );

        // ─── Step 5: the payment intent ──────────────────────────────────
        const paymentResult = await query<{ id: string; status: string }>(
          `INSERT INTO payments (consultation_id, patient_id, amount_paise, currency, status)
           VALUES ($1, $2, $3, 'INR', 'pending')
           RETURNING id, status`,
          [consultation.id, patientId, doctor.consultation_fee_paise],
          client,
        );
        const payment = paymentResult.rows[0]!;

        // ─── Step 6: audit and outbox, same transaction ──────────────────
        // Both commit with the booking. An event that is emitted before the
        // commit can describe a booking that never happened; one emitted after
        // can be lost if the process dies in between. The outbox avoids both.
        await auditInTransaction(
          {
            action: 'booking.created',
            resourceType: 'consultation',
            resourceId: consultation.id,
            actorId: patientId,
            metadata: { slotId: slot.id, doctorId: slot.doctor_id, mode: input.mode },
          },
          client,
        );

        await enqueue(
          'consultation.hold_created',
          {
            consultationId: consultation.id,
            patientId,
            doctorId: slot.doctor_id,
            scheduledAt: slot.start_at,
            holdExpiresAt: new Date(Date.now() + holdMinutes * 60_000),
          },
          client,
        );

        return {
          consultationId: consultation.id,
          status: consultation.status,
          scheduledAt: slot.start_at,
          doctorId: slot.doctor_id,
          holdExpiresAt: new Date(Date.now() + holdMinutes * 60_000),
          payment: {
            id: payment.id,
            amountPaise: doctor.consultation_fee_paise,
            currency: 'INR',
            status: payment.status,
          },
        };
      });

      // Invalidate after commit, never before: invalidating inside the
      // transaction would let a concurrent read repopulate the cache from the
      // pre-commit state and leave it stale indefinitely.
      await cacheDelPrefix(cacheKeys.slotsPrefix(result.doctorId));
      bookingAttempts.inc({ outcome: 'held' });
      return result;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SLOT_UNAVAILABLE') {
        bookingAttempts.inc({ outcome: 'error' });
      }
      throw err;
    }
  },

  /**
   * Confirm a held booking once payment has been captured.
   *
   * Idempotent on purpose: a payment webhook can arrive twice, and the second
   * delivery must not fail loudly or double-transition the state machine.
   */
  async confirm(consultationId: string, client?: PoolClient): Promise<void> {
    const run = async (c: PoolClient) => {
      const updated = await query<{ slot_id: string; doctor_id: string }>(
        `UPDATE consultations
            SET status = 'scheduled', updated_at = now()
          WHERE id = $1 AND status = 'pending_payment'
          RETURNING slot_id, doctor_id`,
        [consultationId],
        c,
      );

      const row = updated.rows[0];
      if (!row) {
        // Already scheduled (duplicate webhook) or cancelled (hold expired
        // before payment landed). Neither is an error here; the payment
        // service decides whether a refund is owed.
        logger.info({ consultationId }, 'confirm skipped — consultation not pending payment');
        return;
      }

      await query(
        `UPDATE availability_slots
            SET status = 'booked', held_until = NULL, hold_token = NULL, version = version + 1
          WHERE id = $1`,
        [row.slot_id],
        c,
      );

      await auditInTransaction(
        { action: 'booking.confirmed', resourceType: 'consultation', resourceId: consultationId },
        c,
      );
      await enqueue('consultation.confirmed', { consultationId, doctorId: row.doctor_id }, c);
      bookingAttempts.inc({ outcome: 'confirmed' });
    };

    if (client) return run(client);
    await withTransaction(run);
  },

  /**
   * Cancel and release the slot.
   *
   * The slot returns to `available` rather than being deleted, so the doctor's
   * published availability is unchanged by a patient changing their mind.
   */
  async cancel(consultationId: string, actorId: string, actorRole: string, reason: string) {
    const result = await withTransaction(async (client) => {
      const found = await query<{
        id: string; patient_id: string; doctor_id: string; slot_id: string;
        status: string; scheduled_at: Date; doctor_user_id: string;
      }>(
        `SELECT c.id, c.patient_id, c.doctor_id, c.slot_id, c.status, c.scheduled_at,
                d.user_id AS doctor_user_id
           FROM consultations c
           JOIN doctors d ON d.id = c.doctor_id
          WHERE c.id = $1`,
        [consultationId],
        client,
      );
      const consultation = found.rows[0];
      if (!consultation) throw notFound('Consultation');

      const isParticipant =
        consultation.patient_id === actorId || consultation.doctor_user_id === actorId;
      if (!isParticipant && actorRole !== 'admin') {
        throw forbidden('Only a participant or an administrator can cancel this consultation');
      }

      if (['completed', 'cancelled'].includes(consultation.status)) {
        throw conflict(`Cannot cancel a ${consultation.status} consultation`, 'INVALID_STATE');
      }

      await query(
        `UPDATE consultations
            SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, updated_at = now()
          WHERE id = $1`,
        [consultationId, reason, actorId],
        client,
      );

      // Clearing consultation_id is what releases uq_slot_consultation and
      // makes the slot bookable again.
      await query(
        `UPDATE availability_slots
            SET status = 'available', consultation_id = NULL,
                hold_token = NULL, held_by = NULL, held_until = NULL,
                version = version + 1
          WHERE id = $1`,
        [consultation.slot_id],
        client,
      );

      await auditInTransaction(
        {
          action: 'booking.cancelled', resourceType: 'consultation', resourceId: consultationId,
          actorId, actorRole, metadata: { reason, previousStatus: consultation.status },
        },
        client,
      );

      // Refund is decided downstream: only a captured payment owes one.
      await enqueue(
        'consultation.cancelled',
        {
          consultationId, reason, cancelledBy: actorId,
          previousStatus: consultation.status, scheduledAt: consultation.scheduled_at,
        },
        client,
      );

      return consultation;
    });

    await cacheDelPrefix(cacheKeys.slotsPrefix(result.doctor_id));
    bookingAttempts.inc({ outcome: 'cancelled' });
    return { consultationId, status: 'cancelled' };
  },

  /**
   * Release holds that were never paid for.
   *
   * This is the saga's compensating transaction. It runs as a scheduled sweep
   * rather than a per-hold timer: timers do not survive a restart, and at this
   * volume there would be tens of thousands of them outstanding.
   */
  async releaseExpiredHolds(batchSize = 500): Promise<number> {
    const released = await withTransaction(async (client) => {
      // Cancel the consultations first so no window exists in which a slot is
      // free while its consultation still claims to be pending payment.
      const { rows } = await query<{ id: string; slot_id: string; doctor_id: string }>(
        `UPDATE consultations
            SET status = 'cancelled',
                cancel_reason = 'Payment not completed before hold expiry',
                updated_at = now()
          WHERE id IN (
            SELECT c.id
              FROM consultations c
              JOIN availability_slots s ON s.id = c.slot_id
             WHERE c.status = 'pending_payment'
               AND s.status = 'held'
               AND s.held_until < now()
             LIMIT $1
          )
          RETURNING id, slot_id, doctor_id`,
        [batchSize],
        client,
      );

      if (rows.length > 0) {
        await query(
          `UPDATE availability_slots
              SET status = 'available', consultation_id = NULL,
                  hold_token = NULL, held_by = NULL, held_until = NULL,
                  version = version + 1
            WHERE id = ANY($1::uuid[])`,
          [rows.map((r) => r.slot_id)],
          client,
        );
      }

      // Holds with no consultation attached (a crash between claim and insert)
      // are swept too, so a slot can never be stranded.
      await query(
        `UPDATE availability_slots
            SET status = 'available', hold_token = NULL, held_by = NULL,
                held_until = NULL, version = version + 1
          WHERE status = 'held' AND held_until < now() AND consultation_id IS NULL`,
        [],
        client,
      );

      return rows;
    });

    for (const doctorId of new Set(released.map((r) => r.doctor_id))) {
      await cacheDelPrefix(cacheKeys.slotsPrefix(doctorId));
    }
    if (released.length > 0) {
      logger.info({ count: released.length }, 'released expired slot holds');
      bookingAttempts.inc({ outcome: 'hold_expired' }, released.length);
    }
    return released.length;
  },
};
