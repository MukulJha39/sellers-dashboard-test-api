import type { ErrorRequestHandler, NextFunction, Request, Response } from 'express';
import multer from 'multer';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { AppError, ErrorCode, type FieldIssue } from '../utils/AppError';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(AppError.notFound(`No endpoint matches ${req.method} ${req.originalUrl.split('?')[0]}.`));
}

function translate(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `Images must be smaller than ${Math.floor(env.upload.maxBytes / (1024 * 1024))} MB.`
        : 'That file could not be accepted.';
    return AppError.badRequest(ErrorCode.UPLOAD_REJECTED, message);
  }

  if (error instanceof mongoose.Error.ValidationError) {
    const details: FieldIssue[] = Object.entries(error.errors).map(([field, issue]) => ({
      field,
      message: issue.message,
    }));
    return AppError.validation('Please correct the highlighted fields.', details);
  }

  if (error instanceof mongoose.Error.CastError) {
    return AppError.badRequest(ErrorCode.VALIDATION_ERROR, 'That identifier is not valid.');
  }

  if (typeof error === 'object' && error !== null && (error as { code?: number }).code === 11000) {
    return AppError.conflict('A record with those details already exists.');
  }

  // Phone immutability is also guarded at the model layer; surface it with its own code.
  if (error instanceof Error && error.message.includes('verified phone number of a merchant cannot be changed')) {
    return new AppError(409, ErrorCode.PHONE_IMMUTABLE, 'A verified phone number cannot be changed.');
  }

  return AppError.internal();
}

/**
 * Central error handler. Clients only ever receive a stable code, a plain-language
 * message and field issues — never a stack trace or internal detail (PRD section 22).
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
  const appError = translate(error);

  if (appError.statusCode >= 500) {
    logger.error('Unhandled request error', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      reason: error instanceof Error ? error.message : 'unknown',
      stack: error instanceof Error ? error.stack : undefined,
    });
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      ...(appError.meta ? { meta: appError.meta } : {}),
    },
    requestId: req.requestId,
  });
};
