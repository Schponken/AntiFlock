/**
 * The parts catalogue and the bot-design maths.
 *
 * Everything here is data plus pure functions. Real units throughout:
 * kilograms, metres, watts, joules, seconds. A heavyweight combat robot has a
 * 250 lb (113.4 kg) limit and the whole customiser is a weight-budget game,
 * exactly like designing a real bot — armour, drive and weapon all compete for
 * the same kilograms.
 */

import { lbToKg, rpmToRadPerSec, spinnerInertia, clamp } from '../core/math';

/** Competition weight limit for the heavyweight class. */
export const WEIGHT_LIMIT_LB = 250;
export const WEIGHT_LIMIT_KG = lbToKg(WEIGHT_LIMIT_LB); // 113.4 kg

// ---------------------------------------------------------------------------
// Chassis
// ---------------------------------------------------------------------------

export type WeaponMount = 'front-horizontal' | 'front-vertical' | 'top' | 'none';

export interface ChassisSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** Bare frame mass with no armour or drivetrain fitted. */
  readonly massKg: number;
  /** Overall hull size in metres: length (X), width (Z), height (Y). */
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** 0 = flat brick front, 1 = full-length ground-scraping wedge. */
  readonly wedge: number;
  /** Can it drive upside down without a self-righting mechanism? */
  readonly invertible: boolean;
  /** Ride height in metres. Lower wins the ground game but bottoms out. */
  readonly clearance: number;
  /** Exterior surface area used to price armour by mass. */
  readonly armorAreaM2: number;
  /** Multiplier on armour hit points — a stout frame backs its plates up. */
  readonly structureFactor: number;
  /** Mounts this frame can actually carry a weapon on. */
  readonly mounts: readonly WeaponMount[];
}

export const CHASSIS: readonly ChassisSpec[] = [
  {
    id: 'brick',
    name: 'Brick',
    blurb: 'Boxy, cheap and very hard to kill. Carries anything you bolt to it.',
    massKg: 22,
    length: 0.92,
    width: 0.78,
    height: 0.26,
    wedge: 0.15,
    invertible: true,
    clearance: 0.028,
    armorAreaM2: 1.04,
    structureFactor: 1.0,
    mounts: ['front-horizontal', 'front-vertical', 'top', 'none'],
  },
  {
    id: 'wedge',
    name: 'Ground Scraper',
    blurb: 'A hinged wedge that lives under the other robot. Control before damage.',
    massKg: 19,
    length: 1.02,
    width: 0.82,
    height: 0.2,
    wedge: 0.95,
    invertible: false,
    clearance: 0.008,
    armorAreaM2: 1.08,
    structureFactor: 0.92,
    mounts: ['front-vertical', 'top', 'none'],
  },
  {
    id: 'barframe',
    name: 'Bar Frame',
    blurb: 'Long, low and built around a horizontal bar. All the mass sits centre.',
    massKg: 25,
    length: 1.0,
    width: 0.7,
    height: 0.22,
    wedge: 0.2,
    invertible: true,
    clearance: 0.022,
    armorAreaM2: 0.97,
    structureFactor: 1.05,
    mounts: ['front-horizontal', 'none'],
  },
  {
    id: 'drumframe',
    name: 'Drum Frame',
    blurb: 'Short wheelbase, huge front opening. Turns inside anything.',
    massKg: 18,
    length: 0.78,
    width: 0.76,
    height: 0.24,
    wedge: 0.45,
    invertible: true,
    clearance: 0.015,
    armorAreaM2: 0.87,
    structureFactor: 0.95,
    mounts: ['front-vertical', 'front-horizontal', 'none'],
  },
  {
    id: 'tank',
    name: 'Blockhouse',
    blurb: 'Over-built armour tub. Slow, heavy, and it simply does not break.',
    massKg: 34,
    length: 0.95,
    width: 0.9,
    height: 0.34,
    wedge: 0.1,
    invertible: false,
    clearance: 0.035,
    armorAreaM2: 1.35,
    structureFactor: 1.35,
    mounts: ['front-horizontal', 'front-vertical', 'top', 'none'],
  },
  {
    id: 'liftframe',
    name: 'Lift Frame',
    blurb: 'Long arms out front and a low tail. Built to pick things up and drive them.',
    massKg: 21,
    length: 1.05,
    width: 0.75,
    height: 0.25,
    wedge: 0.6,
    invertible: false,
    clearance: 0.014,
    armorAreaM2: 1.11,
    structureFactor: 0.98,
    mounts: ['front-vertical', 'top', 'none'],
  },
  {
    id: 'shell',
    name: 'Shellback',
    blurb: 'Domed and fully invertible, with nothing for a spinner to grab.',
    massKg: 26,
    length: 0.88,
    width: 0.88,
    height: 0.3,
    wedge: 0.3,
    invertible: true,
    clearance: 0.02,
    armorAreaM2: 1.17,
    structureFactor: 1.15,
    mounts: ['front-horizontal', 'top', 'none'],
  },
];

// ---------------------------------------------------------------------------
// Armour
// ---------------------------------------------------------------------------

export interface ArmorSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** kg per cubic metre — this is what makes thick armour expensive. */
  readonly densityKgM3: number;
  /** Hit points contributed per millimetre of thickness per square metre. */
  readonly toughness: number;
  /**
   * Fraction of incoming impact energy the material soaks rather than passes
   * into the frame. Plastics are terrible armour by hit points and superb at
   * blunting a spinner hit.
   */
  readonly absorption: number;
  /** How readily it throws sparks. Titanium is the money shot. */
  readonly sparkiness: number;
  /** Practical fabrication limit in millimetres. */
  readonly maxThicknessMm: number;
  /** Base tint used by the renderer when the player has not overridden it. */
  readonly tint: number;
  /** Physically based surface parameters for the renderer. */
  readonly metalness: number;
  readonly roughness: number;
}

export const ARMOR: readonly ArmorSpec[] = [
  {
    id: 'ar500',
    name: 'AR500 Hardened Steel',
    blurb: 'Abrasion-resistant plate. Heavy as sin, laughs at teeth.',
    densityKgM3: 7850,
    toughness: 34,
    absorption: 0.24,
    sparkiness: 0.85,
    maxThicknessMm: 10,
    tint: 0x8d9299,
    metalness: 0.95,
    roughness: 0.42,
  },
  {
    id: 'ti64',
    name: 'Titanium Grade 5',
    blurb: 'Half the weight of steel, most of the strength, and it burns white.',
    densityKgM3: 4430,
    toughness: 29,
    absorption: 0.3,
    sparkiness: 1.0,
    maxThicknessMm: 12,
    tint: 0x9aa3ad,
    metalness: 0.9,
    roughness: 0.34,
  },
  {
    id: 's7',
    name: 'S7 Tool Steel',
    blurb: 'Shock-grade tool steel. The toughest thing you can bolt on.',
    densityKgM3: 7800,
    toughness: 41,
    absorption: 0.2,
    sparkiness: 0.9,
    maxThicknessMm: 8,
    tint: 0x6f757d,
    metalness: 1.0,
    roughness: 0.3,
  },
  {
    id: 'al6061',
    name: '6061 Aluminium',
    blurb: 'Light and easy to machine. Dents if you look at it hard.',
    densityKgM3: 2700,
    toughness: 17,
    absorption: 0.28,
    sparkiness: 0.45,
    maxThicknessMm: 14,
    tint: 0xb9c0c7,
    metalness: 0.85,
    roughness: 0.46,
  },
  {
    id: 'uhmw',
    name: 'UHMW Polyethylene',
    blurb: 'Slippery white plastic. Low hit points, but spinners just slide off it.',
    densityKgM3: 970,
    toughness: 13,
    absorption: 0.62,
    sparkiness: 0.0,
    maxThicknessMm: 30,
    tint: 0xe8e6df,
    metalness: 0.0,
    roughness: 0.62,
  },
  {
    id: 'hdpe',
    name: 'HDPE',
    blurb: 'Cheap cutting board. Astonishingly effective and nearly free of weight.',
    densityKgM3: 950,
    toughness: 11,
    absorption: 0.55,
    sparkiness: 0.0,
    maxThicknessMm: 30,
    tint: 0x2f3b46,
    metalness: 0.0,
    roughness: 0.7,
  },
  {
    id: 'carbon',
    name: 'Carbon Composite',
    blurb: 'Featherweight and stiff. Wonderful until something cracks it.',
    densityKgM3: 1600,
    toughness: 15,
    absorption: 0.4,
    sparkiness: 0.1,
    maxThicknessMm: 16,
    tint: 0x1b1d21,
    metalness: 0.25,
    roughness: 0.38,
  },
];

// ---------------------------------------------------------------------------
// Drivetrain
// ---------------------------------------------------------------------------

export interface DriveSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly wheelCount: number;
  /** Combined mechanical output of the drive motors, watts. */
  readonly powerW: number;
  /** Mass of motors, gearboxes, chain, ESCs and battery share. */
  readonly massKg: number;
  readonly wheelRadiusM: number;
  /** Theoretical unloaded top speed, m/s. 8.9 m/s is a brisk 20 mph. */
  readonly topSpeedMps: number;
  /** How much of the frame's weight the driven wheels carry. */
  readonly tractionShare: number;
  /** Yaw responsiveness multiplier — six wheels scrub, two wheels pivot. */
  readonly agility: number;
}

export const DRIVES: readonly DriveSpec[] = [
  {
    id: '2wd-brushed',
    name: '2WD Brushed',
    blurb: 'Two big brushed motors, direct drive. Simple, light, spins on a coin.',
    wheelCount: 2,
    powerW: 3600,
    massKg: 15,
    wheelRadiusM: 0.1,
    topSpeedMps: 7.2,
    tractionShare: 0.82,
    agility: 1.25,
    },
  {
    id: '4wd-chain',
    name: '4WD Chain',
    blurb: 'Chain-linked four-wheel drive. Loses a wheel and keeps going.',
    wheelCount: 4,
    powerW: 4400,
    massKg: 21,
    wheelRadiusM: 0.095,
    topSpeedMps: 7.8,
    tractionShare: 0.95,
    agility: 1.0,
  },
  {
    id: '4wd-brushless',
    name: '4WD Brushless',
    blurb: 'Outrunners and lithium. Frightening acceleration, hungry on weight.',
    wheelCount: 4,
    powerW: 8200,
    massKg: 26,
    wheelRadiusM: 0.105,
    topSpeedMps: 10.4,
    tractionShare: 0.95,
    agility: 1.05,
  },
  {
    id: '6wd',
    name: '6WD Skid',
    blurb: 'Six wheels of contact patch. Shoves like a bulldozer, turns like a bus.',
    wheelCount: 6,
    powerW: 5200,
    massKg: 28,
    wheelRadiusM: 0.085,
    topSpeedMps: 6.4,
    tractionShare: 1.0,
    agility: 0.78,
  },
  {
    id: '2wd-crawler',
    name: '2WD Torque Crawler',
    blurb: 'Geared down to nothing. Slow, unstoppable in a push, saves weight.',
    wheelCount: 2,
    powerW: 3000,
    massKg: 13,
    wheelRadiusM: 0.12,
    topSpeedMps: 4.6,
    tractionShare: 0.85,
    agility: 1.1,
  },
  {
    id: '4wd-sprint',
    name: '4WD Sprinter',
    blurb: 'Tall gearing and small wheels. Built to close distance before the bar spins up.',
    wheelCount: 4,
    powerW: 6000,
    massKg: 19,
    wheelRadiusM: 0.08,
    topSpeedMps: 11.6,
    tractionShare: 0.9,
    agility: 1.15,
  },
];

// ---------------------------------------------------------------------------
// Wheels
// ---------------------------------------------------------------------------

export interface WheelSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  /** Coefficient of friction against the steel arena floor. */
  readonly grip: number;
  /** Mass of the full set. */
  readonly massKg: number;
  /** Hit points of a single wheel before it is torn off. */
  readonly hp: number;
  readonly tint: number;
}

export const WHEELS: readonly WheelSpec[] = [
  {
    id: 'foam',
    name: 'Foam-Filled Rubber',
    blurb: 'Grippy and forgiving. The default for a reason.',
    grip: 1.15,
    massKg: 6,
    hp: 90,
    tint: 0x1a1a1d,
  },
  {
    id: 'colson',
    name: 'Colson Performa',
    blurb: 'Solid polyurethane. Nearly impossible to shred.',
    grip: 1.0,
    massKg: 8,
    hp: 150,
    tint: 0x2b2b30,
  },
  {
    id: 'pneumatic',
    name: 'Pneumatic',
    blurb: 'Maximum bite on the steel floor. One tooth and it is flat.',
    grip: 1.35,
    massKg: 9,
    hp: 55,
    tint: 0x141416,
  },
  {
    id: 'hub',
    name: 'Armoured Hub',
    blurb: 'Tiny hardened wheels tucked inside the frame. Slippery but safe.',
    grip: 0.78,
    massKg: 5,
    hp: 200,
    tint: 0x4a4d52,
  },
];

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponKind =
  | 'none'
  | 'horizontal-spinner'
  | 'vertical-spinner'
  | 'drum'
  | 'flipper'
  | 'hammer'
  | 'lifter'
  | 'saw'
  | 'crusher';

export interface WeaponSpec {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly kind: WeaponKind;
  readonly mount: WeaponMount;
  /** Mass of the weapon assembly including its motor and mounting. */
  readonly massKg: number;
  /** Mass of the moving part alone — this is what stores the energy. */
  readonly rotorMassKg: number;
  /** Radius of the rotor, or reach of an arm, in metres. */
  readonly radiusM: number;
  /** Free-running speed of a spinner. */
  readonly rpm: number;
  /** Motor power available to spin it up or drive the arm. */
  readonly powerW: number;
  /** Fraction of the rotor mass concentrated at the rim. */
  readonly rimFraction: number;
  /** Multiplier applied to delivered damage — teeth and hardness. */
  readonly biteFactor: number;
  /** One-shot energy for a flipper/hammer/crusher, joules. */
  readonly burstJ: number;
  /** Seconds between shots for a burst weapon. */
  readonly cycleTime: number;
  /** Hit points of the weapon assembly before it stops working. */
  readonly hp: number;
  /** Height of the business end above the floor, metres. */
  readonly strikeHeight: number;
}

export const WEAPONS: readonly WeaponSpec[] = [
  {
    id: 'none',
    name: 'No Weapon (Pure Wedge)',
    blurb: 'Nothing but a good wedge and 250 lb of intent. Wins on control.',
    kind: 'none',
    mount: 'none',
    massKg: 0,
    rotorMassKg: 0,
    radiusM: 0,
    rpm: 0,
    powerW: 0,
    rimFraction: 0,
    biteFactor: 0,
    burstJ: 0,
    cycleTime: 0,
    hp: 1,
    strikeHeight: 0,
  },
  {
    id: 'bar',
    name: 'Horizontal Bar',
    blurb: 'A metre of hardened bar at 1400 rpm. Sixty kilojoules, delivered sideways.',
    kind: 'horizontal-spinner',
    mount: 'front-horizontal',
    massKg: 38,
    rotorMassKg: 30,
    radiusM: 0.5,
    rpm: 1400,
    powerW: 5200,
    rimFraction: 0.86,
    biteFactor: 1.0,
    burstJ: 0,
    cycleTime: 0,
    hp: 420,
    strikeHeight: 0.09,
  },
  {
    id: 'bigbar',
    name: 'Overkill Bar',
    blurb: 'Absurdly heavy bar, long spin-up. If it connects, the fight is over.',
    kind: 'horizontal-spinner',
    mount: 'front-horizontal',
    massKg: 52,
    rotorMassKg: 44,
    radiusM: 0.56,
    rpm: 1250,
    powerW: 5600,
    rimFraction: 0.9,
    biteFactor: 1.12,
    burstJ: 0,
    cycleTime: 0,
    hp: 520,
    strikeHeight: 0.1,
  },
  {
    id: 'disc',
    name: 'Vertical Disc',
    blurb: 'Undercuts, bites, and throws the other robot at the ceiling.',
    kind: 'vertical-spinner',
    mount: 'front-vertical',
    massKg: 34,
    rotorMassKg: 26,
    radiusM: 0.36,
    rpm: 2400,
    powerW: 5400,
    rimFraction: 0.8,
    biteFactor: 1.15,
    burstJ: 0,
    cycleTime: 0,
    hp: 380,
    strikeHeight: 0.05,
  },
  {
    id: 'drum',
    name: 'Beater Drum',
    blurb: 'Fat, fast and always up to speed. Relentless rather than spectacular.',
    kind: 'drum',
    mount: 'front-vertical',
    massKg: 30,
    rotorMassKg: 24,
    radiusM: 0.16,
    rpm: 4600,
    powerW: 4800,
    rimFraction: 0.7,
    biteFactor: 0.95,
    burstJ: 0,
    cycleTime: 0,
    hp: 460,
    strikeHeight: 0.04,
  },
  {
    id: 'flipper',
    name: 'Pneumatic Flipper',
    blurb: 'Four kilojoules of nitrogen, straight up. Takes no damage doing it.',
    kind: 'flipper',
    mount: 'front-vertical',
    massKg: 28,
    rotorMassKg: 8,
    radiusM: 0.42,
    rpm: 0,
    powerW: 900,
    rimFraction: 0,
    biteFactor: 0.35,
    burstJ: 4200,
    cycleTime: 2.6,
    hp: 340,
    strikeHeight: 0.03,
  },
  {
    id: 'hammer',
    name: 'Overhead Hammer',
    blurb: 'A dumb heavy axe. Slow, but it hits the one place armour is thin.',
    kind: 'hammer',
    mount: 'top',
    massKg: 26,
    rotorMassKg: 14,
    radiusM: 0.62,
    rpm: 0,
    powerW: 2400,
    rimFraction: 0.75,
    biteFactor: 1.4,
    burstJ: 2600,
    cycleTime: 1.9,
    hp: 300,
    strikeHeight: 0.22,
  },
  {
    id: 'lifter',
    name: 'Electric Lifter',
    blurb: 'No damage at all. Picks the other robot up and carries it to the screws.',
    kind: 'lifter',
    mount: 'front-vertical',
    massKg: 18,
    rotorMassKg: 6,
    radiusM: 0.48,
    rpm: 0,
    powerW: 1500,
    rimFraction: 0,
    biteFactor: 0.15,
    burstJ: 1400,
    cycleTime: 1.2,
    hp: 290,
    strikeHeight: 0.02,
  },
  {
    id: 'saw',
    name: 'Overhead Saw',
    blurb: 'Constant grinding contact. Terrific sparks, modest damage.',
    kind: 'saw',
    mount: 'top',
    massKg: 16,
    rotorMassKg: 5,
    radiusM: 0.28,
    rpm: 5200,
    powerW: 2200,
    rimFraction: 0.65,
    biteFactor: 0.6,
    burstJ: 0,
    cycleTime: 0,
    hp: 220,
    strikeHeight: 0.16,
  },
  {
    id: 'crusher',
    name: 'Hydraulic Crusher',
    blurb: 'Ten tonnes of squeeze. Slow, cruel, and it punches straight through.',
    kind: 'crusher',
    mount: 'front-vertical',
    massKg: 40,
    rotorMassKg: 10,
    radiusM: 0.4,
    rpm: 0,
    powerW: 1200,
    rimFraction: 0,
    biteFactor: 2.2,
    burstJ: 3200,
    cycleTime: 3.4,
    hp: 400,
    strikeHeight: 0.06,
  },
];

// ---------------------------------------------------------------------------
// Design + derived statistics
// ---------------------------------------------------------------------------

export interface BotDesign {
  name: string;
  chassisId: string;
  armorId: string;
  /** Armour plate thickness in millimetres. */
  armorThicknessMm: number;
  driveId: string;
  wheelId: string;
  weaponId: string;
  /** Primary hull colour, 0xRRGGBB. */
  primaryColor: number;
  /** Secondary/trim colour. */
  secondaryColor: number;
  /** Emissive accent colour used for lights and the weapon glow. */
  accentColor: number;
  /** Livery pattern painted onto the hull. */
  livery: LiveryId;
  /** Fit a self-righting arm. Costs weight, saves fights. */
  srimech: boolean;
}

export type LiveryId = 'plain' | 'stripes' | 'hazard' | 'checker' | 'flames' | 'splitface' | 'rivets';

export const LIVERIES: readonly { id: LiveryId; name: string }[] = [
  { id: 'plain', name: 'Plain' },
  { id: 'stripes', name: 'Racing Stripes' },
  { id: 'hazard', name: 'Hazard Chevrons' },
  { id: 'checker', name: 'Checkerboard' },
  { id: 'flames', name: 'Flames' },
  { id: 'splitface', name: 'Split Face' },
  { id: 'rivets', name: 'Riveted Plate' },
];

/** Mass of the self-righting mechanism, when fitted. */
export const SRIMECH_MASS_KG = 5.5;

/** Chain, gearbox and controller losses between the motor and the floor. */
export const DRIVETRAIN_EFFICIENCY = 0.72;
/** Real rubber on a real steel floor never quite achieves its rated grip. */
export const TRACTION_EFFICIENCY = 0.75;

export interface BotStats {
  readonly chassis: ChassisSpec;
  readonly armor: ArmorSpec;
  readonly drive: DriveSpec;
  readonly wheel: WheelSpec;
  readonly weapon: WeaponSpec;

  readonly armorMassKg: number;
  readonly totalMassKg: number;
  readonly totalMassLb: number;
  readonly overweightKg: number;
  readonly legal: boolean;

  /** Hit points of the armour shell. */
  readonly armorHp: number;
  /** Hit points of the internal frame, exposed once the armour is gone. */
  readonly structureHp: number;
  readonly wheelHp: number;
  readonly weaponHp: number;
  readonly totalHp: number;

  /** Achievable top speed once mass and gearing are accounted for, m/s. */
  readonly topSpeedMps: number;
  /** Standing acceleration, m/s^2. */
  readonly accelMps2: number;
  /** Peak yaw rate, rad/s. */
  readonly turnRate: number;
  /** Pushing force available at the contact patch, newtons. */
  readonly pushForceN: number;

  /** Stored energy of a spinner at full speed, joules. */
  readonly weaponEnergyJ: number;
  /** Seconds from a standstill to full weapon speed. */
  readonly spinUpTime: number;
  /** Rotor tip speed, m/s. */
  readonly tipSpeedMps: number;
  /** Rotational inertia of the rotor, kg m^2. */
  readonly rotorInertia: number;

  /**
   * Can it drive while upside down? This is a property of the frame alone —
   * a self-righting arm does not let you drive inverted, it flips you back.
   */
  readonly invertible: boolean;
  /** Can it get itself back onto its wheels after being flipped? */
  readonly selfRighting: boolean;
}

function byId<T extends { id: string }>(list: readonly T[], id: string, what: string): T {
  const found = list.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown ${what}: "${id}"`);
  return found;
}

export const getChassis = (id: string): ChassisSpec => byId(CHASSIS, id, 'chassis');
export const getArmor = (id: string): ArmorSpec => byId(ARMOR, id, 'armor');
export const getDrive = (id: string): DriveSpec => byId(DRIVES, id, 'drive');
export const getWheel = (id: string): WheelSpec => byId(WHEELS, id, 'wheel');
export const getWeapon = (id: string): WeaponSpec => byId(WEAPONS, id, 'weapon');

/** Is this weapon fittable to this chassis? */
export function isMountCompatible(chassis: ChassisSpec, weapon: WeaponSpec): boolean {
  return chassis.mounts.includes(weapon.mount);
}

/**
 * Derive every number the simulation and the garage UI need from a design.
 * Pure: same design in, same stats out.
 */
export function computeStats(design: BotDesign): BotStats {
  const chassis = getChassis(design.chassisId);
  const armor = getArmor(design.armorId);
  const drive = getDrive(design.driveId);
  const wheel = getWheel(design.wheelId);
  const weapon = getWeapon(design.weaponId);

  const thickness = clamp(design.armorThicknessMm, 0.5, armor.maxThicknessMm);

  // Armour mass is simply plate volume times density.
  const armorMassKg = chassis.armorAreaM2 * (thickness / 1000) * armor.densityKgM3;

  const srimechMass = design.srimech ? SRIMECH_MASS_KG : 0;
  const totalMassKg =
    chassis.massKg + armorMassKg + drive.massKg + wheel.massKg + weapon.massKg + srimechMass;

  const overweightKg = Math.max(0, totalMassKg - WEIGHT_LIMIT_KG);

  // --- Durability -----------------------------------------------------------
  const armorHp = thickness * armor.toughness * chassis.armorAreaM2 * chassis.structureFactor * 2.0;
  const structureHp = chassis.massKg * 9 * chassis.structureFactor;
  const wheelHp = wheel.hp;
  const weaponHp = weapon.hp;
  const totalHp = armorHp + structureHp;

  // --- Mobility -------------------------------------------------------------
  // Heavier robots give up top speed; a reference bot of 110 kg runs at the
  // drive's rated numbers.
  const massRatio = clamp(110 / Math.max(totalMassKg, 1), 0.55, 1.6);
  const topSpeedMps = drive.topSpeedMps * clamp(0.55 + 0.45 * massRatio, 0.5, 1.15);

  // Force at the contact patch is whichever runs out first: the grip available
  // to the driven wheels, or the power the motors can actually deliver.
  const tractionLimitN =
    totalMassKg * 9.81 * wheel.grip * drive.tractionShare * TRACTION_EFFICIENCY;
  const powerW = drive.powerW * DRIVETRAIN_EFFICIENCY;
  const pushForceN = tractionLimitN;

  // Average acceleration from rest to top speed, integrated properly across
  // both regimes. Below the crossover speed the tyres are the limit and mass
  // cancels out; above it the motors are the limit and mass very much does not.
  const crossoverV = Math.min(powerW / Math.max(tractionLimitN, 1), topSpeedMps);
  const tTraction = crossoverV / Math.max(tractionLimitN / totalMassKg, 1e-6);
  const tPower =
    topSpeedMps > crossoverV
      ? (totalMassKg * (topSpeedMps * topSpeedMps - crossoverV * crossoverV)) / (2 * powerW)
      : 0;
  const accelMps2 = topSpeedMps / Math.max(tTraction + tPower, 1e-6);

  const turnRate = 3.2 * drive.agility * clamp(110 / Math.max(totalMassKg, 1), 0.6, 1.4);

  // --- Weapon ---------------------------------------------------------------
  const rotorInertia =
    weapon.rotorMassKg > 0 && weapon.radiusM > 0
      ? spinnerInertia(weapon.rotorMassKg, weapon.radiusM, weapon.rimFraction)
      : 0;
  const omega = rpmToRadPerSec(weapon.rpm);
  const spinEnergy = 0.5 * rotorInertia * omega * omega;
  const weaponEnergyJ = weapon.burstJ > 0 ? weapon.burstJ : spinEnergy;
  // Spin-up time from energy over available power, with drivetrain losses.
  const spinUpTime = weapon.powerW > 0 && spinEnergy > 0 ? spinEnergy / (weapon.powerW * 0.78) : 0;
  const tipSpeedMps = omega * weapon.radiusM;

  return {
    chassis,
    armor,
    drive,
    wheel,
    weapon,
    armorMassKg,
    totalMassKg,
    totalMassLb: totalMassKg * 2.2046226218,
    overweightKg,
    legal: overweightKg <= 1e-6 && isMountCompatible(chassis, weapon),
    armorHp,
    structureHp,
    wheelHp,
    weaponHp,
    totalHp,
    topSpeedMps,
    accelMps2,
    turnRate,
    pushForceN,
    weaponEnergyJ,
    spinUpTime,
    tipSpeedMps,
    rotorInertia,
    invertible: chassis.invertible,
    // An invertible frame never needs righting; anything else needs the arm.
    selfRighting: chassis.invertible || design.srimech,
  };
}

/**
 * Largest armour thickness that still makes weight for the rest of the design.
 * Returns 0 when the design cannot make weight at any thickness.
 */
export function maxLegalThickness(design: BotDesign): number {
  const chassis = getChassis(design.chassisId);
  const armor = getArmor(design.armorId);
  const drive = getDrive(design.driveId);
  const wheel = getWheel(design.wheelId);
  const weapon = getWeapon(design.weaponId);
  const srimechMass = design.srimech ? SRIMECH_MASS_KG : 0;

  const nonArmor = chassis.massKg + drive.massKg + wheel.massKg + weapon.massKg + srimechMass;
  const budget = WEIGHT_LIMIT_KG - nonArmor;
  if (budget <= 0) return 0;

  const mmPerKg = 1000 / (chassis.armorAreaM2 * armor.densityKgM3);
  return clamp(budget * mmPerKg, 0, armor.maxThicknessMm);
}

/** A sensible, legal, fun starting robot. */
export function defaultDesign(): BotDesign {
  return {
    name: 'ANTIFLOCK',
    chassisId: 'barframe',
    armorId: 'ti64',
    armorThicknessMm: 4.5,
    driveId: '4wd-chain',
    wheelId: 'colson',
    weaponId: 'bar',
    primaryColor: 0xd93b1f,
    secondaryColor: 0x191b1f,
    accentColor: 0x36d1ff,
    livery: 'stripes',
    srimech: false,
  };
}

/** Deep copy, so the garage can edit a draft without touching the live design. */
export function cloneDesign(design: BotDesign): BotDesign {
  return { ...design };
}
