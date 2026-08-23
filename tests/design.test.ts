import { describe, expect, it } from 'vitest';
import {
  PRESETS,
  computeStats,
  isBuildable,
  makeDefaultDesign,
  sanitizeDesign,
  validateDesign,
  cloneDesign,
} from '../src/game/design.ts';
import { WEIGHT_LIMIT_KG, MATERIALS, CHASSIS, WEAPONS } from '../src/game/parts.ts';
import { kgToLb, mpsToMph } from '../src/core/mathx.ts';

describe('weight budget', () => {
  it('caps the heavyweight class at 250 lb', () => {
    expect(kgToLb(WEIGHT_LIMIT_KG)).toBeCloseTo(250, 1);
  });

  it('every stock preset is legal and buildable', () => {
    for (const preset of PRESETS) {
      const issues = validateDesign(preset.design).filter((i) => i.level === 'error');
      expect(issues, `${preset.label}: ${issues.map((i) => i.message).join('; ')}`).toEqual([]);
      expect(isBuildable(preset.design)).toBe(true);
    }
  });

  it('every stock preset uses most of its allowance', () => {
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      expect(stats.weightUsed, `${preset.label} at ${stats.totalMass.toFixed(1)} kg`).toBeGreaterThan(0.7);
      expect(stats.totalMass).toBeLessThanOrEqual(WEIGHT_LIMIT_KG + 1e-6);
    }
  });

  it('flags an overweight build as an error', () => {
    const design = makeDefaultDesign();
    design.armorMaterialId = 'ar500';
    design.armorThicknessMm = 20;
    design.armorCoverage = 1;
    const errors = validateDesign(design).filter((i) => i.level === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]!.message).toMatch(/overweight/i);
  });

  it('rejects a weapon the chassis cannot mount', () => {
    const design = makeDefaultDesign();
    design.chassisId = 'discshell';
    design.weaponId = 'hammer';
    const errors = validateDesign(design).filter((i) => i.level === 'error');
    expect(errors.some((e) => /no mounting/i.test(e.message))).toBe(true);
  });
});

describe('derived physical quantities', () => {
  it('mass components sum to the total', () => {
    const s = computeStats(makeDefaultDesign());
    const sum =
      s.parts.chassis.frameMass +
      s.armorMass +
      s.driveMass +
      s.weaponMass +
      s.accessoryMass +
      s.electronicsMass;
    expect(s.totalMass).toBeCloseTo(sum, 6);
  });

  it('produces plausible real-world speeds', () => {
    for (const preset of PRESETS) {
      const s = computeStats(preset.design);
      const mph = mpsToMph(s.topSpeed);
      expect(mph, `${preset.label} tops out at ${mph.toFixed(1)} mph`).toBeGreaterThan(4);
      expect(mph, `${preset.label} tops out at ${mph.toFixed(1)} mph`).toBeLessThan(40);
    }
  });

  it('produces spinner energies in the real kilojoule range', () => {
    const spinners = PRESETS.filter((p) => computeStats(p.design).weaponEnergy > 0);
    expect(spinners.length).toBeGreaterThan(2);
    for (const preset of spinners) {
      const s = computeStats(preset.design);
      const kj = s.weaponEnergy / 1000;
      expect(kj, `${preset.label} stores ${kj.toFixed(1)} kJ`).toBeGreaterThan(2);
      expect(kj, `${preset.label} stores ${kj.toFixed(1)} kJ`).toBeLessThan(120);
      // Real weapons wind up in a handful of seconds, not a minute.
      expect(s.weaponSpinupTime, `${preset.label} spin-up`).toBeLessThan(20);
    }
  });

  it('thicker armour is heavier and tougher', () => {
    const thin = makeDefaultDesign();
    thin.armorThicknessMm = 4;
    const thick = cloneDesign(thin);
    thick.armorThicknessMm = 12;
    expect(computeStats(thick).armorMass).toBeGreaterThan(computeStats(thin).armorMass);
    expect(computeStats(thick).armorHp).toBeGreaterThan(computeStats(thin).armorHp);
  });

  it('acceleration is limited by traction, not by raw motor force', () => {
    const design = makeDefaultDesign();
    design.gearRatio = 40;
    const s = computeStats(design);
    expect(s.driveForce).toBeGreaterThan(s.tractionLimit);
    expect(s.acceleration).toBeCloseTo(s.tractionLimit / s.totalMass, 6);
  });
});

describe('sanitizeDesign', () => {
  it('repairs unknown ids instead of throwing', () => {
    const design = sanitizeDesign({
      name: 'Junk',
      chassisId: 'nope',
      armorMaterialId: 'unobtainium',
      weaponId: 'deathray',
      accessories: ['srimech', 'teleporter'],
      armorThicknessMm: 900,
      gearRatio: -4,
    });
    expect(CHASSIS.some((c) => c.id === design.chassisId)).toBe(true);
    expect(MATERIALS.some((m) => m.id === design.armorMaterialId)).toBe(true);
    expect(WEAPONS.some((w) => w.id === design.weaponId)).toBe(true);
    expect(design.accessories).toEqual(['srimech']);
    expect(design.armorThicknessMm).toBeLessThanOrEqual(20);
    expect(design.gearRatio).toBeGreaterThanOrEqual(6);
  });

  it('survives garbage input', () => {
    expect(() => sanitizeDesign(null)).not.toThrow();
    expect(() => sanitizeDesign('nope')).not.toThrow();
    expect(sanitizeDesign(undefined).name).toBe(makeDefaultDesign().name);
  });
});
