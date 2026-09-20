import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { config } from '../../config.js';
import { unauthorized } from '../../lib/errors.js';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ISSUER = 'amrutam.telemedicine';
const AUDIENCE = 'amrutam.api';

export type Role = 'patient' | 'doctor' | 'admin';

/** The claims this service adds on top of the registered JWT ones. */
export interface CustomClaims {
  role: Role;
  /** True once MFA has been satisfied for this session. */
  mfa: boolean;
  /** Refresh-token family, so revoking a family invalidates its access tokens. */
  fam: string;
}

export type AccessClaims = JWTPayload & CustomClaims & { sub: string };

/**
 * Access tokens are short-lived (15m by default) and carry the whole
 * authorisation decision, so the hot path does not hit the database to
 * authenticate. Anything that must take effect immediately — suspension,
 * token-family revocation — is handled at refresh time, which is the trade
 * being made: at most one access-token lifetime of staleness.
 */
export async function signAccessToken(claims: CustomClaims & { sub: string }): Promise<string> {
  return new SignJWT({ role: claims.role, mfa: claims.mfa, fam: claims.fam })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .setJti(crypto.randomUUID())
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'], // pinned: never let the token choose `none`
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string') {
      throw unauthorized('Malformed token');
    }
    return payload as AccessClaims;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_JWT_EXPIRED') {
      throw unauthorized('Access token expired');
    }
    throw unauthorized('Invalid access token');
  }
}
