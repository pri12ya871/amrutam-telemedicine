import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, requirePermission, type AuthenticatedRequest } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import type { PaymentService } from './paymentService.js';

const idParams = z.object({ id: z.string().uuid() });
const captureSchema = z.object({
  simulate: z.enum(['success', 'failure', 'timeout']).default('success'),
});

export function paymentRoutes(service: PaymentService): Router {
  const router = Router();

  /**
   * Capture. The single most important endpoint to get idempotent: a retried
   * capture without a key is a second charge on a patient's card.
   */
  router.post(
    '/:id/capture',
    authenticate,
    requirePermission('payment:create'),
    writeRateLimit,
    validate({ params: idParams, body: captureSchema }),
    idempotent('POST /payments/:id/capture'),
    asyncHandler(async (req, res) => {
      const { id: patientId } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { simulate } = req.valid.body as z.infer<typeof captureSchema>;
      res.json({ data: await service.capture(id, patientId, simulate) });
    }),
  );

  router.get(
    '/',
    authenticate,
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      res.json({ data: await service.listForPatient(id) });
    }),
  );

  return router;
}
