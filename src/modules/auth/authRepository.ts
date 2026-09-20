import type { PoolClient } from 'pg';
import { query, withTransaction, type Queryable } from '../../db/pool.js';
import type { EncryptedValue } from '../../lib/crypto.js';
import type { Role } from './tokens.js';

export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  status: 'active' | 'suspended' | 'deleted';
  mfa_enabled: boolean;
  mfa_secret_enc: EncryptedValue | null;
  failed_logins: number;
  locked_until: Date | null;
}

export interface RefreshRecord {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  used_at: Date | null;
  expires_at: Date;
}

/**
 * Repository: all SQL for this module, and no business rules. Services depend
 * on this interface rather than on `pg`, which is what makes them unit
 * testable with an in-memory fake.
 */
export interface AuthRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  createUser(input: {
    email: string;
    passwordHash: string;
    role: Role;
    fullName: string;
    phoneEnc: EncryptedValue | null;
  }): Promise<{ id: string; email: string; role: Role }>;
  recordFailedLogin(userId: string, lockThreshold: number, lockMinutes: number): Promise<void>;
  clearFailedLogins(userId: string): Promise<void>;
  setMfaSecret(userId: string, secret: EncryptedValue): Promise<void>;
  enableMfa(userId: string): Promise<void>;
  insertRefreshToken(input: {
    userId: string;
    familyId: string;
    tokenHash: string;
    parentId: string | null;
    expiresAt: Date;
    client?: Queryable;
  }): Promise<string>;
  findRefreshByHash(tokenHash: string): Promise<RefreshRecord | null>;
  markRefreshUsed(id: string, client?: Queryable): Promise<void>;
  revokeFamily(familyId: string, client?: Queryable): Promise<number>;
}

export const authRepository: AuthRepository = {
  async findByEmail(email) {
    const { rows } = await query<UserRecord>(
      `SELECT id, email, password_hash, role, status, mfa_enabled,
              mfa_secret_enc, failed_logins, locked_until
         FROM users WHERE email = $1 AND status <> 'deleted'`,
      [email],
    );
    return rows[0] ?? null;
  },

  async findById(id) {
    const { rows } = await query<UserRecord>(
      `SELECT id, email, password_hash, role, status, mfa_enabled,
              mfa_secret_enc, failed_logins, locked_until
         FROM users WHERE id = $1 AND status <> 'deleted'`,
      [id],
    );
    return rows[0] ?? null;
  },

  async createUser({ email, passwordHash, role, fullName, phoneEnc }) {
    // One transaction: a user without a profile is not a valid state, and
    // leaving that to two independent statements makes it reachable.
    return withTransaction(async (client) => {
      const { rows } = await query<{ id: string; email: string; role: Role }>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ($1, $2, $3) RETURNING id, email, role`,
        [email, passwordHash, role],
        client,
      );
      const user = rows[0]!;
      await query(
        `INSERT INTO profiles (user_id, full_name, phone_enc) VALUES ($1, $2, $3)`,
        [user.id, fullName, phoneEnc ? JSON.stringify(phoneEnc) : null],
        client,
      );
      return user;
    });
  },

  async recordFailedLogin(userId, lockThreshold, lockMinutes) {
    // Lock decided in SQL so concurrent failed attempts cannot both read the
    // same pre-increment count and neither trip the threshold.
    await query(
      `UPDATE users
          SET failed_logins = failed_logins + 1,
              locked_until = CASE
                WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval
                ELSE locked_until END
        WHERE id = $1`,
      [userId, lockThreshold, lockMinutes],
    );
  },

  async clearFailedLogins(userId) {
    await query(
      `UPDATE users SET failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1`,
      [userId],
    );
  },

  async setMfaSecret(userId, secret) {
    await query(`UPDATE users SET mfa_secret_enc = $2, updated_at = now() WHERE id = $1`, [
      userId,
      JSON.stringify(secret),
    ]);
  },

  async enableMfa(userId) {
    await query(`UPDATE users SET mfa_enabled = true, updated_at = now() WHERE id = $1`, [userId]);
  },

  async insertRefreshToken({ userId, familyId, tokenHash, parentId, expiresAt, client }) {
    const { rows } = await query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, parent_id, expires_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [userId, familyId, tokenHash, parentId, expiresAt],
      client,
    );
    return rows[0]!.id;
  },

  async findRefreshByHash(tokenHash) {
    const { rows } = await query<RefreshRecord>(
      `SELECT id, user_id, family_id, revoked_at, used_at, expires_at
         FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    return rows[0] ?? null;
  },

  async markRefreshUsed(id, client) {
    await query(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [id], client);
  },

  async revokeFamily(familyId, client) {
    const result = await query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId],
      client,
    );
    return result.rowCount ?? 0;
  },
};

export type { PoolClient };
