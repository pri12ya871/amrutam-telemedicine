import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import type { Express } from 'express';
import {
  databaseAvailable, prepareDatabase, registerAndLogin, uniqueEmail, STRONG_PASSWORD,
} from './helpers.ts';
import { closePool, query } from '../../src/db/pool.ts';
import { closeCache } from '../../src/cache/redis.ts';
import { totp } from '../../src/lib/totp.ts';

describe('authentication', async () => {
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

  it('rejects a weak password at registration', async () => {
    const response = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail('weak'), password: 'short', fullName: 'Weak Password' })
      .expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('refuses to self-register an admin', async () => {
    await request(app)
      .post('/api/v1/auth/register')
      .send({
        email: uniqueEmail('escalate'), password: STRONG_PASSWORD,
        fullName: 'Privilege Escalation', role: 'admin',
      })
      .expect(400);
  });

  it('never stores the password in recoverable form', async () => {
    const user = await registerAndLogin(app, 'patient', 'hashcheck');
    const { rows } = await query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE email = $1`,
      [user.email],
    );
    assert.ok(!rows[0]!.password_hash.includes(STRONG_PASSWORD));
    assert.match(rows[0]!.password_hash, /^scrypt\$/);
  });

  it('gives the same error for a wrong password and an unknown account', async () => {
    const user = await registerAndLogin(app, 'patient', 'enum');

    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: 'definitely-the-wrong-one' })
      .expect(401);

    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail('ghost'), password: 'definitely-the-wrong-one' })
      .expect(401);

    assert.equal(wrongPassword.body.error.message, unknownUser.body.error.message);
    assert.equal(wrongPassword.body.error.code, unknownUser.body.error.code);
  });

  it('rejects a request with no token, a malformed token and a forged token', async () => {
    await request(app).get('/api/v1/auth/me').expect(401);
    await request(app).get('/api/v1/auth/me').set('authorization', 'Bearer not.a.jwt').expect(401);
    await request(app)
      .get('/api/v1/auth/me')
      .set('authorization', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.')
      .expect(401);
  });

  /**
   * Refresh-token rotation with reuse detection. This is the behaviour that
   * turns a stolen refresh token from a permanent foothold into a single
   * short-lived session that gets revoked the moment the real user returns.
   */
  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const user = await registerAndLogin(app, 'patient', 'rotate');

    const rotated = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(200);

    const newRefresh: string = rotated.body.data.refreshToken;
    assert.notEqual(newRefresh, user.refreshToken, 'refresh token was not rotated');

    // Replaying the old token: the server cannot tell the thief from the
    // victim, so it invalidates everything.
    const reused = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: user.refreshToken })
      .expect(401);
    assert.match(reused.body.error.message, /reuse detected/i);

    // The successor is now dead too — that is the point.
    await request(app).post('/api/v1/auth/refresh').send({ refreshToken: newRefresh }).expect(401);

    const { rows } = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [user.id],
    );
    assert.equal(rows[0]!.count, 0, 'the whole token family should be revoked');
  });

  it('locks an account after repeated failed logins', async () => {
    const email = uniqueEmail('lockout');
    await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: STRONG_PASSWORD, fullName: 'Lock Me' })
      .expect(201);

    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-here' });
    }

    // Even the correct password is refused while the lock holds.
    const locked = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: STRONG_PASSWORD });
    assert.equal(locked.status, 403);
  });

  it('completes TOTP enrolment and then demands the code at login', async () => {
    const user = await registerAndLogin(app, 'patient', 'mfa');

    const setup = await request(app)
      .post('/api/v1/auth/mfa/setup')
      .set('authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    const secret: string = setup.body.data.secret;
    assert.ok(setup.body.data.otpauthUri.startsWith('otpauth://totp/'));

    await request(app)
      .post('/api/v1/auth/mfa/confirm')
      .set('authorization', `Bearer ${user.accessToken}`)
      .send({ totp: totp(secret) })
      .expect(200);

    // Password alone is no longer enough.
    await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: STRONG_PASSWORD })
      .expect(401);

    const withCode = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: user.email, password: STRONG_PASSWORD, totp: totp(secret) })
      .expect(200);
    assert.ok(withCode.body.data.accessToken);
  });

  it('records an audit row for a successful login', async () => {
    const user = await registerAndLogin(app, 'patient', 'audited');
    const { rows } = await query<{ action: string }>(
      `SELECT action FROM audit_logs
        WHERE resource_id = $1 AND action = 'auth.login' LIMIT 1`,
      [user.id],
    );
    assert.equal(rows[0]?.action, 'auth.login');
  });

  it('refuses to update the audit trail', async () => {
    // The append-only trigger is a compliance control; prove it is armed.
    await assert.rejects(
      query(`UPDATE audit_logs SET action = 'tampered' WHERE id = (SELECT min(id) FROM audit_logs)`),
      /append-only/,
    );
  });
});
