import crypto from 'crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError, ErrorCode } from './AppError';

export type TokenType =
  | 'merchant_access'
  | 'merchant_refresh'
  | 'admin_access'
  | 'admin_refresh'
  | 'registration';

export interface SessionTokenClaims extends JwtPayload {
  sub: string;
  type: TokenType;
  sid: string;
  /** Rotation id: a refresh token is only valid while it matches the session's current id. */
  tid?: string;
}

export interface RegistrationTokenClaims extends JwtPayload {
  type: 'registration';
  countryCode: string;
  phone: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  refreshTokenExpiresIn: number;
  tokenType: 'Bearer';
}

const ISSUER = 'sellersdash';

function secretFor(type: TokenType): string {
  switch (type) {
    case 'merchant_access':
    case 'admin_access':
      return env.jwt.accessSecret;
    case 'merchant_refresh':
    case 'admin_refresh':
      return env.jwt.refreshSecret;
    case 'registration':
      return env.jwt.registrationSecret;
  }
}

function ttlFor(type: TokenType): number {
  switch (type) {
    case 'merchant_access':
    case 'admin_access':
      return env.jwt.accessTtl;
    case 'merchant_refresh':
    case 'admin_refresh':
      return env.jwt.refreshTtl;
    case 'registration':
      return env.jwt.registrationTtl;
  }
}

export function newRotationId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function sign(payload: Record<string, unknown>, type: TokenType, subject?: string): string {
  return jwt.sign({ ...payload, type }, secretFor(type), {
    expiresIn: ttlFor(type),
    issuer: ISSUER,
    ...(subject ? { subject } : {}),
  });
}

function verify<T extends JwtPayload>(token: string, type: TokenType): T {
  let decoded: JwtPayload | string;
  try {
    decoded = jwt.verify(token, secretFor(type), { issuer: ISSUER });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw AppError.unauthenticated('Your session has expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
    }
    throw AppError.unauthenticated('This session is no longer valid. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }

  if (typeof decoded === 'string' || decoded.type !== type) {
    throw AppError.unauthenticated('This session is no longer valid. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }

  return decoded as T;
}

export function issueSessionTokens(
  subject: string,
  sessionId: string,
  rotationId: string,
  scope: 'merchant' | 'admin',
): IssuedTokens {
  const accessType: TokenType = scope === 'merchant' ? 'merchant_access' : 'admin_access';
  const refreshType: TokenType = scope === 'merchant' ? 'merchant_refresh' : 'admin_refresh';

  return {
    accessToken: sign({ sid: sessionId }, accessType, subject),
    refreshToken: sign({ sid: sessionId, tid: rotationId }, refreshType, subject),
    accessTokenExpiresIn: env.jwt.accessTtl,
    refreshTokenExpiresIn: env.jwt.refreshTtl,
    tokenType: 'Bearer',
  };
}

export function verifySessionToken(token: string, type: TokenType): SessionTokenClaims {
  const claims = verify<SessionTokenClaims>(token, type);
  if (!claims.sub || !claims.sid) {
    throw AppError.unauthenticated('This session is no longer valid. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }
  return claims;
}

/**
 * Issued after OTP verification for a phone number that has no merchant yet.
 * It authorises exactly one action: completing registration for that verified phone.
 */
export function signRegistrationToken(countryCode: string, phone: string): { token: string; expiresIn: number } {
  return {
    token: sign({ countryCode, phone }, 'registration'),
    expiresIn: env.jwt.registrationTtl,
  };
}

export function verifyRegistrationToken(token: string): RegistrationTokenClaims {
  const claims = verify<RegistrationTokenClaims>(token, 'registration');
  if (!claims.countryCode || !claims.phone) {
    throw AppError.unauthenticated('Your verification has expired. Please verify your phone number again.', ErrorCode.INVALID_TOKEN);
  }
  return claims;
}
