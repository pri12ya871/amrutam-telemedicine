import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  traceId?: string;
  userId?: string;
  role?: string;
  ipHash?: string;
  userAgent?: string;
  method: string;
  path: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Request-scoped context, so the logger and the audit writer can attach the
 * correlation id and actor without every function signature growing two
 * parameters it does not otherwise care about.
 */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T =>
  storage.run(ctx, fn);

export const getContext = (): RequestContext | undefined => storage.getStore();

/** Mutates the live context — used once authentication has resolved the user. */
export function setContextUser(userId: string, role: string): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx.userId = userId;
    ctx.role = role;
  }
}
