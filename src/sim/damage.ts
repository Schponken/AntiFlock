/**
 * The damage model.
 *
 * Damage is driven by energy, not by hit points per second. The physics layer
 * measures how much kinetic energy an impact actually transferred — a spinner
 * losing 4000 rpm to 3200 rpm gave up a real, computable number of joules —
 * and hands that figure to this module, which decides what broke.
 *
 * Armour is split into six zones so a robot can be opened up on one side while
 * its front stays pristine, exactly like a real fight. Once a zone's plate is
 * gone, further hits there go straight into the frame at a much higher rate.
 *
 * Pure module: no physics, no rendering, fully unit tested.
 */

import { clamp, clamp01 } from '../core/math';
import type { Rng } from '../core/rng';
import type { BotStats } from './parts';

export type ArmorZone = 'front' | 'left' | 'right' | 'rear' | 'top' | 'bottom';

export const ARMOR_ZONES: readonly ArmorZone[] = ['front', 'left', 'right', 'rear', 'top', 'bottom'];

/**
 * How the armour budget is distributed. Builders put their thick plate at the
 * front and accept that the belly and the roof are thin.
 */
export const ZONE_SHARE: Readonly<Record<ArmorZone, number>> = {
  front: 0.3,
  left: 0.18,
  right: 0.18,
  rear: 0.14,
  top: 0.12,
  bottom: 0.08,
};

/**
 * Hit points removed per joule of energy that actually lands.
 *
 * Calibrated against a real exchange: a 60 kJ bar typically transfers around
 * ten per cent of its stored energy in a single bite, so roughly 6 kJ reaches
 * the target. After the angle and absorption terms that lands as about ninety
 * hit points — two bites to open a plate, three or four to end the fight,
 * which is what a heavyweight fight actually looks like.
 */
export const DAMAGE_PER_JOULE = 0.05;

/** Once the plate is gone, the frame takes hits far worse. */
export const EXPOSED_MULTIPLIER = 1.75;

/** Energy below this is a scuff — sparks and noise, no damage. */
export const MIN_DAMAGING_ENERGY_J = 12;

export interface BotHealth {
  zone: Record<ArmorZone, number>;
  zoneMax: Record<ArmorZone, number>;
  structure: number;
  structureMax: number;
  /** Per-wheel hit points; a wheel at zero is torn off. */
  wheels: number[];
  wheelMax: number;
  weapon: number;
  weaponMax: number;
  /** Cumulative energy taken, joules — used by the judges for damage scoring. */
  energyTakenJ: number;
  /** Cumulative hit points lost, for the HUD bar. */
  totalDamage: number;
}

export function createHealth(stats: BotStats): BotHealth {
  const zone = {} as Record<ArmorZone, number>;
  const zoneMax = {} as Record<ArmorZone, number>;
  for (const z of ARMOR_ZONES) {
    const hp = stats.armorHp * ZONE_SHARE[z];
    zone[z] = hp;
    zoneMax[z] = hp;
  }
  return {
    zone,
    zoneMax,
    structure: stats.structureHp,
    structureMax: stats.structureHp,
    wheels: new Array(stats.drive.wheelCount).fill(stats.wheelHp),
    wheelMax: stats.wheelHp,
    weapon: stats.weaponHp,
    weaponMax: stats.weaponHp,
    energyTakenJ: 0,
    totalDamage: 0,
  };
}

export interface Hit {
  /** Kinetic energy transferred by the impact, joules. */
  energyJ: number;
  /** Which armour zone took it. */
  zone: ArmorZone;
  /**
   * How square the hit was: 1 is a dead-on bite, 0 is a glance that slid off.
   * The physics layer derives this from the contact normal.
   */
  squareness: number;
  /** Attacker's weapon bite factor — teeth, hardness, tooth count. */
  bite: number;
  /** True if the impact landed on a wheel rather than the hull. */
  onWheel?: boolean;
  /** Index of the wheel struck, when `onWheel` is set. */
  wheelIndex?: number;
  /** True if the impact landed on the target's own weapon assembly. */
  onWeapon?: boolean;
}

export interface DamageResult {
  /** Hit points actually removed. */
  hpLost: number;
  /** Energy that got through the armour, joules. */
  effectiveEnergyJ: number;
  /** The plate on this zone broke through on this hit. */
  penetrated: boolean;
  /** Zone armour was already gone before this hit. */
  wasExposed: boolean;
  /** A wheel was torn off. */
  wheelLost: boolean;
  /** The weapon assembly stopped working. */
  weaponKilled: boolean;
  /** Fraction of remaining structure, 0..1, after the hit. */
  structureFraction: number;
  /** How many sparks the renderer should throw. */
  sparkIntensity: number;
  /** True if this hit finished the robot off. */
  fatal: boolean;
}

/**
 * Apply one impact. Mutates `health` and returns what happened, so the
 * renderer and audio can react to the specifics.
 */
export function applyHit(
  health: BotHealth,
  stats: BotStats,
  hit: Hit,
  rng: Rng,
): DamageResult {
  const squareness = clamp01(hit.squareness);
  const bite = Math.max(0, hit.bite);

  // A glancing blow at a shallow angle transmits very little. Squaring the
  // term makes wedges and curved shells genuinely worth building.
  const angleFactor = 0.15 + 0.85 * squareness * squareness;
  const incoming = Math.max(0, hit.energyJ) * angleFactor * bite;

  health.energyTakenJ += incoming;

  const result: DamageResult = {
    hpLost: 0,
    effectiveEnergyJ: 0,
    penetrated: false,
    wasExposed: false,
    wheelLost: false,
    weaponKilled: false,
    structureFraction: health.structureMax > 0 ? health.structure / health.structureMax : 0,
    sparkIntensity: clamp01(incoming / 6000) * (0.25 + 0.75 * squareness),
    fatal: false,
  };

  if (incoming < MIN_DAMAGING_ENERGY_J) {
    return result;
  }

  // --- Wheel strike ---------------------------------------------------------
  if (hit.onWheel && hit.wheelIndex !== undefined && hit.wheelIndex < health.wheels.length) {
    const i = hit.wheelIndex;
    if (health.wheels[i]! > 0) {
      // Wheels are unarmoured; they take the hit almost raw.
      const wheelDamage = incoming * DAMAGE_PER_JOULE * 1.6;
      health.wheels[i] = Math.max(0, health.wheels[i]! - wheelDamage);
      health.totalDamage += wheelDamage;
      result.hpLost = wheelDamage;
      result.effectiveEnergyJ = incoming;
      result.wheelLost = health.wheels[i]! <= 0;
      result.sparkIntensity *= 0.5; // rubber smokes, it does not spark
    }
    result.fatal = isImmobilised(health);
    return result;
  }

  // --- Weapon-on-weapon -----------------------------------------------------
  if (hit.onWeapon && health.weapon > 0) {
    const weaponDamage = incoming * DAMAGE_PER_JOULE * 1.1;
    health.weapon = Math.max(0, health.weapon - weaponDamage);
    health.totalDamage += weaponDamage;
    result.hpLost = weaponDamage;
    result.effectiveEnergyJ = incoming;
    result.weaponKilled = health.weapon <= 0;
    result.sparkIntensity = clamp01(result.sparkIntensity * 1.8); // metal on metal
    result.fatal = isImmobilised(health);
    return result;
  }

  // --- Hull ------------------------------------------------------------------
  const zoneHp = health.zone[hit.zone];
  result.wasExposed = zoneHp <= 0;

  // Plastic armour soaks energy instead of converting it to damage.
  const soaked = incoming * (1 - stats.armor.absorption * (result.wasExposed ? 0.25 : 1));
  let remaining = soaked * DAMAGE_PER_JOULE;
  result.effectiveEnergyJ = soaked;

  if (zoneHp > 0) {
    const absorbed = Math.min(zoneHp, remaining);
    health.zone[hit.zone] = zoneHp - absorbed;
    remaining -= absorbed;
    health.totalDamage += absorbed;
    result.hpLost += absorbed;
    if (health.zone[hit.zone]! <= 0) {
      result.penetrated = true;
      // Peeling a plate off is spectacular.
      result.sparkIntensity = clamp01(result.sparkIntensity * 1.5 + 0.2);
    }
  }

  if (remaining > 0) {
    const structural = remaining * EXPOSED_MULTIPLIER;
    const applied = Math.min(health.structure, structural);
    health.structure -= applied;
    health.totalDamage += applied;
    result.hpLost += applied;
  }

  // A hard hit to a side zone can rip a wheel clean off even without a direct
  // wheel strike — that is how most robots actually lose mobility.
  if ((hit.zone === 'left' || hit.zone === 'right') && incoming > 2500) {
    const live = health.wheels
      .map((hp, i) => ({ hp, i }))
      .filter((w) => w.hp > 0 && (hit.zone === 'left' ? w.i % 2 === 0 : w.i % 2 === 1));
    if (live.length > 0 && rng.chance(clamp01((incoming - 2500) / 18000))) {
      const victim = rng.pick(live);
      health.wheels[victim.i] = 0;
      result.wheelLost = true;
    }
  }

  // A big hit to the front of a robot whose weapon lives there can kill it.
  if (hit.zone === 'front' && health.weapon > 0 && incoming > 3000 && stats.weapon.kind !== 'none') {
    const collateral = incoming * DAMAGE_PER_JOULE * 0.3;
    health.weapon = Math.max(0, health.weapon - collateral);
    if (health.weapon <= 0) result.weaponKilled = true;
  }

  result.structureFraction = health.structureMax > 0 ? health.structure / health.structureMax : 0;
  result.fatal = isImmobilised(health);
  return result;
}

/** Fraction of drive still working, 0..1. */
export function driveFraction(health: BotHealth): number {
  if (health.wheels.length === 0) return 0;
  const live = health.wheels.filter((hp) => hp > 0).length;
  return live / health.wheels.length;
}

/** True once the robot can no longer move under its own power. */
export function isImmobilised(health: BotHealth): boolean {
  return health.structure <= 0 || driveFraction(health) <= 0;
}

/** True when the weapon assembly has been knocked out. */
export function isWeaponDead(health: BotHealth): boolean {
  return health.weapon <= 0;
}

/**
 * Overall condition, 0..1, for the HUD bar. Weights the frame heavily since
 * that is what actually ends the fight.
 */
export function condition(health: BotHealth): number {
  const armorNow = ARMOR_ZONES.reduce((sum, z) => sum + health.zone[z], 0);
  const armorMax = ARMOR_ZONES.reduce((sum, z) => sum + health.zoneMax[z], 0);
  const armorFrac = armorMax > 0 ? armorNow / armorMax : 1;
  const structFrac = health.structureMax > 0 ? health.structure / health.structureMax : 0;
  const driveFrac = driveFraction(health);
  return clamp01(0.25 * armorFrac + 0.55 * structFrac + 0.2 * driveFrac);
}

/**
 * Torque reaction ratio: how violently a spinner's own hit throws the robot
 * that threw it. Light robots with heavy weapons go flying too — this is what
 * makes big spinners genuinely risky to drive.
 */
export function recoilRatio(attackerMassKg: number, rotorInertia: number, radiusM: number): number {
  if (radiusM <= 0 || attackerMassKg <= 0) return 0;
  const effectiveRotorMass = rotorInertia / (radiusM * radiusM);
  return clamp(effectiveRotorMass / attackerMassKg, 0, 1.5);
}

/**
 * Split a total impulse between the two robots by mass, the way a real
 * collision does. Returns the attacker's share, 0..1.
 */
export function impulseShare(attackerMassKg: number, targetMassKg: number): number {
  const total = attackerMassKg + targetMassKg;
  if (total <= 0) return 0.5;
  return targetMassKg / total;
}
