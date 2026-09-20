import { Router } from 'express';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, type AuthenticatedRequest } from '../../middleware/auth.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import {
  loginSchema, mfaConfirmSchema, refreshSchema, registerSchema,
} from './authSchemas.js';
import type { AuthService } from './authService.js';

export function authRoutes(service: AuthService): Router {
  const router = Router();

  // Every unauthenticated auth endpoint is IP-limited: these are the routes an
  // attacker can reach without credentials.
  router.post(
    '/register',
    authRateLimit,
    validate({ body: registerSchema }),
    asyncHandler(async (req, res) => {
      const user = await service.register(req.valid.body as never);
      res.status(201).json({ data: user });
    }),
  );

  router.post(
    '/login',
    authRateLimit,
    validate({ body: loginSchema }),
    asyncHandler(async (req, res) => {
      const tokens = await service.login(req.valid.body as never);
      res.status(200).json({ data: tokens });
    }),
  );

  router.post(
    '/refresh',
    authRateLimit,
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      const { refreshToken } = req.valid.body as { refreshToken: string };
      res.status(200).json({ data: await service.refresh(refreshToken) });
    }),
  );

  router.post(
    '/logout',
    validate({ body: refreshSchema }),
    asyncHandler(async (req, res) => {
      const { refreshToken } = req.valid.body as { refreshToken: string };
      await service.logout(refreshToken);
      res.status(204).send();
    }),
  );

  // MFA enrolment is two steps on purpose: the secret is only activated once
  // the user has proved their authenticator app produces matching codes.
  router.post(
    '/mfa/setup',
    authenticate,
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      res.status(200).json({ data: await service.beginMfaSetup(id) });
    }),
  );

  router.post(
    '/mfa/confirm',
    authenticate,
    validate({ body: mfaConfirmSchema }),
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      const { totp } = req.valid.body as { totp: string };
      await service.confirmMfaSetup(id, totp);
      res.status(200).json({ data: { mfaEnabled: true } });
    }),
  );

  router.get(
    '/me',
    authenticate,
    asyncHandler(async (req, res) => {
      const { id, role, mfa } = (req as AuthenticatedRequest).user;
      res.status(200).json({ data: { id, role, mfaSatisfied: mfa } });
    }),
  );

  return router;
}
