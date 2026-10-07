import { Schema, model, type Document, type Model } from 'mongoose';

/**
 * One monotonically increasing sequence per merchant per kind of document, so a
 * purchase can be called PUR-0001 rather than a database id.
 *
 * A separate collection rather than a field on the business, because the increment has
 * to be atomic under concurrent writes: two purchases created at the same moment must
 * not be handed the same number. `findOneAndUpdate` with `$inc` and `upsert` is a
 * single atomic operation, which `read, add one, write` is not.
 */
export interface CounterDocument extends Document<string> {
  /** `<merchantId>:<kind>`, so the key itself scopes the sequence. */
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDocument>(
  {
    _id: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: 'counters', versionKey: false },
);

export const Counter: Model<CounterDocument> = model<CounterDocument>('Counter', counterSchema);
