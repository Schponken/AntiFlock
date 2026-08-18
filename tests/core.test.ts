import { describe, it, expect } from 'vitest';
import {
  approach,
  clamp,
  clamp01,
  damp,
  deadzone,
  formatClock,
  kgToLb,
  kineticEnergy,
  lbToKg,
  lerp,
  mpsToMph,
  radPerSecToRpm,
  remap,
  rpmToRadPerSec,
  smoothstep,
  spinnerInertia,
} from '../src/core/math';
import { Rng } from '../src/core/rng';

describe('maths helpers', () => {
  it('clamps', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it('interpolates and remaps', () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(remap(5, 0, 10, 100, 200)).toBe(150);
    expect(remap(-5, 0, 10, 100, 200)).toBe(100);
    expect(remap(50, 0, 10, 100, 200)).toBe(200);
    expect(remap(1, 4, 4, 7, 9)).toBe(7); // degenerate range
  });

  it('smoothsteps with flat ends', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5, 9);
  });

  it('damps toward a target and is frame-rate independent', () => {
    // One half-life should close exactly half the gap.
    expect(damp(0, 10, 0.5, 0.5)).toBeCloseTo(5, 9);
    // Two small steps must land where one big step does.
    const oneBig = damp(0, 10, 0.3, 0.2);
    let two = 0;
    two = damp(two, 10, 0.3, 0.1);
    two = damp(two, 10, 0.3, 0.1);
    expect(two).toBeCloseTo(oneBig, 9);
  });

  it('approaches without overshooting', () => {
    expect(approach(0, 1, 0.25)).toBe(0.25);
    expect(approach(0.9, 1, 0.25)).toBe(1);
    expect(approach(1.5, 1, 0.25)).toBe(1.25);
  });

  it('applies a deadzone that still reaches full travel', () => {
    expect(deadzone(0.05, 0.12)).toBe(0);
    expect(deadzone(1, 0.12)).toBeCloseTo(1, 9);
    expect(deadzone(-1, 0.12)).toBeCloseTo(-1, 9);
  });

  it('round-trips unit conversions', () => {
    expect(radPerSecToRpm(rpmToRadPerSec(3000))).toBeCloseTo(3000, 9);
    expect(kgToLb(lbToKg(250))).toBeCloseTo(250, 9);
    expect(mpsToMph(1)).toBeCloseTo(2.2369362920544, 9);
  });

  it('computes kinetic energy', () => {
    expect(kineticEnergy(100, 10)).toBe(5000);
  });

  it('puts more inertia in a rim-weighted rotor', () => {
    const rim = spinnerInertia(30, 0.5, 0.9);
    const solid = spinnerInertia(30, 0.5, 0.0);
    expect(rim).toBeGreaterThan(solid);
    // A pure disc is 1/2 m r^2.
    expect(solid).toBeCloseTo(0.5 * 30 * 0.25, 9);
  });

  it('formats the match clock', () => {
    expect(formatClock(180)).toBe('3:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(9.7)).toBe('0:09');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('deterministic rng', () => {
  it('repeats exactly for a given seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });

  it('diverges for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('stays inside [0,1)', () => {
    const r = new Rng(7);
    for (let i = 0; i < 5000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('never gets stuck on zero', () => {
    const r = new Rng(0);
    const seen = new Set<number>();
    for (let i = 0; i < 50; i++) seen.add(r.next());
    expect(seen.size).toBeGreaterThan(40);
  });

  it('produces integers across the full inclusive range', () => {
    const r = new Rng(11);
    const seen = new Set<number>();
    for (let i = 0; i < 3000; i++) seen.add(r.int(1, 6));
    expect([...seen].sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('has a roughly uniform mean', () => {
    const r = new Rng(2024);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += r.next();
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });

  it('produces a gaussian with about the requested spread', () => {
    const r = new Rng(5);
    let sumSq = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = r.gaussian(2);
      sumSq += v * v;
    }
    expect(Math.sqrt(sumSq / n)).toBeGreaterThan(1.7);
    expect(Math.sqrt(sumSq / n)).toBeLessThan(2.3);
  });

  it('picks from a list and rejects an empty one', () => {
    const r = new Rng(3);
    expect(['x', 'y']).toContain(r.pick(['x', 'y']));
    expect(() => r.pick([])).toThrow(/empty/);
  });

  it('can be reseeded back to a known state', () => {
    const r = new Rng(1);
    const first = [r.next(), r.next(), r.next()];
    r.reseed(1);
    expect([r.next(), r.next(), r.next()]).toEqual(first);
  });
});
