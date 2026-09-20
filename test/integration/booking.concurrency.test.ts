import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  createBookableDoctor, databaseAvailable, prepareDatabase, registerAndLogin,
} from './helpers.ts';
import { closePool, query } from '../../src/db/pool.ts';
import { closeCache } from '../../src/cache/redis.ts';

/**
 * The test this whole design exists to pass.
 *
 * Fifty patients race for one slot. Exactly one may end up with a
 * consultation; the other forty-nine must be told the slot is gone. Anything
 * else is a double-booked doctor.
 */
describe('booking under concurrency', async () => {
  const hasDb = await databaseAvailable();
  if (!hasDb) {
    it('skipped — no DATABASE_URL reachable', { skip: true }, () => {});
    return;
  }

  let app: Express;

  before(async () => {
    app = await prepareDatabase();
  });

  after(async () => {
    // Both pools hold open handles; without this the test process never exits.
    await closeCache();
    await closePool();
  });

  it('allows exactly one of 50 simultaneous bookings for the same slot', async () => {
    const { slotId } = await createBookableDoctor(app);

    // Register the patients up front so the race measures the booking path,
    // not fifty password hashes.
    const patients = await Promise.all(
      Array.from({ length: 50 }, (_, i) => registerAndLogin(app, 'patient', `race${i}`)),
    );

    const responses = await Promise.all(
      patients.map((patient) =>
        request(app)
          .post('/api/v1/bookings')
          .set('authorization', `Bearer ${patient.accessToken}`)
          .set('idempotency-key', randomUUID())
          .send({ slotId, mode: 'video' }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicted = responses.filter((r) => r.status === 409);
    const other = responses.filter((r) => r.status !== 201 && r.status !== 409);

    assert.equal(
      other.length, 0,
      `unexpected statuses: ${JSON.stringify(other.map((r) => [r.status, r.body?.error?.code]))}`,
    );
    assert.equal(created.length, 1, `expected exactly 1 winner, got ${created.length}`);
    assert.equal(conflicted.length, 49);
    assert.equal(conflicted[0]!.body.error.code, 'SLOT_UNAVAILABLE');

    // The database must agree with the API. A single live consultation, and
    // the slot bound to exactly that one.
    const consultations = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM consultations
        WHERE slot_id = $1 AND status <> 'cancelled'`,
      [slotId],
    );
    assert.equal(consultations.rows[0]!.count, 1, 'more than one live consultation for the slot');

    const slot = await query<{ status: string; consultation_id: string | null }>(
      `SELECT status, consultation_id FROM availability_slots WHERE id = $1`,
      [slotId],
    );
    assert.equal(slot.rows[0]!.status, 'held');
    assert.equal(slot.rows[0]!.consultation_id, created[0]!.body.data.consultationId);
  });

  it('does not double-book when one patient fires the same slot 20 times', async () => {
    const { slotId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'selfrace');

    // Distinct idempotency keys, so this is a genuine concurrency test rather
    // than an idempotency one: the slot guard alone must hold.
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app)
          .post('/api/v1/bookings')
          .set('authorization', `Bearer ${patient.accessToken}`)
          .set('idempotency-key', randomUUID())
          .send({ slotId, mode: 'video' }),
      ),
    );

    assert.equal(responses.filter((r) => r.status === 201).length, 1);
  });

  it('frees the slot again after cancellation', async () => {
    const { slotId } = await createBookableDoctor(app);
    const first = await registerAndLogin(app, 'patient', 'cancel-first');
    const second = await registerAndLogin(app, 'patient', 'cancel-second');

    const booked = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${first.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);

    // While held, nobody else can take it.
    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${second.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(409);

    await request(app)
      .post(`/api/v1/bookings/${booked.body.data.consultationId}/cancel`)
      .set('authorization', `Bearer ${first.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ reason: 'Changed my mind' })
      .expect(200);

    // Once released, the second patient succeeds.
    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${second.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);
  });

  it('reclaims a slot whose hold expired without payment', async () => {
    const { slotId } = await createBookableDoctor(app);
    const first = await registerAndLogin(app, 'patient', 'expiry-first');
    const second = await registerAndLogin(app, 'patient', 'expiry-second');

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${first.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);

    // Fast-forward the hold rather than waiting five minutes.
    await query(
      `UPDATE availability_slots SET held_until = now() - interval '1 minute' WHERE id = $1`,
      [slotId],
    );

    const { bookingService } = await import('../../src/modules/booking/bookingService.ts');
    const released = await bookingService.releaseExpiredHolds();
    assert.ok(released >= 1, 'sweeper should have released the expired hold');

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${second.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);
  });

  it('refuses to book a slot in the past', async () => {
    const { doctorId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'past');

    const pastStart = new Date(Date.now() - 7_200_000);
    const { rows } = await query<{ id: string }>(
      `INSERT INTO availability_slots (doctor_id, start_at, end_at, status)
       VALUES ($1, $2, $3, 'available') RETURNING id`,
      [doctorId, pastStart, new Date(pastStart.getTime() + 1_800_000)],
    );

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId: rows[0]!.id });

    assert.equal(response.status, 400);
  });
});
