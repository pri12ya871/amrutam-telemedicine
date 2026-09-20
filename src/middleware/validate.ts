import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny, z } from 'zod';

export interface ValidationSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      valid: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
      };
    }
  }
}

/**
 * Validate and *replace*. Handlers read `req.valid.body`, never `req.body`, so
 * unknown keys that Zod stripped cannot sneak through into a repository call —
 * which is how mass-assignment bugs happen (`{ role: "admin" }` on a profile
 * update).
 *
 * The same schemas feed the OpenAPI document, so the spec cannot drift from
 * what the server actually enforces.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.valid = {};
      if (schemas.params) req.valid.params = schemas.params.parse(req.params);
      if (schemas.query) req.valid.query = schemas.query.parse(req.query);
      if (schemas.body) req.valid.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err); // ZodError is rendered by the error handler
    }
  };
}

export const body = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
  req.valid.body as z.infer<T>;
export const queryOf = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
  req.valid.query as z.infer<T>;
export const paramsOf = <T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> =>
  req.valid.params as z.infer<T>;
