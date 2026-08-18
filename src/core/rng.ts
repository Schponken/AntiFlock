/**
 * Deterministic pseudo-random source.
 *
 * The simulation must be reproducible for tests and for replays, so nothing in
 * `src/sim` may call `Math.random()` — it goes through one of these instead.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x1a2b3c4d) {
    // Avoid the zero fixed point of xorshift.
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  /** Next float in [0,1). */
  next(): number {
    // xorshift32 — small, fast, good enough for cosmetic and AI jitter.
    let x = this.state;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x / 0x100000000;
  }

  /** Float in [min,max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min,max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniformly pick one element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty list');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Signed value in [-spread, spread). */
  spread(spread: number): number {
    return this.range(-spread, spread);
  }

  /**
   * Approximately normal, mean 0, with the requested standard deviation.
   * Six uniforms sum to variance 6/12 = 0.5, so dividing by sqrt(0.5)
   * normalises the result to unit variance.
   */
  gaussian(stdDev = 1): number {
    let s = 0;
    for (let i = 0; i < 6; i++) s += this.next();
    return ((s - 3) / Math.SQRT1_2) * stdDev;
  }

  /** Restore a known state, for replaying a sequence. */
  reseed(seed: number): void {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
}

/** Shared cosmetic RNG for renderer-only effects, where determinism is optional. */
export const fxRng = new Rng(0xc0ffee);
