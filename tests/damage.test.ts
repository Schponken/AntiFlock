import { describe, it, expect, beforeEach } from 'vitest';
import {
  ARMOR_ZONES,
  DAMAGE_PER_JOULE,
  MIN_DAMAGING_ENERGY_J,
  ZONE_SHARE,
  applyHit,
  condition,
  createHealth,
  driveFraction,
  isImmobilised,
  isWeaponDead,
  type BotHealth,
  type Hit,
} from '../src/sim/damage';
import { computeStats, defaultDesign, type BotStats } from '../src/sim/parts';
import { Rng } from '../src/core/rng';

function hit(over: Partial<Hit> = {}): Hit {
  return { energyJ: 5000, zone: 'front', squareness: 1, bite: 1, ...over };
}

describe('damage model', () => {
  let stats: BotStats;
  let health: BotHealth;
  let rng: Rng;

  beforeEach(() => {
    stats = computeStats(defaultDesign());
    health = createHealth(stats);
    rng = new Rng(1234);
  });

  it('starts at full condition', () => {
    expect(condition(health)).toBeCloseTo(1, 6);
    expect(isImmobilised(health)).toBe(false);
    expect(isWeaponDead(health)).toBe(false);
    expect(driveFraction(health)).toBe(1);
  });

  it('distributes the armour budget across all six zones', () => {
    const total = ARMOR_ZONES.reduce((s, z) => s + health.zoneMax[z], 0);
    expect(total).toBeCloseTo(stats.armorHp, 6);
    // The front is the thickest, the belly the thinnest.
    expect(health.zoneMax.front).toBeGreaterThan(health.zoneMax.rear);
    expect(health.zoneMax.bottom).toBeLessThan(health.zoneMax.top);
  });

  it('shares sum to exactly one', () => {
    const sum = ARMOR_ZONES.reduce((s, z) => s + ZONE_SHARE[z], 0);
    expect(sum).toBeCloseTo(1, 9);
  });

  it('ignores a scuff below the damage threshold', () => {
    const result = applyHit(health, stats, hit({ energyJ: MIN_DAMAGING_ENERGY_J - 1 }), rng);
    expect(result.hpLost).toBe(0);
    expect(health.zone.front).toBe(health.zoneMax.front);
  });

  it('removes armour from the zone that was struck, and only that zone', () => {
    applyHit(health, stats, hit({ zone: 'left', energyJ: 3000 }), rng);
    expect(health.zone.left).toBeLessThan(health.zoneMax.left);
    expect(health.zone.front).toBe(health.zoneMax.front);
    expect(health.zone.right).toBe(health.zoneMax.right);
  });

  it('scales damage with energy', () => {
    const small = createHealth(stats);
    const big = createHealth(stats);
    const r1 = applyHit(small, stats, hit({ energyJ: 1000 }), new Rng(1));
    const r2 = applyHit(big, stats, hit({ energyJ: 4000 }), new Rng(1));
    expect(r2.hpLost).toBeGreaterThan(r1.hpLost * 3.5);
  });

  it('makes a glancing blow far weaker than a square one', () => {
    const glancing = createHealth(stats);
    const square = createHealth(stats);
    const g = applyHit(glancing, stats, hit({ squareness: 0.15 }), new Rng(1));
    const s = applyHit(square, stats, hit({ squareness: 1 }), new Rng(1));
    expect(g.hpLost).toBeLessThan(s.hpLost * 0.3);
  });

  it('penetrates the plate once the zone is used up, then hits the frame harder', () => {
    // Beat on one zone until it opens.
    let penetratedOn = -1;
    for (let i = 0; i < 40; i++) {
      const r = applyHit(health, stats, hit({ zone: 'top', energyJ: 4000 }), rng);
      if (r.penetrated) {
        penetratedOn = i;
        break;
      }
    }
    expect(penetratedOn).toBeGreaterThanOrEqual(0);
    expect(health.zone.top).toBe(0);

    const structureBefore = health.structure;
    const after = applyHit(health, stats, hit({ zone: 'top', energyJ: 4000 }), rng);
    expect(after.wasExposed).toBe(true);
    expect(health.structure).toBeLessThan(structureBefore);
  });

  it('lets plastic armour soak more energy than steel for the same hit', () => {
    const uhmwStats = computeStats({ ...defaultDesign(), armorId: 'uhmw', armorThicknessMm: 4 });
    const steelStats = computeStats({ ...defaultDesign(), armorId: 'ar500', armorThicknessMm: 4 });
    const u = applyHit(createHealth(uhmwStats), uhmwStats, hit({ energyJ: 4000 }), new Rng(7));
    const s = applyHit(createHealth(steelStats), steelStats, hit({ energyJ: 4000 }), new Rng(7));
    expect(u.effectiveEnergyJ).toBeLessThan(s.effectiveEnergyJ);
  });

  it('destroys a wheel with enough direct hits and reduces drive', () => {
    for (let i = 0; i < 200 && health.wheels[0]! > 0; i++) {
      applyHit(health, stats, hit({ onWheel: true, wheelIndex: 0, energyJ: 2000 }), rng);
    }
    expect(health.wheels[0]).toBe(0);
    expect(driveFraction(health)).toBeLessThan(1);
    expect(isImmobilised(health)).toBe(false); // three wheels left
  });

  it('immobilises the robot once every wheel is gone', () => {
    for (let w = 0; w < health.wheels.length; w++) {
      for (let i = 0; i < 300 && health.wheels[w]! > 0; i++) {
        applyHit(health, stats, hit({ onWheel: true, wheelIndex: w, energyJ: 2000 }), rng);
      }
    }
    expect(driveFraction(health)).toBe(0);
    expect(isImmobilised(health)).toBe(true);
  });

  it('immobilises the robot once the frame is destroyed', () => {
    for (let i = 0; i < 500 && health.structure > 0; i++) {
      applyHit(health, stats, hit({ zone: 'front', energyJ: 8000 }), rng);
    }
    expect(health.structure).toBe(0);
    expect(isImmobilised(health)).toBe(true);
    expect(condition(health)).toBeLessThan(0.5);
  });

  it('kills the weapon with weapon-on-weapon hits', () => {
    for (let i = 0; i < 400 && health.weapon > 0; i++) {
      applyHit(health, stats, hit({ onWeapon: true, energyJ: 3000 }), rng);
    }
    expect(isWeaponDead(health)).toBe(true);
  });

  it('never drives any pool negative', () => {
    const rng2 = new Rng(99);
    for (let i = 0; i < 300; i++) {
      const zone = ARMOR_ZONES[i % ARMOR_ZONES.length]!;
      applyHit(health, stats, hit({ zone, energyJ: 60_000 }), rng2);
    }
    for (const z of ARMOR_ZONES) expect(health.zone[z]).toBeGreaterThanOrEqual(0);
    expect(health.structure).toBeGreaterThanOrEqual(0);
    expect(health.weapon).toBeGreaterThanOrEqual(0);
    for (const w of health.wheels) expect(w).toBeGreaterThanOrEqual(0);
    expect(condition(health)).toBeGreaterThanOrEqual(0);
    expect(condition(health)).toBeLessThanOrEqual(1);
  });

  it('accumulates energy taken for the judges', () => {
    applyHit(health, stats, hit({ energyJ: 5000 }), rng);
    applyHit(health, stats, hit({ energyJ: 5000 }), rng);
    expect(health.energyTakenJ).toBeGreaterThan(9000);
  });

  it('is deterministic for a given seed', () => {
    const run = () => {
      const h = createHealth(stats);
      const r = new Rng(4242);
      for (let i = 0; i < 50; i++) applyHit(h, stats, hit({ zone: 'left', energyJ: 9000 }), r);
      return { structure: h.structure, wheels: [...h.wheels], left: h.zone.left };
    };
    expect(run()).toEqual(run());
  });

  it('converts joules to hit points at the documented rate on bare structure', () => {
    // Strip the front plate first, then measure a known hit.
    const h = createHealth(stats);
    h.zone.front = 0;
    const before = h.structure;
    const energy = 1000;
    applyHit(h, stats, hit({ energyJ: energy, squareness: 1, bite: 1 }), rng);
    const soaked = energy * (1 - stats.armor.absorption * 0.25);
    const expected = soaked * DAMAGE_PER_JOULE * 1.75;
    expect(before - h.structure).toBeCloseTo(expected, 5);
  });
});
