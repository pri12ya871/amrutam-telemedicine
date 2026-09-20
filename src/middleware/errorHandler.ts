import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getContext } from '../lib/context.js';
import { isUniqueViolation } from '../db/pool.js';

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId?: string;
  };
}

/**
 * The single place an error becomes a response.
 *
 * Rule: clients learn the shape of their own mistakes and nothing about ours.
 * A 5xx returns a fixed message and the request id — enough for a user to
 * quote in a support ticket, not enough to map the internals.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);

  const requestId = getContext()?.requestId;

  if (err instanceof ZodError) {
    logger.info({ issues: err.issues }, 'request validation failed');
    res.status(400).json(<ErrorBody>{
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        requestId,
      },
    });
    return;
  }

  if (isAppError(err)) {
    const appErr = err as AppError;
    const level = appErr.status >= 500 ? 'error' : 'info';
    logger[level]({ err: appErr, code: appErr.code, status: appErr.status }, appErr.message);

    if (appErr.status === 429) {
      const retry = (appErr.details as { retryAfterSec?: number })?.retryAfterSec;
      if (retry) res.setHeader('retry-after', String(retry));
    }

    res.status(appErr.status).json(<ErrorBody>{
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.details !== undefined ? { details: appErr.details } : {}),
        requestId,
      },
    });
    return;
  }

  // A unique violation that reached here means a race the service layer did
  // not name. 409 is still the honest answer, but log it loudly: an unnamed
  // constraint race is a gap in the domain logic.
  if (isUniqueViolation(err)) {
    logger.error({ err }, 'unhandled unique violation — missing an explicit conflict check');
    res.status(409).json(<ErrorBody>{
      error: { code: 'CONFLICT', message: 'Resource already exists', requestId },
    });
    return;
  }

  logger.error({ err }, 'unhandled error');
  res.status(500).json(<ErrorBody>{
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
  });
}

/** 404 for anything the router did not claim. */
export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json(<ErrorBody>{
    error: { code: 'NOT_FOUND', message: 'Route not found', requestId: getContext()?.requestId },
  });
}

/**
 * Express 4 does not catch rejected promises from async handlers; without this
 * wrapper a rejection hangs the request until the client times out.
 */
export const asyncHandler =
  <T extends Request>(fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req as T, res, next)).catch(next);
  };
