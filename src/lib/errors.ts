/**
 * One error type for everything the API can deliberately return. Anything that
 * is not an AppError is a bug, and the error handler treats it as such: 500,
 * no detail leaked to the client, full stack in the logs.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = status < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

/** MFA is configured for this account but this token has not satisfied it. */
export const mfaRequired = (message = 'Multi-factor authentication required') =>
  new AppError(401, 'MFA_REQUIRED', message);

export const forbidden = (message = 'Insufficient permissions') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (resource = 'Resource') =>
  new AppError(404, 'NOT_FOUND', `${resource} not found`);

export const conflict = (message: string, code = 'CONFLICT', details?: unknown) =>
  new AppError(409, code, message, details);

/** The slot was taken between the client reading availability and booking. */
export const slotUnavailable = () =>
  new AppError(409, 'SLOT_UNAVAILABLE', 'This slot is no longer available');

/** Same Idempotency-Key, different request body — almost always a client bug. */
export const idempotencyMismatch = () =>
  new AppError(
    422,
    'IDEMPOTENCY_KEY_REUSE',
    'This Idempotency-Key was already used with a different request body',
  );

export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'UNPROCESSABLE', message, details);

export const tooManyRequests = (retryAfterSec: number) =>
  new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSec });

export const serviceUnavailable = (message = 'Service temporarily unavailable') =>
  new AppError(503, 'SERVICE_UNAVAILABLE', message);

export const isAppError = (e: unknown): e is AppError =>
  e instanceof AppError || (typeof e === 'object' && e !== null && (e as AppError).name === 'AppError');
