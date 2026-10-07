import type { Request } from 'express';
import { Types } from 'mongoose';
import { AuditLog, type AuditChange, type AuditActorType } from '../models/AuditLog';
import { logger } from '../utils/logger';

export interface AuditInput {
  actorType: AuditActorType;
  actorId?: Types.ObjectId | string | null;
  actorLabel: string;
  action: string;
  targetType: string;
  targetId?: Types.ObjectId | string | null;
  summary: string;
  changes?: AuditChange[];
  metadata?: Record<string, unknown> | null;
  req?: Request;
}

function toObjectId(value: Types.ObjectId | string | null | undefined): Types.ObjectId | null {
  if (!value) return null;
  if (value instanceof Types.ObjectId) return value;
  return Types.ObjectId.isValid(value) ? new Types.ObjectId(value) : null;
}

/**
 * Writes an audit entry (PRD section 27). Auditing must never break the action it
 * records, so a write failure is logged rather than propagated.
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await AuditLog.create({
      actorType: input.actorType,
      actorId: toObjectId(input.actorId),
      actorLabel: input.actorLabel,
      action: input.action,
      targetType: input.targetType,
      targetId: toObjectId(input.targetId),
      summary: input.summary,
      changes: input.changes ?? [],
      ip: input.req?.ip ?? null,
      requestId: input.req?.requestId ?? null,
      metadata: input.metadata ?? null,
    });
  } catch (error) {
    logger.error('Failed to write audit entry', {
      action: input.action,
      targetType: input.targetType,
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }
}

/** Builds a change list from two snapshots, keeping only fields that actually differ. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: readonly string[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = before[field];
    const to = after[field];
    if (from !== to) changes.push({ field, from: from ?? null, to: to ?? null });
  }
  return changes;
}
