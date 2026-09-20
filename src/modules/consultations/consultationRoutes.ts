import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, requirePermission, type AuthenticatedRequest } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import {
  consultationNotesSchema, consultationService, listConsultationsSchema,
} from './consultationService.js';

const idParams = z.object({ id: z.string().uuid() });
const transitionSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'no_show']),
});

export function consultationRoutes(): Router {
  const router = Router();

  router.get(
    '/',
    authenticate,
    readRateLimit,
    validate({ query: listConsultationsSchema }),
    asyncHandler(async (req, res) => {
      const { id, role } = (req as AuthenticatedRequest).user;
      res.json({ data: await consultationService.listForUser(id, role, req.valid.query as never) });
    }),
  );

  router.get(
    '/:id',
    authenticate,
    requirePermission('consultation:read:self'),
    readRateLimit,
    validate({ params: idParams }),
    asyncHandler(async (req, res) => {
      const { id: actorId, role } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      res.json({ data: await consultationService.getById(id, actorId, role) });
    }),
  );

  // State transitions are idempotent by guard rather than by key: the SQL
  // only matches a legal source state, so a repeated call is a no-op 409
  // rather than a duplicated side effect.
  router.post(
    '/:id/status',
    authenticate,
    requirePermission('consultation:write:self'),
    writeRateLimit,
    validate({ params: idParams, body: transitionSchema }),
    asyncHandler(async (req, res) => {
      const { id: actorId, role } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { status } = req.valid.body as z.infer<typeof transitionSchema>;
      res.json({ data: await consultationService.transition(id, status, actorId, role) });
    }),
  );

  router.put(
    '/:id/notes',
    authenticate,
    requirePermission('consultation:write:self'),
    writeRateLimit,
    validate({ params: idParams, body: consultationNotesSchema }),
    asyncHandler(async (req, res) => {
      const { id: actorId } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { notes } = req.valid.body as z.infer<typeof consultationNotesSchema>;
      await consultationService.saveNotes(id, actorId, notes);
      res.status(204).send();
    }),
  );

  return router;
}
