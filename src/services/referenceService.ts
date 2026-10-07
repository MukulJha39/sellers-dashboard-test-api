import type { ClientSession, Types } from 'mongoose';
import { REFERENCE_PREFIXES } from '../config/commerce';
import { Counter } from '../models/Counter';

export type ReferenceKind = keyof typeof REFERENCE_PREFIXES;

const PAD_TO = 4;

/**
 * Allocates the next human-readable reference for a merchant, such as `PUR-0007`.
 *
 * Numbers restart per merchant, which is what a merchant expects: their first purchase
 * is number one regardless of how many other businesses use the product.
 *
 * The number is consumed even if the surrounding work later fails, so a sequence can
 * have gaps. That is the right trade: a gap is harmless and explainable, whereas
 * re-using a number would put two different purchases under one reference, and a
 * merchant quoting that reference to a supplier would be pointing at the wrong thing.
 */
export async function nextReference(
  merchantId: Types.ObjectId,
  kind: ReferenceKind,
  session?: ClientSession,
): Promise<string> {
  const counter = await Counter.findOneAndUpdate(
    { _id: `${String(merchantId)}:${kind}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, session },
  );

  const seq = counter?.seq ?? 1;
  return `${REFERENCE_PREFIXES[kind]}-${String(seq).padStart(PAD_TO, '0')}`;
}
