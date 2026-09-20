import { z } from 'zod';
import { query } from '../../db/pool.js';
import { cacheDel, cacheDelPrefix, cacheGet, cacheKeys, cacheSet } from '../../cache/redis.js';
import { canonicalHash } from '../../lib/crypto.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../audit/auditService.js';

export const doctorProfileSchema = z.object({
  registrationNo: z.string().min(3).max(64).trim(),
  specializations: z.array(z.string().min(2).max(64)).min(1).max(10),
  languages: z.array(z.string().min(2).max(32)).min(1).max(10),
  yearsExperience: z.number().int().min(0).max(70),
  consultationFeePaise: z.number().int().min(0).max(10_000_000),
  city: z.string().min(2).max(80).optional(),
  bio: z.string().max(2000).optional(),
});

/**
 * Search filters.
 *
 * `sort` is an enum rather than a free string. The sort column has to be
 * interpolated into the SQL — it cannot be a bind parameter — so the only safe
 * form is a closed set validated before it reaches the query builder. See the
 * SORT_COLUMNS map below.
 */
export const doctorSearchSchema = z.object({
  q: z.string().max(100).optional(),
  specialization: z.string().max(64).optional(),
  language: z.string().max(32).optional(),
  city: z.string().max(80).optional(),
  minExperience: z.coerce.number().int().min(0).max(70).optional(),
  maxFeePaise: z.coerce.number().int().min(0).optional(),
  sort: z.enum(['rating', 'fee_asc', 'fee_desc', 'experience']).default('rating'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// The only values that can ever reach the ORDER BY clause. Not user input —
// a lookup keyed by user input, which is the difference between safe and a
// SQL injection.
const SORT_COLUMNS: Record<string, string> = {
  rating: 'd.rating DESC, d.rating_count DESC',
  fee_asc: 'd.consultation_fee_paise ASC',
  fee_desc: 'd.consultation_fee_paise DESC',
  experience: 'd.years_experience DESC',
};

export const doctorService = {
  async createProfile(userId: string, input: z.infer<typeof doctorProfileSchema>) {
    const existing = await query(`SELECT 1 FROM doctors WHERE user_id = $1`, [userId]);
    if (existing.rowCount! > 0) throw conflict('Doctor profile already exists', 'PROFILE_EXISTS');

    const { rows } = await query<{ id: string; status: string }>(
      `INSERT INTO doctors
         (user_id, registration_no, specializations, languages,
          years_experience, consultation_fee_paise, city, bio)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, status`,
      [
        userId, input.registrationNo, input.specializations, input.languages,
        input.yearsExperience, input.consultationFeePaise, input.city ?? null, input.bio ?? null,
      ],
    );

    await cacheDelPrefix(cacheKeys.searchPrefix());
    await audit({
      action: 'doctor.profile_created', resourceType: 'doctor', resourceId: rows[0]!.id,
      metadata: { specializations: input.specializations },
    });
    // Deliberately created as pending_verification: a medical registration
    // number is checked by a human before the doctor becomes bookable.
    return rows[0]!;
  },

  async verify(doctorId: string, adminId: string) {
    const result = await query(
      `UPDATE doctors SET status = 'active', updated_at = now()
        WHERE id = $1 AND status = 'pending_verification'`,
      [doctorId],
    );
    if (result.rowCount === 0) throw notFound('Doctor pending verification');

    await cacheDel(cacheKeys.doctor(doctorId));
    await cacheDelPrefix(cacheKeys.searchPrefix());
    await audit({
      action: 'doctor.verified', resourceType: 'doctor', resourceId: doctorId, actorId: adminId,
    });
  },

  async getById(doctorId: string) {
    const key = cacheKeys.doctor(doctorId);
    const cached = await cacheGet<Record<string, unknown>>(key);
    if (cached) return cached;

    const { rows } = await query(
      `SELECT d.id, d.specializations, d.languages, d.years_experience,
              d.consultation_fee_paise, d.city, d.bio, d.rating, d.rating_count, d.status,
              p.full_name
         FROM doctors d
         JOIN profiles p ON p.user_id = d.user_id
        WHERE d.id = $1`,
      [doctorId],
    );
    const doctor = rows[0];
    if (!doctor) throw notFound('Doctor');

    // 5 minutes: doctor profiles change rarely, and every write path here
    // invalidates the key explicitly.
    await cacheSet(key, doctor, 300);
    return doctor;
  },

  /**
   * Search with filters.
   *
   * Every value is bound; only the ORDER BY fragment is interpolated, and only
   * from SORT_COLUMNS. Results are cached for 60s keyed by a hash of the
   * normalised filter set, which is what keeps the listing page off the
   * database during a traffic spike.
   */
  async search(filters: z.infer<typeof doctorSearchSchema>) {
    const cacheKey = cacheKeys.doctorSearch(canonicalHash(filters));
    const cached = await cacheGet<{ items: unknown[]; total: number }>(cacheKey);
    if (cached) return cached;

    const where: string[] = [`d.status = 'active'`];
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };

    if (filters.specialization) where.push(`d.specializations && ARRAY[${bind(filters.specialization)}]::text[]`);
    if (filters.language) where.push(`d.languages && ARRAY[${bind(filters.language)}]::text[]`);
    if (filters.city) where.push(`lower(d.city) = lower(${bind(filters.city)})`);
    if (filters.minExperience !== undefined) where.push(`d.years_experience >= ${bind(filters.minExperience)}`);
    if (filters.maxFeePaise !== undefined) where.push(`d.consultation_fee_paise <= ${bind(filters.maxFeePaise)}`);
    if (filters.q) {
      const q = bind(`%${filters.q}%`);
      where.push(`(p.full_name ILIKE ${q} OR d.bio ILIKE ${q})`);
    }

    const whereClause = where.join(' AND ');
    const orderBy = SORT_COLUMNS[filters.sort] ?? SORT_COLUMNS.rating!;

    const limitParam = bind(filters.limit);
    const offsetParam = bind(filters.offset);

    const { rows } = await query(
      `SELECT d.id, d.specializations, d.languages, d.years_experience,
              d.consultation_fee_paise, d.city, d.rating, d.rating_count,
              p.full_name,
              count(*) OVER() AS total_count
         FROM doctors d
         JOIN profiles p ON p.user_id = d.user_id
        WHERE ${whereClause}
        ORDER BY ${orderBy}
        LIMIT ${limitParam} OFFSET ${offsetParam}`,
      params,
    );

    const total = rows.length > 0 ? Number(rows[0]!.total_count) : 0;
    const result = {
      items: rows.map(({ total_count, ...rest }) => rest),
      total,
      limit: filters.limit,
      offset: filters.offset,
    };

    await cacheSet(cacheKey, result, 60);
    return result;
  },
};
