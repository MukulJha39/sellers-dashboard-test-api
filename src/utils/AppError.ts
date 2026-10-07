/**
 * Stable, client-safe error codes. The merchant app and admin panel branch on these
 * rather than on message text, so codes must never be renamed casually.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ALREADY_USED: 'OTP_ALREADY_USED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  PHONE_IMMUTABLE: 'PHONE_IMMUTABLE',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  ALREADY_REGISTERED: 'ALREADY_REGISTERED',
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldIssue {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: FieldIssue[];
  readonly meta?: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: ErrorCodeValue,
    message: string,
    options?: { details?: FieldIssue[]; meta?: Record<string, unknown> },
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    if (options?.details) this.details = options.details;
    if (options?.meta) this.meta = options.meta;
  }

  static badRequest(code: ErrorCodeValue, message: string, details?: FieldIssue[]): AppError {
    return new AppError(400, code, message, details ? { details } : undefined);
  }

  static validation(message: string, details?: FieldIssue[]): AppError {
    return new AppError(422, ErrorCode.VALIDATION_ERROR, message, details ? { details } : undefined);
  }

  static unauthenticated(
    message = 'Authentication is required.',
    code: ErrorCodeValue = ErrorCode.UNAUTHENTICATED,
  ): AppError {
    return new AppError(401, code, message);
  }

  static forbidden(message = 'You do not have permission to perform this action.'): AppError {
    return new AppError(403, ErrorCode.FORBIDDEN, message);
  }

  static notFound(message = 'The requested record was not found.'): AppError {
    return new AppError(404, ErrorCode.NOT_FOUND, message);
  }

  /**
   * A conflict, optionally carrying the detail a client needs to act on it: the stock
   * actually available, the amount actually outstanding, the id of the record that
   * already uses a phone number.
   */
  static conflict(
    message: string,
    options?: { code?: ErrorCodeValue; meta?: Record<string, unknown> },
  ): AppError {
    return new AppError(409, options?.code ?? ErrorCode.CONFLICT, message,
      options?.meta ? { meta: options.meta } : undefined);
  }

  static rateLimited(
    message = 'Too many requests. Please wait and try again.',
    meta?: Record<string, unknown>,
  ): AppError {
    return new AppError(429, ErrorCode.RATE_LIMITED, message, meta ? { meta } : undefined);
  }

  static internal(message = 'Something went wrong. Please try again.'): AppError {
    return new AppError(500, ErrorCode.INTERNAL_ERROR, message);
  }
}
