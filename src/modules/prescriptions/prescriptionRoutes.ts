import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireMfa, requirePermission, type AuthenticatedRequest,
} from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { createPrescriptionSchema, prescriptionService } from './prescriptionService.js';

const idParams = z.object({ id: z.string().uuid() });
const revokeSchema = z.object({ reason: z.string().min(3).max(500) });
const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

export function prescriptionRoutes(): Router {
  const router = Router();

  /**
   * Issuing a prescription is the highest-consequence write in the system —
   * a duplicate is a real clinical risk, not just a data problem — so it
   * carries both an Idempotency-Key and a step-up MFA requirement.
   */
  router.post(
    '/',
    authenticate,
    requireMfa,
    requirePermission('prescription:create'),
    writeRateLimit,
    validate({ body: createPrescriptionSchema }),
    idempotent('POST /prescriptions'),
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      res.status(201).json({ data: await prescriptionService.create(id, req.valid.body as never) });
    }),
  );

  router.get(
    '/',
    authenticate,
    readRateLimit,
    validate({ query: listSchema }),
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      const { limit, offset } = req.valid.query as z.infer<typeof listSchema>;
      res.json({ data: await prescriptionService.listForPatient(id, limit, offset) });
    }),
  );

  router.get(
    '/:id',
    authenticate,
    readRateLimit,
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const { id: actorId, role } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      res.json({ data: await prescriptionService.getById(id, actorId, role) });
    }),
  );

  router.post(
    '/:id/revoke',
    authenticate,
    requireMfa,
    requirePermission('prescription:create'),
    validate({ params: idParams, body: revokeSchema }),
    asyncHandler(async (req, res) => {
      const { id: actorId } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { reason } = req.valid.body as z.infer<typeof revokeSchema>;
      await prescriptionService.revoke(id, actorId, reason);
      res.status(204).send();
    }),
  );

  return router;
}
