import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { runWithContext } from '../lib/context.js';
import { hashIp } from '../lib/crypto.js';

/**
 * Establishes the per-request async context. Must be the first middleware:
 * everything downstream (logger, audit, error handler) reads from it.
 *
 * An inbound X-Request-Id is honoured so a trace survives the hop from the API
 * gateway, but it is length-capped — it ends up in logs and in the audit table,
 * and an unbounded client-controlled string there is an injection vector into
 * whatever reads those logs.
 */
export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.get('x-request-id');
  const requestId =
    inbound && /^[\w.-]{1,128}$/.test(inbound) ? inbound : randomUUID();

  res.setHeader('x-request-id', requestId);

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

  runWithContext(
    {
      requestId,
      ipHash: hashIp(ip),
      userAgent: req.get('user-agent')?.slice(0, 256),
      method: req.method,
      path: req.path,
    },
    () => next(),
  );
}
