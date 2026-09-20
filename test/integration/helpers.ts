import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../../src/app.ts';
import { migrate } from '../../src/db/migrate.ts';
import { pool, query } from '../../src/db/pool.ts';
import { markMigrationsApplied } from '../../src/lib/readiness.ts';

/**
 * Integration tests need a real Postgres: the behaviour under test *is* the
 * database's concurrency control, and a mock would only test the mock.
 *
 * When no database is reachable the suites skip rather than fail, so a clean
 * clone can run `npm test` with nothing installed. CI always has one (see
 * .github/workflows/ci.yml), so the skip can never silently hide a
 * regression there.
 */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

let prepared = false;

export async function prepareDatabase(): Promise<Express> {
  if (!prepared) {
    await migrate();
    markMigrationsApplied();
    prepared = true;
  }
  return createApp();
}

/** Every test run gets its own email space, so runs cannot collide. */
export const uniqueEmail = (prefix: string) => `${prefix}-${randomUUID()}@example.test`;

export const STRONG_PASSWORD = 'a-long-enough-test-password-99';

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerAndLogin(
  app: Express,
  role: 'patient' | 'doctor',
  emailPrefix: string = role,
): Promise<TestUser> {
  const email = uniqueEmail(emailPrefix);

  const registered = await request(app)
    .post('/api/v1/auth/register')
    .send({ email, password: STRONG_PASSWORD, fullName: `Test ${role}`, role })
    .expect(201);

  const loggedIn = await request(app)
    .post('/api/v1/auth/login')
    .send({ email, password: STRONG_PASSWORD })
    .expect(200);

  return {
    id: registered.body.data.id,
    email,
    accessToken: loggedIn.body.data.accessToken,
    refreshToken: loggedIn.body.data.refreshToken,
  };
}

/**
 * A verified doctor with one bookable slot. Verification is forced directly in
 * SQL because the API route requires an MFA-enrolled admin, which is a
 * different test's subject.
 */
export async function createBookableDoctor(
  app: Express,
  feePaise = 50_000,
): Promise<{ doctor: TestUser; doctorId: string; slotId: string }> {
  const doctor = await registerAndLogin(app, 'doctor');

  const profile = await request(app)
    .post('/api/v1/doctors/profile')
    .set('authorization', `Bearer ${doctor.accessToken}`)
    .send({
      registrationNo: `REG-${randomUUID().slice(0, 12)}`,
      specializations: ['Ayurveda', 'General Medicine'],
      languages: ['English', 'Hindi'],
      yearsExperience: 8,
      consultationFeePaise: feePaise,
      city: 'Bengaluru',
    })
    .expect(201);

  const doctorId: string = profile.body.data.id;
  await query(`UPDATE doctors SET status = 'active' WHERE id = $1`, [doctorId]);

  // A slot inserted directly, an hour out: rule expansion is covered by its
  // own test and is not what the booking tests are about.
  const startAt = new Date(Date.now() + 3_600_000);
  const { rows } = await query<{ id: string }>(
    `INSERT INTO availability_slots (doctor_id, start_at, end_at, status)
     VALUES ($1, $2, $3, 'available') RETURNING id`,
    [doctorId, startAt, new Date(startAt.getTime() + 1_800_000)],
  );

  return { doctor, doctorId, slotId: rows[0]!.id };
}

export const authed = (app: Express, method: 'post' | 'get' | 'put', path: string, token: string) =>
  request(app)[method](path).set('authorization', `Bearer ${token}`);
