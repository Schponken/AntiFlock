import { describe, it, expect } from 'vitest';
import {
  ARMOR,
  CHASSIS,
  DRIVES,
  WEAPONS,
  WHEELS,
  WEIGHT_LIMIT_KG,
  cloneDesign,
  computeStats,
  defaultDesign,
  getWeapon,
  isMountCompatible,
  maxLegalThickness,
  type BotDesign,
} from '../src/sim/parts';
import { mpsToMph, radPerSecToRpm } from '../src/core/math';

describe('catalogue integrity', () => {
  it('has unique ids in every category', () => {
    const groups = [CHASSIS, ARMOR, DRIVES, WHEELS, WEAPONS];
    for (const group of groups) {
      const ids = group.map((g) => g.id);
      expect(new Set(ids).size, `duplicate id in ${JSON.stringify(ids)}`).toBe(ids.length);
    }
  });

  it('offers a real choice in every category', () => {
    expect(CHASSIS.length).toBeGreaterThanOrEqual(5);
    expect(ARMOR.length).toBeGreaterThanOrEqual(5);
    expect(DRIVES.length).toBeGreaterThanOrEqual(4);
    expect(WEAPONS.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every chassis at least one weapon it can carry', () => {
    for (const chassis of CHASSIS) {
      const fits = WEAPONS.filter((w) => isMountCompatible(chassis, w));
      expect(fits.length, `${chassis.id} can carry nothing`).toBeGreaterThan(0);
    }
  });

  it('lets every weapon be carried by at least one chassis', () => {
    for (const weapon of WEAPONS) {
      const hosts = CHASSIS.filter((c) => isMountCompatible(c, weapon));
      expect(hosts.length, `${weapon.id} fits nothing`).toBeGreaterThan(0);
    }
  });

  it('keeps armour thickness limits positive and physical', () => {
    for (const armor of ARMOR) {
      expect(armor.maxThicknessMm).toBeGreaterThan(0);
      expect(armor.densityKgM3).toBeGreaterThan(500);
      expect(armor.absorption).toBeGreaterThanOrEqual(0);
      expect(armor.absorption).toBeLessThan(1);
    }
  });
});

describe('computeStats', () => {
  it('produces a legal default robot', () => {
    const stats = computeStats(defaultDesign());
    expect(stats.legal).toBe(true);
    expect(stats.totalMassKg).toBeLessThanOrEqual(WEIGHT_LIMIT_KG + 1e-9);
    expect(stats.overweightKg).toBe(0);
  });

  it('prices armour by volume and density', () => {
    const design = defaultDesign();
    const thin = computeStats({ ...design, armorThicknessMm: 2 });
    const thick = computeStats({ ...design, armorThicknessMm: 4 });
    // Twice the thickness is exactly twice the plate mass.
    expect(thick.armorMassKg).toBeCloseTo(thin.armorMassKg * 2, 6);
    expect(thick.armorHp).toBeCloseTo(thin.armorHp * 2, 6);
  });

  it('makes steel heavier than titanium for the same thickness', () => {
    const design = defaultDesign();
    const ti = computeStats({ ...design, armorId: 'ti64', armorThicknessMm: 4 });
    const steel = computeStats({ ...design, armorId: 'ar500', armorThicknessMm: 4 });
    expect(steel.armorMassKg).toBeGreaterThan(ti.armorMassKg);
    expect(steel.armorHp).toBeGreaterThan(ti.armorHp);
  });

  it('slows a robot down as it gets heavier', () => {
    const design = defaultDesign();
    const light = computeStats({ ...design, armorThicknessMm: 1 });
    const heavy = computeStats({ ...design, armorThicknessMm: 6 });
    expect(heavy.totalMassKg).toBeGreaterThan(light.totalMassKg);
    expect(heavy.topSpeedMps).toBeLessThan(light.topSpeedMps);
    expect(heavy.accelMps2).toBeLessThan(light.accelMps2);
  });

  it('reports plausible real-world speeds', () => {
    for (const drive of DRIVES) {
      const stats = computeStats({ ...defaultDesign(), driveId: drive.id, armorThicknessMm: 2 });
      const mph = mpsToMph(stats.topSpeedMps);
      expect(mph, `${drive.id} top speed`).toBeGreaterThan(6);
      expect(mph, `${drive.id} top speed`).toBeLessThan(35);
    }
  });

  it('computes spinner energy in a realistic band', () => {
    const bar = computeStats({ ...defaultDesign(), weaponId: 'bar', armorThicknessMm: 2 });
    // A 30 kg bar at 1400 rpm is a few tens of kilojoules.
    expect(bar.weaponEnergyJ).toBeGreaterThan(20_000);
    expect(bar.weaponEnergyJ).toBeLessThan(120_000);
    // Tip speed should be a few hundred km/h.
    expect(bar.tipSpeedMps).toBeGreaterThan(40);
    expect(bar.tipSpeedMps).toBeLessThan(200);
    // And it should take a real number of seconds to get there.
    expect(bar.spinUpTime).toBeGreaterThan(2);
    expect(bar.spinUpTime).toBeLessThan(60);
  });

  it('gives a heavier rotor more energy but a longer spin-up', () => {
    const base = { ...defaultDesign(), armorThicknessMm: 1 };
    const bar = computeStats({ ...base, weaponId: 'bar' });
    const big = computeStats({ ...base, weaponId: 'bigbar' });
    expect(big.weaponEnergyJ).toBeGreaterThan(bar.weaponEnergyJ);
    expect(big.spinUpTime).toBeGreaterThan(bar.spinUpTime);
  });

  it('treats a burst weapon as stored energy with no spin-up', () => {
    const flipper = computeStats({
      ...defaultDesign(),
      chassisId: 'wedge',
      weaponId: 'flipper',
      armorThicknessMm: 3,
    });
    expect(flipper.weaponEnergyJ).toBe(getWeapon('flipper').burstJ);
    expect(flipper.spinUpTime).toBe(0);
  });

  it('flags a design that cannot make weight', () => {
    const stats = computeStats({ ...defaultDesign(), armorThicknessMm: 12 });
    expect(stats.legal).toBe(false);
    expect(stats.overweightKg).toBeGreaterThan(0);
  });

  it('flags a weapon the chassis cannot mount', () => {
    // The bar frame has no vertical mount.
    const stats = computeStats({ ...defaultDesign(), weaponId: 'disc', armorThicknessMm: 1 });
    expect(stats.legal).toBe(false);
  });

  it('keeps driving inverted and self-righting as separate capabilities', () => {
    // An invertible frame drives either way up and never needs righting.
    const invertibleFrame = computeStats({ ...defaultDesign(), armorThicknessMm: 1 });
    expect(invertibleFrame.invertible).toBe(true);
    expect(invertibleFrame.selfRighting).toBe(true);

    const base: BotDesign = {
      ...defaultDesign(),
      chassisId: 'wedge',
      weaponId: 'flipper',
      armorThicknessMm: 2,
    };
    // A self-righting arm does not let you *drive* upside down — it flips you
    // back over. Conflating the two would mean a robot with an srimech never
    // bothered to use it.
    const withArm = computeStats({ ...base, srimech: true });
    expect(withArm.invertible).toBe(false);
    expect(withArm.selfRighting).toBe(true);

    const without = computeStats({ ...base, srimech: false });
    expect(without.invertible).toBe(false);
    expect(without.selfRighting).toBe(false);
  });

  it('rejects unknown part ids loudly', () => {
    expect(() => computeStats({ ...defaultDesign(), armorId: 'unobtanium' })).toThrow(/Unknown armor/);
  });

  it('is pure — the same design always gives the same stats', () => {
    const design = defaultDesign();
    const a = computeStats(design);
    const b = computeStats(cloneDesign(design));
    expect(a.totalMassKg).toBe(b.totalMassKg);
    expect(a.weaponEnergyJ).toBe(b.weaponEnergyJ);
    expect(a.armorHp).toBe(b.armorHp);
  });
});

describe('maxLegalThickness', () => {
  it('returns a thickness that exactly makes weight', () => {
    const design = defaultDesign();
    const t = maxLegalThickness(design);
    expect(t).toBeGreaterThan(0);
    const atLimit = computeStats({ ...design, armorThicknessMm: t });
    expect(atLimit.totalMassKg).toBeLessThanOrEqual(WEIGHT_LIMIT_KG + 1e-6);
    // A hair more must break the limit (unless we are capped by the material).
    if (t < atLimit.armor.maxThicknessMm - 1e-9) {
      const over = computeStats({ ...design, armorThicknessMm: t + 0.2 });
      expect(over.totalMassKg).toBeGreaterThan(WEIGHT_LIMIT_KG);
    }
  });

  it('never exceeds the material fabrication limit', () => {
    for (const armor of ARMOR) {
      const t = maxLegalThickness({ ...defaultDesign(), armorId: armor.id, weaponId: 'none' });
      expect(t).toBeLessThanOrEqual(armor.maxThicknessMm + 1e-9);
    }
  });

  it('returns zero when the hardware alone busts the limit', () => {
    // Heaviest of everything, all at once.
    const t = maxLegalThickness({
      ...defaultDesign(),
      chassisId: 'tank',
      driveId: '6wd',
      wheelId: 'pneumatic',
      weaponId: 'bigbar',
      srimech: true,
    });
    expect(t).toBe(0);
  });

  it('lets every chassis/weapon pair that fits be built legally with some armour', () => {
    let buildable = 0;
    for (const chassis of CHASSIS) {
      for (const weapon of WEAPONS) {
        if (!isMountCompatible(chassis, weapon)) continue;
        for (const drive of DRIVES) {
          const design: BotDesign = {
            ...defaultDesign(),
            chassisId: chassis.id,
            weaponId: weapon.id,
            driveId: drive.id,
            wheelId: 'hub',
            armorId: 'hdpe',
            srimech: false,
          };
          const t = maxLegalThickness(design);
          if (t > 0) {
            buildable++;
            expect(computeStats({ ...design, armorThicknessMm: t }).legal).toBe(true);
          }
        }
      }
    }
    // The overwhelming majority of sensible combinations must be legal,
    // otherwise the customiser is not actually open.
    expect(buildable).toBeGreaterThan(80);
  });
});

describe('unit conversions used by the HUD', () => {
  it('converts rpm and rad/s consistently', () => {
    expect(radPerSecToRpm((1400 * 2 * Math.PI) / 60)).toBeCloseTo(1400, 6);
  });
});
