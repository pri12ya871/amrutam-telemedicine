import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, optionalAuth, requireMfa, requirePermission, type AuthenticatedRequest,
} from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { doctorProfileSchema, doctorSearchSchema, doctorService } from './doctorService.js';
import {
  availabilityRuleSchema, availabilityService, slotQuerySchema,
} from '../availability/availabilityService.js';
import { query } from '../../db/pool.js';
import { forbidden, notFound } from '../../lib/errors.js';

const idParams = z.object({ id: z.string().uuid() });
const generateSchema = z.object({ from: z.string().date(), to: z.string().date() });

/** Resolves the doctor row owned by the calling user, or 403. */
async function ownDoctorId(userId: string): Promise<string> {
  const { rows } = await query<{ id: string }>(`SELECT id FROM doctors WHERE user_id = $1`, [userId]);
  if (!rows[0]) throw forbidden('You do not have a doctor profile');
  return rows[0].id;
}

export function doctorRoutes(): Router {
  const router = Router();

  // Search is public: patients compare doctors before signing up. optionalAuth
  // still attaches a user when present so the rate limit is per-account rather
  // than per-IP for logged-in traffic.
  router.get(
    '/',
    optionalAuth,
    readRateLimit,
    validate({ query: doctorSearchSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await doctorService.search(req.valid.query as never) });
    }),
  );

  router.get(
    '/:id',
    optionalAuth,
    readRateLimit,
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const { id } = req.valid.params as z.infer<typeof idParams>;
      res.json({ data: await doctorService.getById(id) });
    }),
  );

  router.get(
    '/:id/slots',
    optionalAuth,
    readRateLimit,
    validate({ params: idParams, query: slotQuerySchema }),
    asyncHandler(async (req, res) => {
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { from, to } = req.valid.query as z.infer<typeof slotQuerySchema>;
      res.json({ data: await availabilityService.listAvailableSlots(id, from, to) });
    }),
  );

  router.post(
    '/profile',
    authenticate,
    writeRateLimit,
    validate({ body: doctorProfileSchema }),
    asyncHandler(async (req, res) => {
      const { id, role } = (req as AuthenticatedRequest).user;
      if (role !== 'doctor') throw forbidden('Only doctor accounts can create a doctor profile');
      res.status(201).json({ data: await doctorService.createProfile(id, req.valid.body as never) });
    }),
  );

  // ---- availability, owned by the calling doctor -------------------------

  router.get(
    '/me/availability/rules',
    authenticate,
    requirePermission('availability:write:self'),
    asyncHandler(async (req, res) => {
      const doctorId = await ownDoctorId((req as AuthenticatedRequest).user.id);
      res.json({ data: await availabilityService.listRules(doctorId) });
    }),
  );

  router.post(
    '/me/availability/rules',
    authenticate,
    requirePermission('availability:write:self'),
    writeRateLimit,
    validate({ body: availabilityRuleSchema }),
    asyncHandler(async (req, res) => {
      const doctorId = await ownDoctorId((req as AuthenticatedRequest).user.id);
      res.status(201).json({ data: await availabilityService.addRule(doctorId, req.valid.body as never) });
    }),
  );

  // Materialising slots is naturally idempotent (ON CONFLICT DO NOTHING), so
  // it needs no Idempotency-Key: re-running it over the same window is a no-op.
  router.post(
    '/me/availability/generate',
    authenticate,
    requirePermission('availability:write:self'),
    writeRateLimit,
    validate({ body: generateSchema }),
    asyncHandler(async (req, res) => {
      const doctorId = await ownDoctorId((req as AuthenticatedRequest).user.id);
      const { from, to } = req.valid.body as z.infer<typeof generateSchema>;
      const created = await availabilityService.generateSlots(doctorId, from, to);
      res.status(201).json({ data: { slotsCreated: created, from, to } });
    }),
  );

  router.post(
    '/me/availability/slots/:id/block',
    authenticate,
    requirePermission('availability:write:self'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const doctorId = await ownDoctorId((req as AuthenticatedRequest).user.id);
      const { id } = req.valid.params as z.infer<typeof idParams>;
      await availabilityService.blockSlot(doctorId, id);
      res.status(204).send();
    }),
  );

  // Verification is an admin action over someone else's record, so it is
  // behind MFA as well as the permission.
  router.post(
    '/:id/verify',
    authenticate,
    requireMfa,
    requirePermission('doctor:verify'),
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const { id } = req.valid.params as z.infer<typeof idParams>;
      await doctorService.verify(id, (req as AuthenticatedRequest).user.id);
      res.json({ data: { id, status: 'active' } });
    }),
  );

  router.all('/:id/unknown', () => {
    throw notFound('Route');
  });

  return router;
}
