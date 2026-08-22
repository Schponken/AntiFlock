/**
 * A bot design is the player's blueprint. Everything the simulation needs is
 * derived from it here, in one place, so the builder screen, the physics rig and
 * the damage model can never disagree about how heavy or how fast a bot is.
 */

import {
  ACCESSORIES,
  CHASSIS,
  DRIVE_MOTORS,
  MATERIALS,
  WEAPONS,
  WEIGHT_LIMIT_KG,
  WHEELS,
  CLAMP_BITE_STROKE_M,
  accessoryById,
  chassisById,
  materialById,
  motorById,
  rotorEnergy,
  rotorInertia,
  rotorMass,
  tipSpeed,
  weaponById,
  wheelById,
  type AccessoryEffect,
  type ChassisSpec,
  type DecalId,
  type MaterialSpec,
  type MotorSpec,
  type WeaponSpec,
  type WheelSpec,
} from './parts.ts';
import { clamp, mpsToMph } from '../core/mathx.ts';

/** Batteries, ESCs, receiver, wiring and the link light. Every bot carries this. */
export const BASE_ELECTRONICS_KG = 9.0;

/** Gearbox and belt losses. */
export const DRIVETRAIN_EFFICIENCY = 0.86;

export const ARMOR_THICKNESS_RANGE = { min: 3, max: 20 } as const;
export const GEAR_RATIO_RANGE = { min: 6, max: 40 } as const;
export const COVERAGE_RANGE = { min: 0.4, max: 1 } as const;

export interface PaintScheme {
  primary: number;
  secondary: number;
  accent: number;
  finishId: string;
  decal: DecalId;
  /** Underglow colour. */
  glow: number;
}

export interface BotDesign {
  name: string;
  chassisId: string;
  armorMaterialId: string;
  /** Millimetres of plate. */
  armorThicknessMm: number;
  /** Fraction of the frame's available armour area that is actually plated. */
  armorCoverage: number;
  motorId: string;
  gearRatio: number;
  wheelId: string;
  weaponId: string;
  /** The rotor / striker is often a different alloy from the body armour. */
  weaponMaterialId: string;
  accessories: AccessoryEffect[];
  paint: PaintScheme;
}

export interface ResolvedParts {
  chassis: ChassisSpec;
  armor: MaterialSpec;
  motor: MotorSpec;
  wheel: WheelSpec;
  weapon: WeaponSpec;
  weaponMaterial: MaterialSpec;
  accessories: AccessoryEffect[];
}

export interface DerivedStats {
  parts: ResolvedParts;
  /** Kilograms. */
  armorMass: number;
  driveMass: number;
  weaponMass: number;
  rotorMassKg: number;
  accessoryMass: number;
  electronicsMass: number;
  totalMass: number;
  /** Fraction of the 250 lb allowance used. */
  weightUsed: number;
  overweightBy: number;

  cost: number;

  /** Joules of armour integrity across the whole shell. */
  armorHp: number;
  frameHp: number;

  /** Drivetrain. */
  topSpeed: number;
  driveForce: number;
  tractionLimit: number;
  /** m/s², whichever of force and traction binds first. */
  acceleration: number;
  wheelCount: number;

  /** Weapon. */
  weaponInertia: number;
  weaponMaxOmega: number;
  weaponEnergy: number;
  weaponTipSpeed: number;
  weaponSpinupTime: number;
  /** Joules a single actuator shot delivers, for flippers and hammers. */
  actuatorEnergy: number;

  /** Handling. */
  groundClearance: number;
  invertible: boolean;
  hasSrimech: boolean;
  /** 0-1, how strongly a big horizontal weapon fights the steering. */
  gyroPenalty: number;
  /** 0-1 fraction of the rotor's gyroscopic reaction that is cancelled. */
  gyroCompensation: number;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
}

// ---------------------------------------------------------------------------

export function resolveParts(design: BotDesign): ResolvedParts {
  return {
    chassis: chassisById(design.chassisId),
    armor: materialById(design.armorMaterialId),
    motor: motorById(design.motorId),
    wheel: wheelById(design.wheelId),
    weapon: weaponById(design.weaponId),
    weaponMaterial: materialById(design.weaponMaterialId),
    accessories: [...new Set(design.accessories)],
  };
}

export function computeStats(design: BotDesign): DerivedStats {
  const parts = resolveParts(design);
  const { chassis, armor, motor, wheel, weapon, weaponMaterial } = parts;

  const thicknessMm = clamp(
    design.armorThicknessMm,
    ARMOR_THICKNESS_RANGE.min,
    ARMOR_THICKNESS_RANGE.max,
  );
  const coverage = clamp(design.armorCoverage, COVERAGE_RANGE.min, COVERAGE_RANGE.max);
  const gearRatio = clamp(design.gearRatio, GEAR_RATIO_RANGE.min, GEAR_RATIO_RANGE.max);

  const platedArea = chassis.armorArea * coverage;
  const armorMass = platedArea * (thicknessMm / 1000) * armor.density;

  const wheelCount = chassis.wheelCount;
  const driveMass = wheelCount * (motor.mass + wheel.mass);

  const rotorKg = rotorMass(weapon, weaponMaterial);
  const weaponMass = weapon.mountMass + rotorKg;

  const accessoryMass = parts.accessories.reduce((sum, id) => sum + accessoryById(id).mass, 0);
  const hasBigBattery = parts.accessories.includes('bigbattery');
  const electronicsMass = BASE_ELECTRONICS_KG;

  const totalMass =
    chassis.frameMass + armorMass + driveMass + weaponMass + accessoryMass + electronicsMass;

  const cost =
    chassis.cost +
    armorMass * armor.costPerKg +
    wheelCount * (motor.cost + wheel.cost) +
    weapon.cost +
    rotorKg * weaponMaterial.costPerKg +
    parts.accessories.reduce((sum, id) => sum + accessoryById(id).cost, 0);

  // Armour integrity: toughness is J per mm per m², and thicker plate is
  // disproportionately better because it spreads the load — hence the exponent.
  const armorHp = platedArea * thicknessMm ** 1.15 * armor.toughness;
  const ablativeBonus = parts.accessories.includes('ablative') ? 1.22 : 1;
  const frameHp = chassis.frameIntegrity;

  // Drivetrain.
  const wheelRpm = motor.freeRpm / gearRatio;
  const topSpeed = ((wheelRpm / 60) * 2 * Math.PI * wheel.radius) / 1;
  const driveForce =
    (wheelCount * motor.stallTorque * gearRatio * DRIVETRAIN_EFFICIENCY) / wheel.radius;
  const tractionLimit = wheel.grip * totalMass * 9.81;
  const acceleration = Math.min(driveForce, tractionLimit) / totalMass;

  // Weapon.
  const weaponInertia = rotorInertia(weapon, weaponMaterial);
  const maxOmega = weapon.rotor?.maxOmega ?? 0;
  const weaponEnergy = rotorEnergy(weaponInertia, maxOmega);
  const weaponTipSpeed = tipSpeed(weapon.rotor?.radius ?? 0, maxOmega);
  const spinPower = (weapon.rotor?.motorWatts ?? 1) * (hasBigBattery ? 1.28 : 1);
  const weaponSpinupTime = weaponEnergy > 0 ? weaponEnergy / (spinPower * 0.82) : 0;

  /*
   * A clamp is rated in newtons and everything else in joules, so the crusher
   * fell straight through this expression and came out with an actuator energy of
   * zero — which is the only energy budget combat.ts has for a non-rotor weapon,
   * so the Hydraulic Crusher did no damage at all, ever. Converting the jaw force
   * into the work it does over one bite puts it on the same footing as a flipper's
   * gas charge and a spinner's stored energy.
   */
  const clampBiteEnergy = weapon.clamp ? weapon.clamp.force * CLAMP_BITE_STROKE_M : 0;
  const actuatorShotEnergy = weapon.actuator?.energy ?? clampBiteEnergy;
  const actuatorEnergy = hasBigBattery ? actuatorShotEnergy * 1.1 : actuatorShotEnergy;

  // A long horizontal rotor makes the whole machine act like a gyroscope; the
  // compensator accessory buys most of it back.
  const rawGyro =
    weapon.rotor && weapon.rotor.axis === 'y'
      ? clamp((weaponInertia * maxOmega) / (totalMass * 12), 0, 1)
      : 0;
  const hasCompensator = parts.accessories.includes('antispin');
  const gyroPenalty = hasCompensator ? rawGyro * 0.3 : rawGyro;
  /*
   * How much of the rotor's gyroscopic reaction the compensator cancels.
   *
   * `gyroPenalty` was written into the stats and read by nothing except its own
   * validation warning — the actual lean comes from the rotor's inertia tensor,
   * which takes no accessory argument — so the Gyro Compensator was 3.8 kg that
   * bought a number on a panel. This is the fraction `Bot` actually applies.
   */
  const gyroCompensation = hasCompensator ? 0.7 : 0;

  return {
    parts,
    armorMass,
    driveMass,
    weaponMass,
    rotorMassKg: rotorKg,
    accessoryMass,
    electronicsMass,
    totalMass,
    weightUsed: totalMass / WEIGHT_LIMIT_KG,
    overweightBy: Math.max(0, totalMass - WEIGHT_LIMIT_KG),
    cost,
    armorHp: armorHp * ablativeBonus,
    frameHp,
    topSpeed,
    driveForce,
    tractionLimit,
    acceleration,
    wheelCount,
    weaponInertia,
    weaponMaxOmega: maxOmega,
    weaponEnergy,
    weaponTipSpeed,
    weaponSpinupTime,
    actuatorEnergy,
    groundClearance: chassis.groundClearance,
    invertible: chassis.invertible,
    hasSrimech: parts.accessories.includes('srimech'),
    gyroPenalty,
    gyroCompensation,
  };
}

export function validateDesign(design: BotDesign): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stats = computeStats(design);
  const { chassis, weapon } = stats.parts;

  if (stats.overweightBy > 0.001) {
    issues.push({
      level: 'error',
      message: `Overweight by ${stats.overweightBy.toFixed(1)} kg — the class limit is ${WEIGHT_LIMIT_KG.toFixed(1)} kg.`,
    });
  }

  if (!chassis.accepts.includes(weapon.kind)) {
    issues.push({
      level: 'error',
      message: `${chassis.name} has no mounting for a ${weapon.name.toLowerCase()}.`,
    });
  }

  if (!design.name.trim()) {
    issues.push({ level: 'error', message: 'Your bot needs a name.' });
  }

  if (!stats.invertible && !stats.hasSrimech) {
    issues.push({
      level: 'warning',
      message: 'No self-righter and the frame is not invertible — one flip ends your match.',
    });
  }

  if (stats.weightUsed < 0.8) {
    issues.push({
      level: 'warning',
      message: `Only ${(stats.weightUsed * 100).toFixed(0)}% of the weight allowance used. That is free armour you are leaving in the pit.`,
    });
  }

  /*
   * A 250 lb machine geared for 54 mph is not a fast machine, it is a machine
   * whose gearbox is wrong: the box is 15 m across, so anything past the mid
   * twenties is unreachable, and the builder was quoting a top speed it missed by
   * a factor of two. There was a warning at the slow end and none at the fast one.
   */
  if (stats.topSpeed > 11) {
    issues.push({
      level: 'warning',
      message: `Geared for ${mpsToMph(stats.topSpeed).toFixed(0)} mph — far past anything a 48-foot box lets you use.`,
    });
  }

  if (stats.topSpeed < 2.2) {
    issues.push({
      level: 'warning',
      message: `Top speed of ${stats.topSpeed.toFixed(1)} m/s is very slow — shorten the gear ratio.`,
    });
  }

  if (stats.driveForce > stats.tractionLimit * 3.2) {
    issues.push({
      level: 'warning',
      message: 'Wildly over-geared for the available grip; the wheels will just spin.',
    });
  }

  /*
   * Both of these thresholds were set above anything the catalogue can produce —
   * the worst gyroscopic penalty available is 0.41 and the slowest spin-up is
   * 6.6 s — so neither warning had ever fired for any build a player could make.
   * A validator that cannot trigger is worse than no validator, because it reads
   * as coverage. These are set from the actual reachable ranges.
   */
  if (stats.gyroPenalty > 0.3) {
    issues.push({
      level: 'warning',
      message: 'Gyroscopic forces from that rotor will make the bot lean hard in every turn.',
    });
  }

  if (weapon.rotor && stats.weaponSpinupTime > 5) {
    issues.push({
      level: 'warning',
      message: `Spin-up takes ${stats.weaponSpinupTime.toFixed(0)} s. You will be hit before you are up to speed.`,
    });
  }

  return issues;
}

export const isBuildable = (design: BotDesign): boolean =>
  validateDesign(design).every((i) => i.level !== 'error');

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const DEFAULT_PAINT: PaintScheme = {
  primary: 0xd42b2b,
  secondary: 0x1b1e24,
  accent: 0xffc300,
  finishId: 'gloss',
  decal: 'stripes',
  glow: 0xff3b30,
};

export function makeDefaultDesign(): BotDesign {
  return {
    name: 'Sparkplug',
    chassisId: 'boxframe',
    armorMaterialId: 'hardox',
    armorThicknessMm: 10,
    armorCoverage: 0.85,
    motorId: 'bl63',
    gearRatio: 12,
    wheelId: 'foamfill',
    weaponId: 'vert-disc',
    weaponMaterialId: 's7',
    accessories: ['srimech', 'forks'],
    paint: { ...DEFAULT_PAINT },
  };
}

export interface Preset {
  id: string;
  label: string;
  tagline: string;
  design: BotDesign;
}

/** Stock opponents — one archetype per fighting style. */
export const PRESETS: readonly Preset[] = [
  {
    id: 'sparkplug',
    label: 'Sparkplug',
    tagline: 'Balanced vertical spinner. The one everybody builds first.',
    design: makeDefaultDesign(),
  },
  {
    id: 'meridian',
    label: 'Meridian',
    tagline: 'Full-body horizontal bar. Enormous reach, terrifying gyro.',
    design: {
      name: 'Meridian',
      chassisId: 'discshell',
      armorMaterialId: 'al7075',
      armorThicknessMm: 16,
      armorCoverage: 0.95,
      motorId: 'bl63',
      gearRatio: 13,
      wheelId: 'bigroller',
      weaponId: 'horiz-bar',
      weaponMaterialId: 'ar500',
      accessories: ['antispin', 'skirts'],
      paint: {
        primary: 0x1f7ae0,
        secondary: 0x0c1118,
        accent: 0x7ee0ff,
        finishId: 'metallic',
        decal: 'circuit',
        glow: 0x2ea8ff,
      },
    },
  },
  {
    id: 'trebuchet',
    label: 'Trebuchet',
    tagline: 'Launches opponents over the wall and lets the floor do the work.',
    design: {
      name: 'Trebuchet',
      chassisId: 'lowwedge',
      armorMaterialId: 'ti6al4v',
      armorThicknessMm: 14,
      armorCoverage: 1,
      motorId: 'hyperion',
      gearRatio: 14,
      wheelId: 'foamfill',
      weaponId: 'flipper',
      weaponMaterialId: 'ti6al4v',
      accessories: ['srimech', 'wedgelets', 'forks', 'ablative'],
      paint: {
        primary: 0xf2f2f2,
        secondary: 0x2c2f36,
        accent: 0xff7a1a,
        finishId: 'gloss',
        decal: 'hazard',
        glow: 0xff9d3d,
      },
    },
  },
  {
    id: 'anvilhead',
    label: 'Anvilhead',
    tagline: 'Invertible brick with a drum. Refuses to break, refuses to stop.',
    design: {
      name: 'Anvilhead',
      chassisId: 'brick',
      armorMaterialId: 'ar500',
      armorThicknessMm: 7,
      armorCoverage: 0.65,
      motorId: 'ironhide',
      gearRatio: 6,
      wheelId: 'hubmotor',
      weaponId: 'drum',
      weaponMaterialId: 's7',
      accessories: ['skirts'],
      paint: {
        primary: 0x3c8f3c,
        secondary: 0x161a15,
        accent: 0xd9ff4a,
        finishId: 'matte',
        decal: 'camo',
        glow: 0x86ff3c,
      },
    },
  },
  {
    id: 'guillotine',
    label: 'Guillotine',
    tagline: 'Pneumatic hammer that punches straight through top armour.',
    design: {
      name: 'Guillotine',
      chassisId: 'boxframe',
      armorMaterialId: 'hardox',
      armorThicknessMm: 10,
      armorCoverage: 0.8,
      motorId: 'bl63',
      gearRatio: 12,
      wheelId: 'solidrubber',
      weaponId: 'hammer',
      weaponMaterialId: 's7',
      accessories: ['srimech', 'forks', 'ablative'],
      paint: {
        primary: 0x6b2fbf,
        secondary: 0x121016,
        accent: 0xffd400,
        finishId: 'gloss',
        decal: 'flames',
        glow: 0xb14dff,
      },
    },
  },
  {
    id: 'undertow',
    label: 'Undertow',
    tagline: 'Undercutter that sweeps below the armour line and takes the wheels.',
    design: {
      name: 'Undertow',
      chassisId: 'discshell',
      armorMaterialId: 'hardox',
      armorThicknessMm: 9,
      armorCoverage: 0.9,
      motorId: 'hyperion',
      gearRatio: 14,
      wheelId: 'hubmotor',
      weaponId: 'undercutter',
      weaponMaterialId: 'ar500',
      accessories: ['antispin', 'skirts'],
      paint: {
        primary: 0x111418,
        secondary: 0x2a2f36,
        accent: 0x00e5a0,
        finishId: 'raw',
        decal: 'checker',
        glow: 0x00ffb2,
      },
    },
  },
  {
    id: 'pincer',
    label: 'Pincer',
    tagline: 'Hydraulic crusher on a six-wheel hauler. Grabs, lifts, punctures.',
    design: {
      name: 'Pincer',
      chassisId: 'longbed',
      armorMaterialId: 'ar500',
      armorThicknessMm: 8,
      armorCoverage: 0.7,
      motorId: 'ironhide',
      gearRatio: 7,
      wheelId: 'foamfill',
      weaponId: 'crusher',
      weaponMaterialId: 's7',
      accessories: ['srimech', 'forks'],
      paint: {
        primary: 0xc46a1a,
        secondary: 0x201810,
        accent: 0xffe0a3,
        finishId: 'rust',
        decal: 'hazard',
        glow: 0xff8a00,
      },
    },
  },
  {
    id: 'doorstop',
    label: 'Doorstop',
    tagline: 'Pure control wedge. No weapon to break, no weapon to fail.',
    design: {
      name: 'Doorstop',
      chassisId: 'lowwedge',
      armorMaterialId: 'ti6al4v',
      armorThicknessMm: 20,
      armorCoverage: 1,
      motorId: 'hyperion',
      gearRatio: 14,
      wheelId: 'solidrubber',
      weaponId: 'wedge',
      weaponMaterialId: 'ti6al4v',
      accessories: ['srimech', 'forks', 'wedgelets', 'ablative'],
      paint: {
        primary: 0xf5c400,
        secondary: 0x1a1a1a,
        accent: 0x000000,
        finishId: 'gloss',
        decal: 'stripes',
        glow: 0xffd83c,
      },
    },
  },
];

export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;

export const cloneDesign = (design: BotDesign): BotDesign => ({
  ...design,
  accessories: [...design.accessories],
  paint: { ...design.paint },
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'antiflock.garage.v1';

/** Repair a design loaded from storage or a URL so unknown ids cannot crash the game. */
export function sanitizeDesign(input: unknown): BotDesign {
  const base = makeDefaultDesign();
  if (!input || typeof input !== 'object') return base;
  const raw = input as Partial<BotDesign>;

  const pickId = <T extends { id: string }>(list: readonly T[], id: unknown, fallback: string) =>
    typeof id === 'string' && list.some((entry) => entry.id === id) ? id : fallback;

  const paint = (raw.paint ?? {}) as Partial<PaintScheme>;
  const validAccessories = new Set(ACCESSORIES.map((a) => a.id));

  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.slice(0, 24) : base.name,
    chassisId: pickId(CHASSIS, raw.chassisId, base.chassisId),
    armorMaterialId: pickId(MATERIALS, raw.armorMaterialId, base.armorMaterialId),
    armorThicknessMm: clamp(
      Number(raw.armorThicknessMm) || base.armorThicknessMm,
      ARMOR_THICKNESS_RANGE.min,
      ARMOR_THICKNESS_RANGE.max,
    ),
    armorCoverage: clamp(
      Number(raw.armorCoverage) || base.armorCoverage,
      COVERAGE_RANGE.min,
      COVERAGE_RANGE.max,
    ),
    motorId: pickId(DRIVE_MOTORS, raw.motorId, base.motorId),
    gearRatio: clamp(
      Number(raw.gearRatio) || base.gearRatio,
      GEAR_RATIO_RANGE.min,
      GEAR_RATIO_RANGE.max,
    ),
    wheelId: pickId(WHEELS, raw.wheelId, base.wheelId),
    weaponId: pickId(WEAPONS, raw.weaponId, base.weaponId),
    weaponMaterialId: pickId(MATERIALS, raw.weaponMaterialId, base.weaponMaterialId),
    accessories: Array.isArray(raw.accessories)
      ? raw.accessories.filter((a): a is AccessoryEffect => validAccessories.has(a as AccessoryEffect))
      : [...base.accessories],
    paint: {
      primary: Number.isFinite(paint.primary) ? Number(paint.primary) : base.paint.primary,
      secondary: Number.isFinite(paint.secondary) ? Number(paint.secondary) : base.paint.secondary,
      accent: Number.isFinite(paint.accent) ? Number(paint.accent) : base.paint.accent,
      finishId: typeof paint.finishId === 'string' ? paint.finishId : base.paint.finishId,
      decal: (typeof paint.decal === 'string' ? paint.decal : base.paint.decal) as DecalId,
      glow: Number.isFinite(paint.glow) ? Number(paint.glow) : base.paint.glow,
    },
  };
}

export function saveDesign(design: BotDesign): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(design));
  } catch {
    // Private browsing or a full quota: the garage is a convenience, not a requirement.
  }
}

export function loadDesign(): BotDesign | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitizeDesign(JSON.parse(raw));
  } catch {
    return null;
  }
}
