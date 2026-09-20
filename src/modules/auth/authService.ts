import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { withTransaction } from '../../db/pool.js';
import {
  encryptField, decryptField, hashPassword, verifyPassword, newToken, sha256,
} from '../../lib/crypto.js';
import { generateSecret, otpauthUri, verifyTotp } from '../../lib/totp.js';
import { conflict, forbidden, unauthorized, badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { authEvents } from '../../telemetry/metrics.js';
import { audit } from '../audit/auditService.js';
import type { AuthRepository } from './authRepository.js';
import { signAccessToken, type Role } from './tokens.js';
import type { LoginInput, RegisterInput } from './authSchemas.js';

const LOCK_THRESHOLD = 5;
const LOCK_MINUTES = 15;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  tokenType: 'Bearer';
}

export interface AuthService {
  register(input: RegisterInput): Promise<{ id: string; email: string; role: Role }>;
  login(input: LoginInput): Promise<TokenPair & { mfaRequired?: boolean }>;
  refresh(token: string): Promise<TokenPair>;
  logout(token: string): Promise<void>;
  beginMfaSetup(userId: string): Promise<{ secret: string; otpauthUri: string }>;
  confirmMfaSetup(userId: string, code: string): Promise<void>;
}

/**
 * Constructed with its dependencies rather than importing them, so tests can
 * substitute a fake repository and the module has no hidden global state.
 */
export function createAuthService(repo: AuthRepository): AuthService {
  async function issueTokens(
    userId: string,
    role: Role,
    mfaSatisfied: boolean,
    familyId: string,
    parentId: string | null,
  ): Promise<TokenPair> {
    const refreshToken = newToken(32);
    const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

    await repo.insertRefreshToken({
      userId,
      familyId,
      // Only the hash is stored: a database dump must not yield usable sessions.
      tokenHash: sha256(refreshToken),
      parentId,
      expiresAt,
    });

    const accessToken = await signAccessToken({ sub: userId, role, mfa: mfaSatisfied, fam: familyId });
    return { accessToken, refreshToken, expiresIn: config.ACCESS_TOKEN_TTL, tokenType: 'Bearer' };
  }

  return {
    async register(input) {
      const existing = await repo.findByEmail(input.email);
      if (existing) {
        // Registration is necessarily an account-existence oracle; the honest
        // mitigation is the rate limit on this route, not a misleading 201.
        throw conflict('An account with this email already exists', 'EMAIL_TAKEN');
      }

      const user = await repo.createUser({
        email: input.email,
        passwordHash: await hashPassword(input.password),
        role: input.role,
        fullName: input.fullName,
        phoneEnc: input.phone ? encryptField(input.phone) : null,
      });

      authEvents.inc({ event: 'register', outcome: 'success' });
      await audit({
        action: 'auth.register', resourceType: 'user', resourceId: user.id,
        actorId: user.id, actorRole: user.role, metadata: { role: user.role },
      });
      return user;
    },

    async login(input) {
      const user = await repo.findByEmail(input.email);

      // Same error and comparable timing whether the account exists or the
      // password is wrong, so login cannot be used to enumerate accounts.
      if (!user) {
        await hashPassword(input.password); // burn equivalent CPU
        authEvents.inc({ event: 'login', outcome: 'failure' });
        throw unauthorized('Invalid email or password');
      }

      if (user.locked_until && user.locked_until > new Date()) {
        authEvents.inc({ event: 'login', outcome: 'locked' });
        await audit({
          action: 'auth.login', resourceType: 'user', resourceId: user.id,
          outcome: 'denied', metadata: { reason: 'account_locked' },
        });
        throw forbidden('Account temporarily locked after repeated failed attempts');
      }

      if (user.status !== 'active') throw forbidden('Account is not active');

      if (!(await verifyPassword(input.password, user.password_hash))) {
        await repo.recordFailedLogin(user.id, LOCK_THRESHOLD, LOCK_MINUTES);
        authEvents.inc({ event: 'login', outcome: 'failure' });
        await audit({
          action: 'auth.login', resourceType: 'user', resourceId: user.id,
          outcome: 'failure', metadata: { reason: 'bad_password' },
        });
        throw unauthorized('Invalid email or password');
      }

      // Doctors and admins reach clinical data across patients, so MFA is
      // mandatory for them rather than opt-in.
      const mfaMandatory = user.role === 'doctor' || user.role === 'admin';

      if (user.mfa_enabled) {
        if (!input.totp) {
          authEvents.inc({ event: 'login', outcome: 'mfa_challenge' });
          throw unauthorized('MFA_REQUIRED: supply the 6-digit code from your authenticator app');
        }
        const secret = decryptField<string>(user.mfa_secret_enc);
        if (!secret || !verifyTotp(secret, input.totp)) {
          await repo.recordFailedLogin(user.id, LOCK_THRESHOLD, LOCK_MINUTES);
          authEvents.inc({ event: 'login', outcome: 'mfa_failure' });
          await audit({
            action: 'auth.mfa', resourceType: 'user', resourceId: user.id, outcome: 'failure',
          });
          throw unauthorized('Invalid MFA code');
        }
      } else if (mfaMandatory) {
        logger.warn({ userId: user.id, role: user.role }, 'privileged account without MFA enrolled');
      }

      await repo.clearFailedLogins(user.id);

      const tokens = await issueTokens(user.id, user.role, user.mfa_enabled, randomUUID(), null);
      authEvents.inc({ event: 'login', outcome: 'success' });
      await audit({
        action: 'auth.login', resourceType: 'user', resourceId: user.id,
        actorId: user.id, actorRole: user.role, metadata: { mfa: user.mfa_enabled },
      });

      return {
        ...tokens,
        ...(mfaMandatory && !user.mfa_enabled ? { mfaRequired: true } : {}),
      };
    },

    /**
     * Rotating refresh with reuse detection.
     *
     * Each refresh token is single-use. Presenting one that has already been
     * used means two parties hold it — the legitimate client and a thief — and
     * there is no way to tell which is calling. The safe response is to revoke
     * the entire family, forcing a fresh login that the attacker cannot
     * complete without the password.
     */
    async refresh(token) {
      const tokenHash = sha256(token);
      const record = await repo.findRefreshByHash(tokenHash);
      if (!record) throw unauthorized('Invalid refresh token');

      if (record.revoked_at) {
        authEvents.inc({ event: 'refresh', outcome: 'revoked' });
        throw unauthorized('Refresh token has been revoked');
      }

      if (record.used_at) {
        const revoked = await repo.revokeFamily(record.family_id);
        authEvents.inc({ event: 'refresh', outcome: 'reuse_detected' });
        logger.error(
          { userId: record.user_id, familyId: record.family_id, revoked },
          'refresh token reuse detected — family revoked',
        );
        await audit({
          action: 'auth.token_reuse_detected', resourceType: 'user', resourceId: record.user_id,
          outcome: 'denied', metadata: { familyId: record.family_id, tokensRevoked: revoked },
        });
        throw unauthorized('Refresh token reuse detected. All sessions have been revoked.');
      }

      if (record.expires_at <= new Date()) throw unauthorized('Refresh token expired');

      const user = await repo.findById(record.user_id);
      if (!user || user.status !== 'active') throw forbidden('Account is not active');

      // Marking used and issuing the successor must be atomic: a crash between
      // them would leave the client with no usable token.
      return withTransaction(async (client) => {
        await repo.markRefreshUsed(record.id, client);
        const tokens = await issueTokens(
          user.id, user.role, user.mfa_enabled, record.family_id, record.id,
        );
        authEvents.inc({ event: 'refresh', outcome: 'success' });
        return tokens;
      });
    },

    async logout(token) {
      const record = await repo.findRefreshByHash(sha256(token));
      if (!record) return; // already gone: logout is idempotent
      await repo.revokeFamily(record.family_id);
      authEvents.inc({ event: 'logout', outcome: 'success' });
      await audit({
        action: 'auth.logout', resourceType: 'user', resourceId: record.user_id,
        metadata: { familyId: record.family_id },
      });
    },

    async beginMfaSetup(userId) {
      const user = await repo.findById(userId);
      if (!user) throw notFound('User');
      if (user.mfa_enabled) throw conflict('MFA is already enabled', 'MFA_ALREADY_ENABLED');

      const secret = generateSecret();
      // Stored encrypted and not yet enabled: an interrupted enrolment must
      // not lock the user out of their own account.
      await repo.setMfaSecret(userId, encryptField(secret));
      return { secret, otpauthUri: otpauthUri(secret, user.email) };
    },

    async confirmMfaSetup(userId, code) {
      const user = await repo.findById(userId);
      if (!user) throw notFound('User');
      const secret = decryptField<string>(user.mfa_secret_enc);
      if (!secret) throw badRequest('Start MFA setup before confirming it');
      if (!verifyTotp(secret, code)) throw unauthorized('Invalid MFA code');

      await repo.enableMfa(userId);
      authEvents.inc({ event: 'mfa_enrol', outcome: 'success' });
      await audit({ action: 'auth.mfa_enabled', resourceType: 'user', resourceId: userId });
    },
  };
}
