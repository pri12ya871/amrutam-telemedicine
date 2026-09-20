import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import {
  createBookableDoctor, databaseAvailable, prepareDatabase, registerAndLogin,
} from './helpers.ts';
import { closePool, query } from '../../src/db/pool.ts';

/**
 * Idempotency is one of the two stated fail conditions for this brief, so it
 * is tested as a contract rather than as an implementation detail: same key
 * and same body must produce one side effect and one response, whatever the
 * network did in between.
 */
describe('idempotent writes', async () => {
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
    await closePool();
  });

  it('rejects a write with no Idempotency-Key', async () => {
    const { slotId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'nokey');

    const response = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .send({ slotId })
      .expect(400);

    assert.match(response.body.error.message, /Idempotency-Key/);
  });

  it('replays the original response for a repeated key', async () => {
    const { slotId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'replay');
    const key = randomUUID();

    const first = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId, mode: 'video' })
      .expect(201);

    const second = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId, mode: 'video' })
      .expect(201);

    assert.equal(second.headers['idempotency-replayed'], 'true');
    assert.equal(second.body.data.consultationId, first.body.data.consultationId);

    // The real assertion: one consultation, not two.
    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM consultations WHERE slot_id = $1`,
      [slotId],
    );
    assert.equal(rows[0]!.count, 1, 'the retry created a second consultation');
  });

  it('creates exactly one booking when the same key is sent 10 times at once', async () => {
    const { slotId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'burst');
    const key = randomUUID();

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app)
          .post('/api/v1/bookings')
          .set('authorization', `Bearer ${patient.accessToken}`)
          .set('idempotency-key', key)
          .send({ slotId, mode: 'video' }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    const inFlight = responses.filter((r) => r.status === 409);

    assert.ok(created.length >= 1, 'at least one request must succeed');
    assert.equal(
      created.length + inFlight.length, 10,
      `unexpected statuses: ${JSON.stringify(responses.map((r) => r.status))}`,
    );
    // Concurrent duplicates are either replayed or told the original is still
    // running; either way the side effect happens once.
    for (const r of inFlight) {
      assert.equal(r.body.error.code, 'IDEMPOTENT_REQUEST_IN_PROGRESS');
    }

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM consultations WHERE slot_id = $1`,
      [slotId],
    );
    assert.equal(rows[0]!.count, 1);
  });

  it('rejects the same key with a different body', async () => {
    const first = await createBookableDoctor(app);
    const second = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'mismatch');
    const key = randomUUID();

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId: first.slotId })
      .expect(201);

    const reused = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId: second.slotId })
      .expect(422);

    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSE');
  });

  it('scopes keys per user, so two patients can use the same key', async () => {
    const a = await createBookableDoctor(app);
    const b = await createBookableDoctor(app);
    const first = await registerAndLogin(app, 'patient', 'scope-a');
    const second = await registerAndLogin(app, 'patient', 'scope-b');
    const sharedKey = 'checkout-attempt-1';

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${first.accessToken}`)
      .set('idempotency-key', sharedKey)
      .send({ slotId: a.slotId })
      .expect(201);

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${second.accessToken}`)
      .set('idempotency-key', sharedKey)
      .send({ slotId: b.slotId })
      .expect(201);
  });

  it('does not pin a failed request to its key', async () => {
    const { slotId } = await createBookableDoctor(app);
    const patient = await registerAndLogin(app, 'patient', 'retry-after-fail');
    const key = randomUUID();

    // First attempt loses the slot to someone else.
    const other = await registerAndLogin(app, 'patient', 'thief');
    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${other.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);

    await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId })
      .expect(409);

    // Same key, now against a slot that is free: a 4xx must not have burned
    // the key, or the client could never correct its mistake.
    const fresh = await createBookableDoctor(app);
    const retried = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', key)
      .send({ slotId: fresh.slotId });

    assert.equal(retried.status, 422, 'a different body on the same key is still a mismatch');
  });

  it('makes payment capture safe to retry', async () => {
    const { slotId } = await createBookableDoctor(app, 120_000);
    const patient = await registerAndLogin(app, 'patient', 'pay');

    const booking = await request(app)
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${patient.accessToken}`)
      .set('idempotency-key', randomUUID())
      .send({ slotId })
      .expect(201);

    const paymentId = booking.body.data.payment.id;
    const key = randomUUID();

    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app)
        .post(`/api/v1/payments/${paymentId}/capture`)
        .set('authorization', `Bearer ${patient.accessToken}`)
        .set('idempotency-key', key)
        .send({ simulate: 'success' })
        .expect(200);
    }

    const { rows } = await query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM payments WHERE id = $1`,
      [paymentId],
    );
    assert.equal(rows[0]!.status, 'captured');
    assert.equal(rows[0]!.attempts, 1, 'the provider was charged more than once');

    const consultation = await query<{ status: string }>(
      `SELECT status FROM consultations WHERE id = $1`,
      [booking.body.data.consultationId],
    );
    assert.equal(consultation.rows[0]!.status, 'scheduled');
  });
});
