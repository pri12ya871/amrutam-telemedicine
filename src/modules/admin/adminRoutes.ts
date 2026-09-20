import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { validate } from '../../middleware/validate.js';
import {
  authenticate, requireMfa, requirePermission, type AuthenticatedRequest,
} from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { analyticsRangeSchema, analyticsService } from './analyticsService.js';
import { searchAuditLogs } from '../audit/auditService.js';

const auditQuerySchema = z.object({
  actorId: z.string().uuid().optional(),
  resourceType: z.string().max(50).optional(),
  resourceId: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const rangeSchema = z.object({ from: z.string().date(), to: z.string().date() });

/**
 * Every route here reads across the whole population, so the whole router is
 * gated on admin + MFA rather than each handler remembering to ask.
 */
export function adminRoutes(): Router {
  const router = Router();

  router.use(authenticate, requireMfa, requirePermission('analytics:read'), readRateLimit);

  router.get(
    '/analytics/overview',
    asyncHandler(async (req, res) => {
      const { id } = (req as AuthenticatedRequest).user;
      res.json({ data: await analyticsService.overview(id) });
    }),
  );

  router.get(
    '/analytics/consultations',
    validate({ query: analyticsRangeSchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await analyticsService.consultationTrend(req.valid.query as never) });
    }),
  );

  router.get(
    '/analytics/top-doctors',
    asyncHandler(async (_req, res) => {
      res.json({ data: await analyticsService.topDoctors() });
    }),
  );

  router.get(
    '/analytics/utilisation',
    validate({ query: rangeSchema }),
    asyncHandler(async (req, res) => {
      const { from, to } = req.valid.query as z.infer<typeof rangeSchema>;
      res.json({ data: await analyticsService.slotUtilisation(from, to) });
    }),
  );

  // Reading the audit trail is itself an audited, privileged action — see
  // docs/security-checklist.md on who watches the watchers.
  router.get(
    '/audit-logs',
    requirePermission('audit:read'),
    validate({ query: auditQuerySchema }),
    asyncHandler(async (req, res) => {
      res.json({ data: await searchAuditLogs(req.valid.query as never) });
    }),
  );

  return router;
}
