import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, requirePermission, type AuthenticatedRequest } from '../../middleware/auth.js';
import { idempotent } from '../../middleware/idempotency.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import { bookingService, cancelBookingSchema, createBookingSchema } from './bookingService.js';

const idParams = z.object({ id: z.string().uuid() });

export function bookingRoutes(): Router {
  const router = Router();

  /**
   * Create a booking.
   *
   * Middleware order is load-bearing:
   *   authenticate  -> idempotency is scoped per user, so we need the user
   *   rate limit    -> cheap rejection before touching the database
   *   validate      -> the request hash must be over a well-formed body
   *   idempotent    -> claims the key, replays a previous response if any
   *   handler       -> the only step that can create a consultation
   *
   * Putting `idempotent` before `validate` would hash unvalidated input, so
   * two semantically identical requests that differ only in an ignored field
   * would be treated as different operations.
   */
  router.post(
    '/',
    authenticate,
    requirePermission('booking:create'),
    writeRateLimit,
    validate({ body: createBookingSchema }),
    idempotent('POST /bookings'),
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      const result = await bookingService.book(id, req.valid.body as never);
      res.status(201).json({ data: result });
    }),
  );

  router.post(
    '/:id/cancel',
    authenticate,
    writeRateLimit,
    validate({ params: idParams, body: cancelBookingSchema }),
    idempotent('POST /bookings/:id/cancel'),
    asyncHandler(async (req, res) => {
      const { id: actorId, role } = (req as AuthenticatedRequest).user;
      const { id } = req.valid.params as z.infer<typeof idParams>;
      const { reason } = req.valid.body as z.infer<typeof cancelBookingSchema>;
      res.json({ data: await bookingService.cancel(id, actorId, role, reason) });
    }),
  );

  return router;
}
