import pino from 'pino';
import { config } from '../config.js';
import { getContext } from './context.js';

/**
 * Structured JSON logs, correlated by request id.
 *
 * The redact list is not decoration. This service handles health data, so a
 * stray `logger.info({ body })` must not be the thing that puts a password or a
 * diagnosis into a log aggregator that has a wider audience than the database.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["idempotency-key"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'refreshToken',
      '*.refreshToken',
      'mfaSecret',
      '*.mfaSecret',
      'totp',
      '*.totp',
      'notes',
      '*.notes',
      'chiefComplaint',
      '*.chiefComplaint',
      'diagnosis',
      '*.diagnosis',
      'medicines',
      '*.medicines',
      'phone',
      '*.phone',
      'address',
      '*.address',
    ],
    censor: '[redacted]',
  },
  base: { service: config.OTEL_SERVICE_NAME, env: config.NODE_ENV },
  // Pull correlation ids from the async context so callers never pass them.
  mixin() {
    const ctx = getContext();
    if (!ctx) return {};
    return {
      requestId: ctx.requestId,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    };
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
