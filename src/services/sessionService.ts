import type { Request } from 'express';
import { Types } from 'mongoose';
import { env } from '../config/env';
import { Session, type SessionSubject } from '../models/Session';
import { AppError, ErrorCode } from '../utils/AppError';
import { issueSessionTokens, newRotationId, verifySessionToken, type IssuedTokens } from '../utils/jwt';
import { logger } from '../utils/logger';

function requestMeta(req?: Request): { userAgent: string | null; ip: string | null } {
  return {
    userAgent: req?.header('user-agent')?.slice(0, 300) ?? null,
    ip: req?.ip ?? null,
  };
}

export async function createSession(
  subjectType: SessionSubject,
  subjectId: Types.ObjectId,
  req?: Request,
): Promise<{ sessionId: string; tokens: IssuedTokens }> {
  const rotationId = newRotationId();
  const { userAgent, ip } = requestMeta(req);

  const session = await Session.create({
    subjectType,
    subjectId,
    rotationId,
    userAgent,
    ip,
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + env.jwt.refreshTtl * 1000),
  });

  return {
    sessionId: String(session._id),
    tokens: issueSessionTokens(String(subjectId), String(session._id), rotationId, subjectType),
  };
}

/**
 * Rotates a refresh token. A token that presents a stale rotation id has been replayed,
 * so the whole session is revoked rather than silently refreshed.
 */
export async function refreshSession(
  refreshToken: string,
  subjectType: SessionSubject,
): Promise<{ sessionId: string; subjectId: string; tokens: IssuedTokens }> {
  const claims = verifySessionToken(
    refreshToken,
    subjectType === 'merchant' ? 'merchant_refresh' : 'admin_refresh',
  );

  const session = await Session.findById(claims.sid);
  if (!session || session.subjectType !== subjectType || String(session.subjectId) !== claims.sub) {
    throw AppError.unauthenticated('This session is no longer valid. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }
  if (session.revokedAt) {
    throw AppError.unauthenticated('This session has ended. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    throw AppError.unauthenticated('Your session has expired. Please sign in again.', ErrorCode.TOKEN_EXPIRED);
  }

  if (session.rotationId !== claims.tid) {
    session.revokedAt = new Date();
    session.revokedReason = 'refresh_token_reuse';
    await session.save();
    logger.warn('Refresh token reuse detected; session revoked', { sessionId: String(session._id) });
    throw AppError.unauthenticated('This session has ended. Please sign in again.', ErrorCode.INVALID_TOKEN);
  }

  const rotationId = newRotationId();
  session.rotationId = rotationId;
  session.lastUsedAt = new Date();
  await session.save();

  return {
    sessionId: String(session._id),
    subjectId: claims.sub,
    tokens: issueSessionTokens(claims.sub, String(session._id), rotationId, subjectType),
  };
}

export async function revokeSession(sessionId: string, reason = 'logout'): Promise<void> {
  await Session.updateOne(
    { _id: sessionId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function revokeAllSessions(
  subjectType: SessionSubject,
  subjectId: Types.ObjectId,
  reason: string,
  /**
   * A session to leave alone. Used when someone changes their own password: every other
   * device is signed out, but the tab they are working in keeps going.
   */
  exceptSessionId?: string,
): Promise<number> {
  const filter: Record<string, unknown> = { subjectType, subjectId, revokedAt: null };
  if (exceptSessionId && Types.ObjectId.isValid(exceptSessionId)) {
    filter._id = { $ne: new Types.ObjectId(exceptSessionId) };
  }

  const result = await Session.updateMany(filter, {
    $set: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.modifiedCount;
}
