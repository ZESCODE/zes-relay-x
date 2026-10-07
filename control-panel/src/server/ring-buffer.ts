/**
 * Append-only ring buffers + the statistics helpers used by the metrics module.
 *
 * Ring buffers are written by a single producer and always read through
 * `snapshot()`, which copies the visible window into a fresh array so readers
 * never observe a partially written structure.
 */

export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private cursor = 0;
  private length = 0;
  private written = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`RingBuffer capacity must be a positive integer, received ${capacity}`);
    }
    this.items = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.items[this.cursor] = value;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.length < this.capacity) this.length += 1;
    this.written += 1;
  }

  /** Copy of the buffer contents, oldest → newest. */
  snapshot(): T[] {
    const out: T[] = new Array<T>(this.length);
    const start = (this.cursor - this.length + this.capacity) % this.capacity;
    for (let index = 0; index < this.length; index += 1) {
      out[index] = this.items[(start + index) % this.capacity] as T;
    }
    return out;
  }

  get size(): number {
    return this.length;
  }

  /** Total number of values ever pushed (not limited by capacity). */
  get totalWritten(): number {
    return this.written;
  }

  get isFull(): boolean {
    return this.length === this.capacity;
  }

  clear(): void {
    this.items.fill(undefined);
    this.cursor = 0;
    this.length = 0;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Numerical helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Nearest-rank percentile on an unsorted array (0..1). Returns null if empty. */
export function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(Math.max(fraction, 0), 1);
  const rank = Math.ceil(clamped * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function maxOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let best = Number.NEGATIVE_INFINITY;
  for (const value of values) if (value > best) best = value;
  return best === Number.NEGATIVE_INFINITY ? null : best;
}

export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function round(value: number | null, digits = 2): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
