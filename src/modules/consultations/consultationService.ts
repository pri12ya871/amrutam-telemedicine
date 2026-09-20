import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { decryptField, encryptField, type EncryptedValue } from '../../lib/crypto.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { audit, auditInTransaction } from '../audit/auditService.js';
import { enqueue } from '../../jobs/outbox.js';

export const consultationNotesSchema = z.object({
  notes: z.string().min(1).max(10_000),
});

export const listConsultationsSchema = z.object({
  status: z.enum(['pending_payment', 'scheduled', 'in_progress', 'completed', 'cancelled', 'no_show']).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/**
 * Legal state machine for a consultation. Encoded once, checked everywhere, so
 * an invalid transition is impossible rather than merely unlikely.
 *
 *   pending_payment ─► scheduled ─► in_progress ─► completed
 *          │               │              │
 *          └──────► cancelled ◄───────────┘
 *                          └─► no_show
 */
const TRANSITIONS: Record<string, readonly string[]> = {
  pending_payment: ['scheduled', 'cancelled'],
  scheduled: ['in_progress', 'cancelled', 'no_show'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
};

export const canTransition = (from: string, to: string): boolean =>
  (TRANSITIONS[from] ?? []).includes(to);

interface ConsultationRow {
  id: string;
  patient_id: string;
  doctor_id: string;
  doctor_user_id: string;
  status: string;
  mode: string;
  scheduled_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  chief_complaint_enc: EncryptedValue | null;
  notes_enc: EncryptedValue | null;
  created_at: Date;
}

export const consultationService = {
  /**
   * Fetch one consultation, enforcing that the caller is a participant.
   *
   * Authorisation is checked against the *row*, not just the role: a doctor
   * may read consultations, but only their own. Object-level authorisation is
   * OWASP API #1 and the single most common way health data leaks.
   */
  async getById(consultationId: string, actorId: string, actorRole: string) {
    const { rows } = await query<ConsultationRow>(
      `SELECT c.id, c.patient_id, c.doctor_id, d.user_id AS doctor_user_id,
              c.status, c.mode, c.scheduled_at, c.started_at, c.ended_at,
              c.chief_complaint_enc, c.notes_enc, c.created_at
         FROM consultations c
         JOIN doctors d ON d.id = c.doctor_id
        WHERE c.id = $1`,
      [consultationId],
    );
    const row = rows[0];
    if (!row) throw notFound('Consultation');

    const isParticipant = row.patient_id === actorId || row.doctor_user_id === actorId;
    if (!isParticipant && actorRole !== 'admin') {
      // 404 rather than 403: confirming that an id exists is itself a leak.
      await audit({
        action: 'consultation.read', resourceType: 'consultation', resourceId: consultationId,
        outcome: 'denied',
      });
      throw notFound('Consultation');
    }

    // Reads of clinical data are audited, not just writes.
    await audit({
      action: 'consultation.read', resourceType: 'consultation', resourceId: consultationId,
      metadata: { participantRole: row.patient_id === actorId ? 'patient' : 'doctor' },
    });

    return {
      id: row.id,
      status: row.status,
      mode: row.mode,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      doctorId: row.doctor_id,
      patientId: row.patient_id,
      chiefComplaint: decryptField<string>(row.chief_complaint_enc),
      // Clinical notes are the doctor's record; patients see them through the
      // prescription, which is the reviewed, shareable artefact.
      notes: actorId === row.doctor_user_id || actorRole === 'admin'
        ? decryptField<string>(row.notes_enc)
        : undefined,
    };
  },

  async listForUser(actorId: string, role: string, filters: z.infer<typeof listConsultationsSchema>) {
    const params: unknown[] = [actorId];
    const scope = role === 'doctor'
      ? `d.user_id = $1`
      : `c.patient_id = $1`;

    const where = [scope];
    const bind = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    if (filters.status) where.push(`c.status = ${bind(filters.status)}::consultation_status`);
    if (filters.from) where.push(`c.scheduled_at >= ${bind(filters.from)}::date`);
    if (filters.to) where.push(`c.scheduled_at < ${bind(filters.to)}::date + interval '1 day'`);

    const limit = bind(filters.limit);
    const offset = bind(filters.offset);

    const { rows } = await query(
      `SELECT c.id, c.status, c.mode, c.scheduled_at, c.doctor_id, c.patient_id,
              p.full_name AS counterpart_name
         FROM consultations c
         JOIN doctors  d ON d.id = c.doctor_id
         JOIN profiles p ON p.user_id = ${role === 'doctor' ? 'c.patient_id' : 'd.user_id'}
        WHERE ${where.join(' AND ')}
        ORDER BY c.scheduled_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
    return { items: rows, limit: filters.limit, offset: filters.offset };
  },

  /** Generic guarded transition — the only way status ever changes. */
  async transition(consultationId: string, to: string, actorId: string, actorRole: string) {
    return withTransaction(async (client) => {
      const { rows } = await query<{ status: string; doctor_user_id: string; patient_id: string }>(
        `SELECT c.status, c.patient_id, d.user_id AS doctor_user_id
           FROM consultations c JOIN doctors d ON d.id = c.doctor_id
          WHERE c.id = $1
          FOR UPDATE OF c`,
        [consultationId],
        client,
      );
      const current = rows[0];
      if (!current) throw notFound('Consultation');

      // Only the doctor drives the clinical lifecycle.
      if (current.doctor_user_id !== actorId && actorRole !== 'admin') {
        throw forbidden('Only the attending doctor can change consultation state');
      }
      if (!canTransition(current.status, to)) {
        throw conflict(`Cannot move a consultation from ${current.status} to ${to}`, 'INVALID_TRANSITION');
      }

      const timestampColumn =
        to === 'in_progress' ? ', started_at = now()' : to === 'completed' ? ', ended_at = now()' : '';

      await query(
        `UPDATE consultations
            SET status = $2::consultation_status, updated_at = now() ${timestampColumn}
          WHERE id = $1`,
        [consultationId, to],
        client,
      );

      await auditInTransaction(
        {
          action: `consultation.${to}`, resourceType: 'consultation', resourceId: consultationId,
          actorId, actorRole, metadata: { from: current.status, to },
        },
        client,
      );

      if (to === 'completed') {
        await enqueue('consultation.completed', { consultationId, patientId: current.patient_id }, client);
      }

      return { id: consultationId, status: to };
    });
  },

  /** Doctor-authored clinical notes. Encrypted before they reach the disk. */
  async saveNotes(consultationId: string, doctorUserId: string, notes: string) {
    const result = await query(
      `UPDATE consultations c
          SET notes_enc = $3, updated_at = now()
         FROM doctors d
        WHERE c.id = $1
          AND d.id = c.doctor_id
          AND d.user_id = $2
          AND c.status IN ('scheduled','in_progress','completed')`,
      [consultationId, doctorUserId, JSON.stringify(encryptField(notes))],
    );
    if (result.rowCount === 0) throw notFound('Consultation you can annotate');

    await audit({
      action: 'consultation.notes_updated', resourceType: 'consultation', resourceId: consultationId,
      // Length only. The note itself belongs in exactly one place.
      metadata: { noteLength: notes.length },
    });
  },
};
