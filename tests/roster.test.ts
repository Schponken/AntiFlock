import { describe, it, expect } from 'vitest';
import { ROSTER, makeLegal, pickOpponent, randomDesign } from '../src/sim/roster';
import { computeStats, defaultDesign, isMountCompatible, WEIGHT_LIMIT_KG } from '../src/sim/parts';
import { Rng } from '../src/core/rng';

describe('opponent roster', () => {
  it('is not empty and has unique names', () => {
    expect(ROSTER.length).toBeGreaterThanOrEqual(6);
    const names = ROSTER.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('is entirely legal — every opponent makes weight and can mount its weapon', () => {
    for (const design of ROSTER) {
      const stats = computeStats(design);
      expect(stats.legal, `${design.name} is illegal`).toBe(true);
      expect(stats.totalMassKg).toBeLessThanOrEqual(WEIGHT_LIMIT_KG + 1e-6);
      expect(isMountCompatible(stats.chassis, stats.weapon)).toBe(true);
    }
  });

  it('covers a genuine spread of designs rather than reskins of one robot', () => {
    const weapons = new Set(ROSTER.map((d) => d.weaponId));
    const chassis = new Set(ROSTER.map((d) => d.chassisId));
    const drives = new Set(ROSTER.map((d) => d.driveId));
    expect(weapons.size).toBeGreaterThanOrEqual(5);
    expect(chassis.size).toBeGreaterThanOrEqual(4);
    expect(drives.size).toBeGreaterThanOrEqual(3);
  });

  it('avoids a mirror match when it can', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 60; i++) {
      expect(pickOpponent(rng, 'TOMBWEIGHT').name).not.toBe('TOMBWEIGHT');
    }
  });

  it('returns a copy, so mutating an opponent cannot corrupt the roster', () => {
    const rng = new Rng(9);
    const picked = pickOpponent(rng);
    const original = ROSTER.find((d) => d.name === picked.name)!;
    picked.armorThicknessMm = 999;
    expect(original.armorThicknessMm).not.toBe(999);
  });
});

describe('makeLegal', () => {
  it('trims armour until the design makes weight', () => {
    const overweight = { ...defaultDesign(), armorThicknessMm: 12 };
    expect(computeStats(overweight).legal).toBe(false);
    expect(computeStats(makeLegal(overweight)).legal).toBe(true);
  });

  it('leaves an already legal design alone', () => {
    const fine = { ...defaultDesign(), armorThicknessMm: 2 };
    expect(makeLegal(fine).armorThicknessMm).toBe(2);
  });
});

describe('randomDesign', () => {
  it('always produces a legal robot', () => {
    const rng = new Rng(1234);
    for (let i = 0; i < 500; i++) {
      const design = randomDesign(rng);
      const stats = computeStats(design);
      expect(stats.legal, `illegal random design: ${JSON.stringify(design)}`).toBe(true);
    }
  });

  it('gives every robot a name that fits the hull decal', () => {
    const rng = new Rng(55);
    for (let i = 0; i < 100; i++) {
      const design = randomDesign(rng);
      expect(design.name.length).toBeGreaterThan(0);
      expect(design.name.length).toBeLessThanOrEqual(16);
    }
  });

  it('is deterministic for a given seed', () => {
    const first = randomDesign(new Rng(77));
    const second = randomDesign(new Rng(77));
    expect(first).toEqual(second);
  });

  it('explores a wide range of the catalogue', () => {
    const rng = new Rng(2);
    const weapons = new Set<string>();
    const chassis = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const design = randomDesign(rng);
      weapons.add(design.weaponId);
      chassis.add(design.chassisId);
    }
    expect(weapons.size).toBeGreaterThanOrEqual(7);
    expect(chassis.size).toBeGreaterThanOrEqual(6);
  });
});
