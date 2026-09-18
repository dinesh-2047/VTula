import mongoose, { Schema, Model, Document } from 'mongoose';

/**
 * Atomic sequence counters.
 *
 * Replaces the previous `Math.random()`-based ID generation, which could
 * collide against the `unique` indexes on `applicationNo` / `certNo` and had no
 * retry path. Sequence numbers are also what the spec asks for: human-readable,
 * auditable identifiers like `VT-APP-2026-000928`.
 */
export interface ICounter extends Document {
  key: string;
  seq: number;
}

const CounterSchema = new Schema<ICounter>({
  key: { type: String, required: true, unique: true, index: true },
  seq: { type: Number, required: true, default: 0 },
});

const Counter: Model<ICounter> =
  (mongoose.models.Counter as Model<ICounter>) ||
  mongoose.model<ICounter>('Counter', CounterSchema);

export default Counter;

/**
 * Atomically increments and returns the next value for `key`.
 * Safe under concurrency — `findOneAndUpdate` with `$inc` is a single
 * server-side operation.
 */
export async function nextSequence(key: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    { key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  ).lean<{ seq: number }>();

  if (!doc) throw new Error(`Failed to allocate sequence for "${key}"`);
  return doc.seq;
}
