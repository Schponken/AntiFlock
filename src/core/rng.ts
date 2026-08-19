/**
 * Deterministic RNG (mulberry32). Every stochastic system in the game draws from a
 * seeded stream so a match can be replayed and the physics tests stay reproducible.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  /** Symmetric spread around zero: [-mag, +mag). */
  spread(mag: number): number {
    return this.range(-mag, mag);
  }

  bool(chanceTrue = 0.5): boolean {
    return this.next() < chanceTrue;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))]!;
  }

  /** Fisher-Yates, returns a new array. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/** Shared stream for cosmetic effects, where determinism across runs does not matter. */
export const fxRng = new Rng(0x1337c0de);
