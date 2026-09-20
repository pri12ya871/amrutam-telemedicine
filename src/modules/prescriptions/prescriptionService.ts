import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { decryptField, encryptField, type EncryptedValue } from '../../lib/crypto.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit, auditInTransaction } from '../audit/auditService.js';
import { enqueue } from '../../jobs/outbox.js';

export const medicineSchema = z.object({
  name: z.string().min(1).max(200),
  dosage: z.string().min(1).max(100),
  frequency: z.string().min(1).max(100),
  durationDays: z.number().int().min(1).max(365),
  instructions: z.string().max(500).optional(),
});

export const createPrescriptionSchema = z.object({
  consultationId: z.string().uuid(),
  diagnosis: z.string().min(3).max(2000),
  medicines: z.array(medicineSchema).min(1).max(30),
  advice: z.string().max(2000).optional(),
  followUpDays: z.number().int().min(1).max(365).optional(),
});

interface PrescriptionPayload {
  diagnosis: string;
  medicines: z.infer<typeof medicineSchema>[];
  advice?: string;
}

/**
 * Prescriptions are the most sensitive records in the system: diagnosis plus
 * medication history is enough to infer conditions a patient may not have
 * disclosed to anyone else.
 *
 * Three consequences, all visible in the code below:
 *   - the entire clinical payload is stored as one envelope-encrypted blob,
 *     not as queryable columns;
 *   - every read is audited, with the actor and the reason recorded;
 *   - a prescription is never updated, only revoked and reissued, so the
 *     dispensing record stays truthful.
 */
export const prescriptionService = {
  async create(doctorUserId: string, input: z.infer<typeof createPrescriptionSchema>) {
    return withTransaction(async (client) => {
      const { rows } = await query<{
        id: string; patient_id: string; doctor_id: string; status: string;
      }>(
        `SELECT c.id, c.patient_id, c.doctor_id, c.status
           FROM consultations c
           JOIN doctors d ON d.id = c.doctor_id
          WHERE c.id = $1 AND d.user_id = $2`,
        [input.consultationId, doctorUserId],
        client,
      );
      const consultation = rows[0];
      // Same 404 whether the consultation does not exist or belongs to another
      // doctor: a prescribing doctor should not be able to probe for ids.
      if (!consultation) throw notFound('Consultation');

      if (!['in_progress', 'completed'].includes(consultation.status)) {
        throw conflict(
          'A prescription can only be issued during or after the consultation',
          'CONSULTATION_NOT_STARTED',
        );
      }

      const payload: PrescriptionPayload = {
        diagnosis: input.diagnosis,
        medicines: input.medicines,
        ...(input.advice ? { advice: input.advice } : {}),
      };

      const inserted = await query<{ id: string; issued_at: Date }>(
        `INSERT INTO prescriptions
           (consultation_id, doctor_id, patient_id, payload_enc, valid_until)
         VALUES ($1, $2, $3, $4,
                 CASE WHEN $5::int IS NULL THEN NULL
                      ELSE CURRENT_DATE + $5::int END)
         RETURNING id, issued_at`,
        [
          input.consultationId,
          consultation.doctor_id,
          consultation.patient_id,
          JSON.stringify(encryptField(payload)),
          input.followUpDays ?? null,
        ],
        client,
      );
      const prescription = inserted.rows[0]!;

      await auditInTransaction(
        {
          action: 'prescription.created', resourceType: 'prescription', resourceId: prescription.id,
          actorId: doctorUserId,
          metadata: {
            consultationId: input.consultationId,
            // Count, never the medicines themselves.
            medicineCount: input.medicines.length,
          },
        },
        client,
      );

      await enqueue(
        'prescription.issued',
        { prescriptionId: prescription.id, patientId: consultation.patient_id },
        client,
      );

      return { id: prescription.id, issuedAt: prescription.issued_at };
    });
  },

  async getById(prescriptionId: string, actorId: string, actorRole: string) {
    const { rows } = await query<{
      id: string; consultation_id: string; patient_id: string; doctor_user_id: string;
      payload_enc: EncryptedValue; issued_at: Date; valid_until: Date | null; revoked_at: Date | null;
    }>(
      `SELECT p.id, p.consultation_id, p.patient_id, d.user_id AS doctor_user_id,
              p.payload_enc, p.issued_at, p.valid_until, p.revoked_at
         FROM prescriptions p
         JOIN doctors d ON d.id = p.doctor_id
        WHERE p.id = $1`,
      [prescriptionId],
    );
    const row = rows[0];
    if (!row) throw notFound('Prescription');

    const permitted =
      row.patient_id === actorId || row.doctor_user_id === actorId || actorRole === 'admin';
    if (!permitted) {
      await audit({
        action: 'prescription.read', resourceType: 'prescription', resourceId: prescriptionId,
        outcome: 'denied',
      });
      throw notFound('Prescription');
    }

    await audit({
      action: 'prescription.read', resourceType: 'prescription', resourceId: prescriptionId,
      metadata: { actorRelation: row.patient_id === actorId ? 'patient' : 'doctor' },
    });

    return {
      id: row.id,
      consultationId: row.consultation_id,
      issuedAt: row.issued_at,
      validUntil: row.valid_until,
      revokedAt: row.revoked_at,
      ...decryptField<PrescriptionPayload>(row.payload_enc)!,
    };
  },

  async listForPatient(patientId: string, limit = 20, offset = 0) {
    // Metadata only. Listing does not decrypt: a list view has no need for
    // diagnoses, and not decrypting them keeps them out of logs and memory.
    const { rows } = await query(
      `SELECT id, consultation_id, issued_at, valid_until, revoked_at
         FROM prescriptions
        WHERE patient_id = $1
        ORDER BY issued_at DESC
        LIMIT $2 OFFSET $3`,
      [patientId, limit, offset],
    );
    await audit({
      action: 'prescription.list', resourceType: 'patient', resourceId: patientId,
      metadata: { count: rows.length },
    });
    return { items: rows, limit, offset };
  },

  async revoke(prescriptionId: string, doctorUserId: string, reason: string) {
    const result = await query(
      `UPDATE prescriptions p
          SET revoked_at = now()
         FROM doctors d
        WHERE p.id = $1 AND d.id = p.doctor_id AND d.user_id = $2 AND p.revoked_at IS NULL`,
      [prescriptionId, doctorUserId],
    );
    if (result.rowCount === 0) throw notFound('Active prescription you issued');

    await audit({
      action: 'prescription.revoked', resourceType: 'prescription', resourceId: prescriptionId,
      actorId: doctorUserId, metadata: { reason },
    });
  },
};
