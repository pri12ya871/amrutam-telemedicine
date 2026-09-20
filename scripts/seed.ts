import { randomUUID } from 'node:crypto';
import { closePool, query } from '../src/db/pool.ts';
import { migrate } from '../src/db/migrate.ts';
import { encryptField, hashPassword } from '../src/lib/crypto.ts';
import { generateSecret, totp } from '../src/lib/totp.ts';
import { availabilityService } from '../src/modules/availability/availabilityService.ts';

/**
 * Demo data. Enough to exercise every flow end to end — including an
 * MFA-enrolled admin, which is otherwise impossible to reach through the API
 * without a second device.
 *
 * Idempotent: re-running updates the same accounts rather than failing on the
 * unique email constraint.
 */

const PASSWORD = 'amrutam-demo-password-2026';

const SPECIALISATIONS = [
  ['Ayurveda', 'Panchakarma'],
  ['General Medicine', 'Internal Medicine'],
  ['Dermatology', 'Ayurveda'],
  ['Paediatrics'],
  ['Gynaecology', 'Ayurveda'],
  ['Orthopaedics'],
];
const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Pune', 'Jaipur', 'Kochi'];
const LANGUAGES = [
  ['English', 'Hindi'],
  ['English', 'Kannada'],
  ['Hindi', 'Marathi'],
  ['English', 'Tamil'],
  ['English', 'Hindi', 'Gujarati'],
  ['Malayalam', 'English'],
];

async function upsertUser(
  email: string,
  role: 'patient' | 'doctor' | 'admin',
  fullName: string,
  mfaSecret?: string,
): Promise<string> {
  const passwordHash = await hashPassword(PASSWORD);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO users (email, password_hash, role, mfa_enabled, mfa_secret_enc)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           mfa_enabled = EXCLUDED.mfa_enabled,
           mfa_secret_enc = EXCLUDED.mfa_secret_enc
     RETURNING id`,
    [
      email, passwordHash, role,
      Boolean(mfaSecret),
      mfaSecret ? JSON.stringify(encryptField(mfaSecret)) : null,
    ],
  );
  const id = rows[0]!.id;

  await query(
    `INSERT INTO profiles (user_id, full_name, city)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [id, fullName, CITIES[Math.floor(Math.random() * CITIES.length)]],
  );
  return id;
}

async function main(): Promise<void> {
  await migrate();

  // The admin is seeded with MFA already enrolled, because every admin route
  // requires it and there is no way to bootstrap that through the API alone.
  const adminSecret = generateSecret();
  await upsertUser('admin@amrutam.test', 'admin', 'Platform Admin', adminSecret);

  const doctorIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const userId = await upsertUser(`doctor${i + 1}@amrutam.test`, 'doctor', `Dr. Demo ${i + 1}`);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO doctors
         (user_id, registration_no, specializations, languages,
          years_experience, consultation_fee_paise, city, bio, rating, rating_count, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active')
       ON CONFLICT (user_id) DO UPDATE
         SET specializations = EXCLUDED.specializations, status = 'active'
       RETURNING id`,
      [
        userId,
        `KMC-${10_000 + i}`,
        SPECIALISATIONS[i % SPECIALISATIONS.length],
        LANGUAGES[i % LANGUAGES.length],
        3 + i * 2,
        (400 + i * 150) * 100,
        CITIES[i % CITIES.length],
        `Demo practitioner ${i + 1}. Seeded data, not a real clinician.`,
        (3.8 + i * 0.2).toFixed(2),
        20 + i * 15,
      ],
    );
    doctorIds.push(rows[0]!.id);
  }

  for (let i = 0; i < 4; i++) {
    await upsertUser(`patient${i + 1}@amrutam.test`, 'patient', `Demo Patient ${i + 1}`);
  }

  // Weekday availability, then materialise the next fortnight so the search
  // and booking demos have something to book.
  const today = new Date();
  const fortnight = new Date(today.getTime() + 14 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  let slotTotal = 0;
  for (const doctorId of doctorIds) {
    for (const weekday of [1, 2, 3, 4, 5]) {
      await query(
        `INSERT INTO availability_rules (doctor_id, weekday, start_time, end_time, slot_minutes)
         VALUES ($1, $2, '09:00', '17:00', 30)
         ON CONFLICT DO NOTHING`,
        [doctorId, weekday],
      );
    }
    slotTotal += await availabilityService.generateSlots(doctorId, iso(today), iso(fortnight));
  }

  console.log(`
Seed complete.

  Admin     admin@amrutam.test
  Doctors   doctor1..6@amrutam.test   (verified and bookable)
  Patients  patient1..4@amrutam.test
  Password  ${PASSWORD}

  Slots created: ${slotTotal}

  The admin has MFA enrolled. Current code: ${totp(adminSecret)}
  TOTP secret (demo only): ${adminSecret}

  A code is valid for 30 seconds — regenerate with:
    node --import tsx -e "import('./src/lib/totp.ts').then(m=>console.log(m.totp('${adminSecret}')))"
`);

  await query(
    `INSERT INTO audit_logs (action, resource_type, resource_id, metadata)
     VALUES ('system.seed', 'system', $1, '{"source":"scripts/seed.ts"}'::jsonb)`,
    [randomUUID()],
  );
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
