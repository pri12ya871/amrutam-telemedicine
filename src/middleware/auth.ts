import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type Role } from '../modules/auth/tokens.js';
import { forbidden, mfaRequired, unauthorized } from '../lib/errors.js';
import { setContextUser } from '../lib/context.js';
import { asyncHandler } from './errorHandler.js';

export interface AuthenticatedRequest extends Request {
  user: { id: string; role: Role; mfa: boolean; family: string };
}

/**
 * RBAC permission matrix.
 *
 * Kept as data in one place rather than scattered `if (role === 'admin')`
 * checks, so the complete authorisation surface can be read — and reviewed —
 * on one screen. Route handlers ask for a permission, never for a role.
 */
export const PERMISSIONS = {
  patient: [
    'profile:read:self', 'profile:write:self',
    'doctor:search', 'availability:read',
    'booking:create', 'booking:cancel:self',
    'consultation:read:self',
    'prescription:read:self',
    'payment:create',
  ],
  doctor: [
    'profile:read:self', 'profile:write:self',
    'doctor:search', 'availability:read', 'availability:write:self',
    'consultation:read:self', 'consultation:write:self',
    'prescription:create', 'prescription:read:self',
    'booking:cancel:self',
  ],
  admin: [
    'profile:read:any', 'profile:write:any',
    'doctor:search', 'doctor:verify',
    'availability:read', 'availability:write:any',
    'consultation:read:any',
    'prescription:read:any',
    'analytics:read', 'audit:read',
    'booking:cancel:any',
  ],
} as const satisfies Record<Role, readonly string[]>;

export type Permission = (typeof PERMISSIONS)[Role][number];

export const can = (role: Role, permission: string): boolean =>
  (PERMISSIONS[role] as readonly string[]).includes(permission);

/** Rejects anything that is not a valid, unexpired bearer token. */
export const authenticate = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) throw unauthorized('Missing bearer token');

  const claims = await verifyAccessToken(header.slice(7).trim());
  (req as AuthenticatedRequest).user = {
    id: claims.sub,
    role: claims.role,
    mfa: Boolean(claims.mfa),
    family: claims.fam,
  };
  setContextUser(claims.sub, claims.role);
  next();
});

/** Attaches the user when a token is present, but does not demand one. */
export const optionalAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.get('authorization');
  if (!header?.startsWith('Bearer ')) return next();
  try {
    const claims = await verifyAccessToken(header.slice(7).trim());
    (req as AuthenticatedRequest).user = {
      id: claims.sub, role: claims.role, mfa: Boolean(claims.mfa), family: claims.fam,
    };
    setContextUser(claims.sub, claims.role);
  } catch {
    // An invalid token on an optional route is simply an anonymous request.
  }
  next();
});

export function requirePermission(...required: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return next(unauthorized());
    const missing = required.filter((p) => !can(user.role, p));
    if (missing.length > 0) {
      return next(forbidden(`Missing permission: ${missing.join(', ')}`));
    }
    next();
  };
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) return next(unauthorized());
    if (!roles.includes(user.role)) return next(forbidden(`Requires role: ${roles.join(' or ')}`));
    next();
  };
}

/**
 * Step-up authentication.
 *
 * Doctors and admins can reach clinical records and analytics over the whole
 * patient population, so their sessions must have completed MFA. Patients can
 * enable it; for privileged roles it is not optional.
 */
export function requireMfa(req: Request, _res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) return next(unauthorized());
  if (!user.mfa) return next(mfaRequired('This action requires multi-factor authentication'));
  next();
}
