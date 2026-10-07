import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { validationResult, type ValidationChain } from 'express-validator';
import { AppError, type FieldIssue } from '../utils/AppError';

/**
 * Turns express-validator output into the shared validation error shape so both
 * frontends can map issues onto form fields.
 */
export function handleValidation(req: Request, _res: Response, next: NextFunction): void {
  const result = validationResult(req);
  if (result.isEmpty()) {
    next();
    return;
  }

  const seen = new Set<string>();
  const details: FieldIssue[] = [];

  for (const error of result.array()) {
    const field = 'path' in error && typeof error.path === 'string' ? error.path : 'request';
    if (seen.has(field)) continue;
    seen.add(field);
    details.push({ field, message: error.msg as string });
  }

  next(AppError.validation('Please correct the highlighted fields.', details));
}

/** Convenience wrapper: run a validation chain, then the shared error mapper. */
export function validate(chain: ValidationChain[]): RequestHandler[] {
  return [...chain, handleValidation];
}

/** Wraps an async handler so rejected promises reach the central error handler. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
