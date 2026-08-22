/**
 * The parts catalogue.
 *
 * Every entry carries genuine physical quantities (kilograms, newton-metres, RPM,
 * megapascals, joules). Nothing here is a hidden "power level" — the builder adds
 * these numbers up, and the physics and damage systems consume them directly, so a
 * heavier disc really does carry more energy into a hit and really does eat into
 * the 113.4 kg weight allowance.
 */

/** Heavyweight class: 250 lb. */
/**
 * How far a crushing jaw actually sinks into a target on one bite, in metres.
 *
 * A clamp's rating is a force, not an energy, so it needs a stroke to become
 * work. That stroke is not the jaw's sweep — the jaw travels half a metre through
 * fresh air and then does all of its damage in the last few centimetres, once the
 * teeth are through the skin and into the frame. Thirty millimetres is what a
 * real hydraulic crusher takes out of a 6 mm plate before the frame behind it
 * stops the jaw, and `force * stroke` then gives a per-bite energy on the same
 * scale as a spinner's stored energy, which is what makes the two comparable.
 */
export const CLAMP_BITE_STROKE_M = 0.03;

export const WEIGHT_LIMIT_KG = 113.398;

export type WeaponKind =
  | 'vertical-spinner'
  | 'horizontal-spinner'
  | 'drum'
  | 'undercutter'
  | 'flipper'
  | 'hammer'
  | 'crusher'
  | 'saw'
  | 'wedge';

/** How a spinning weapon's mass is distributed, which fixes its moment of inertia. */
export type RotorShape = 'disc' | 'bar' | 'drum' | 'ring';

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

export interface MaterialSpec {
  id: string;
  name: string;
  /** kg per cubic metre. */
  density: number;
  /**
   * Energy in joules that one square metre of a one-millimetre-thick sheet
   * absorbs before it fails. This is the single number the damage model uses to
   * convert impact energy into structural damage.
   */
  toughness: number;
  /** 0 = shatters and sheds fragments, 1 = deforms and stays attached. */
  ductility: number;
  /**
   * Surface hardness, 0-1, roughly Brinell normalised to hardened tool steel.
   *
   * Distinct from toughness, and the pair of them is what separates real armour
   * materials from each other. Toughness is how much energy the plate absorbs
   * before it fails; hardness is whether a tooth can get into it at all. A hard
   * face makes a weapon skate instead of bite, and it is what takes the teeth off
   * a spinner — the classic reason a team bolts hardened steel to the front of a
   * machine even though it costs them a third of their weight budget.
   */
  hardness: number;
  /** Surface friction against the arena floor and other bots. */
  friction: number;
  /** How much of an impact bounces back rather than being absorbed. */
  restitution: number;
  /** Relative cost per kilogram — drives the build's price tag. */
  costPerKg: number;
  colorHint: number;
  metalness: number;
  roughness: number;
  blurb: string;
}

export const MATERIALS: readonly MaterialSpec[] = [
  {
    id: 'hdpe',
    name: 'HDPE Polymer',
    density: 970,
    toughness: 5200,
    ductility: 0.95,
    hardness: 0.02,
    friction: 0.55,
    restitution: 0.32,
    costPerKg: 6,
    colorHint: 0x2b3138,
    metalness: 0.0,
    roughness: 0.78,
    blurb: 'Cheap, light, springy. Soaks up spinner hits by flexing instead of cracking.',
  },
  {
    id: 'uhmw',
    name: 'UHMW Sheet',
    density: 935,
    toughness: 6400,
    ductility: 0.98,
    hardness: 0.02,
    friction: 0.22,
    restitution: 0.28,
    costPerKg: 11,
    colorHint: 0xd8d4c8,
    metalness: 0.0,
    roughness: 0.62,
    blurb: 'Slippery and nearly untearable. Weapons skate off it instead of biting.',
  },
  {
    id: 'al7075',
    name: '7075 Aluminium',
    density: 2810,
    toughness: 9800,
    ductility: 0.55,
    hardness: 0.3,
    friction: 0.62,
    restitution: 0.36,
    costPerKg: 24,
    colorHint: 0x9aa2ab,
    metalness: 0.92,
    roughness: 0.36,
    blurb: 'Aerospace alloy. Strong for its weight, but it tears once it starts.',
  },
  {
    id: 'ar500',
    name: 'AR500 Steel',
    density: 7850,
    toughness: 21500,
    ductility: 0.72,
    hardness: 0.95,
    friction: 0.68,
    restitution: 0.28,
    costPerKg: 9,
    colorHint: 0x6b7076,
    metalness: 0.95,
    roughness: 0.42,
    blurb: 'Abrasion-resistant plate. Enormously tough — and enormously heavy.',
  },
  {
    id: 'ti6al4v',
    name: 'Ti-6Al-4V',
    density: 4430,
    toughness: 24800,
    ductility: 0.8,
    hardness: 0.62,
    friction: 0.6,
    restitution: 0.34,
    costPerKg: 140,
    colorHint: 0x8d8f9c,
    metalness: 0.88,
    roughness: 0.44,
    blurb: 'The armour everyone wants and nobody can afford. Dents, refuses to split.',
  },
  {
    id: 'hardox',
    name: 'Hardox 450',
    density: 7800,
    toughness: 19200,
    ductility: 0.68,
    hardness: 0.88,
    friction: 0.66,
    restitution: 0.3,
    costPerKg: 8,
    colorHint: 0x565b61,
    metalness: 0.9,
    roughness: 0.5,
    blurb: 'Wear plate off the shelf. The honest workhorse of the weight class.',
  },
  {
    id: 's7',
    name: 'S7 Tool Steel',
    density: 7830,
    toughness: 26500,
    ductility: 0.45,
    hardness: 0.98,
    friction: 0.64,
    restitution: 0.45,
    costPerKg: 34,
    colorHint: 0x6a7079,
    metalness: 0.97,
    roughness: 0.26,
    blurb: 'Shock-resisting tool steel. The impact material of choice for weapon teeth.',
  },
  {
    id: 'cfrp',
    name: 'Carbon Composite',
    density: 1600,
    toughness: 7100,
    ductility: 0.18,
    hardness: 0.25,
    friction: 0.48,
    restitution: 0.4,
    costPerKg: 90,
    colorHint: 0x2f333a,
    metalness: 0.2,
    roughness: 0.34,
    blurb: 'Featherweight and rigid, until it delaminates into confetti.',
  },
];

export const materialById = (id: string): MaterialSpec =>
  MATERIALS.find((m) => m.id === id) ?? MATERIALS[3]!;

// ---------------------------------------------------------------------------
// Chassis
// ---------------------------------------------------------------------------

export interface ChassisSpec {
  id: string;
  name: string;
  /** Outer envelope in metres (X = width, Y = height, Z = length). */
  width: number;
  height: number;
  length: number;
  /** Bare structure mass with no armour and no drive fitted. */
  frameMass: number;
  /**
   * Square metres of *structural plate* the frame is cut for. This is much less
   * than the outer surface area — it is the load-bearing armour only, not the
   * thin skins and covers that come with the frame mass.
   */
  armorArea: number;
  /** Ride height of the frame underside, metres. */
  groundClearance: number;
  /** Wheels this frame is cut for. */
  wheelCount: 2 | 4 | 6;
  /** Where the weapon bolts on, in chassis-local metres. */
  weaponMount: { x: number; y: number; z: number };
  /** Weapon families this frame can physically accept. */
  accepts: readonly WeaponKind[];
  /** Runs upside-down without a self-righter. */
  invertible: boolean;
  /** Structural health of the frame itself, joules absorbed before it folds. */
  frameIntegrity: number;
  cost: number;
  blurb: string;
}

export const CHASSIS: readonly ChassisSpec[] = [
  {
    id: 'boxframe',
    name: 'Boxframe MK4',
    width: 0.66,
    height: 0.3,
    length: 0.84,
    frameMass: 17,
    armorArea: 0.46,
    groundClearance: 0.035,
    wheelCount: 4,
    weaponMount: { x: 0, y: 0.1, z: 0.46 },
    accepts: ['vertical-spinner', 'drum', 'hammer', 'crusher', 'saw', 'wedge', 'flipper'],
    invertible: false,
    frameIntegrity: 46000,
    cost: 1400,
    blurb: 'The default welded box. Roomy, predictable, takes any weapon you bolt to it.',
  },
  {
    id: 'lowwedge',
    name: 'Lowline Wedge',
    width: 0.72,
    height: 0.19,
    length: 0.8,
    frameMass: 14,
    armorArea: 0.42,
    groundClearance: 0.012,
    wheelCount: 4,
    weaponMount: { x: 0, y: 0.045, z: 0.44 },
    accepts: ['vertical-spinner', 'drum', 'flipper', 'wedge', 'saw'],
    invertible: false,
    frameIntegrity: 39000,
    cost: 1650,
    blurb: 'Twelve millimetres of ground clearance. Gets under everything, hates being flipped.',
  },
  {
    id: 'brick',
    name: 'Anvil Brick',
    width: 0.7,
    height: 0.36,
    length: 0.78,
    frameMass: 26,
    armorArea: 0.58,
    groundClearance: 0.04,
    wheelCount: 4,
    weaponMount: { x: 0, y: 0.13, z: 0.42 },
    accepts: ['vertical-spinner', 'drum', 'hammer', 'crusher', 'wedge', 'saw'],
    invertible: true,
    frameIntegrity: 72000,
    cost: 1900,
    blurb: 'Absurdly overbuilt and fully invertible. Slow, heavy, very hard to stop.',
  },
  {
    id: 'discshell',
    name: 'Discshell',
    width: 0.78,
    height: 0.26,
    length: 0.78,
    frameMass: 19,
    armorArea: 0.5,
    groundClearance: 0.02,
    wheelCount: 2,
    /*
     * The bar sweeps *under* the shell, not over it.
     *
     * At y = 0.16 the rotor centreline sat 0.31 m off the floor, and a bar is only
     * 30 mm thick — so the blade occupied a band from 0.295 to 0.325 m while the
     * hulls it has to reach top out between 0.202 and 0.400 m. Three of the six
     * chassis in the catalogue were entirely below it, and the only frame that
     * mounts these two weapons could never touch them. Dropped so the blade runs
     * at about 120 mm, which is inside the band every hull in the catalogue
     * occupies, and high enough that a metre-wide blade does not ground out the
     * first time the machine pitches under power — which is, after all, what an undercutter is.
     */
    weaponMount: { x: 0, y: -0.03, z: 0 },
    accepts: ['horizontal-spinner', 'undercutter', 'wedge'],
    invertible: true,
    frameIntegrity: 52000,
    cost: 2100,
    blurb: 'Two-wheel round shell built to carry a full-body horizontal weapon.',
  },
  {
    id: 'longbed',
    name: 'Longbed Hauler',
    width: 0.64,
    height: 0.28,
    length: 1.0,
    frameMass: 22,
    armorArea: 0.55,
    groundClearance: 0.03,
    wheelCount: 6,
    weaponMount: { x: 0, y: 0.09, z: 0.54 },
    accepts: ['flipper', 'crusher', 'hammer', 'wedge', 'vertical-spinner', 'saw'],
    invertible: false,
    frameIntegrity: 61000,
    cost: 1750,
    blurb: 'Six driven wheels and a long deck. Pushes like a bulldozer, turns like a bus.',
  },
  {
    id: 'sprinter',
    name: 'Sprinter Chassis',
    width: 0.58,
    height: 0.24,
    length: 0.68,
    frameMass: 11,
    armorArea: 0.32,
    groundClearance: 0.025,
    wheelCount: 4,
    weaponMount: { x: 0, y: 0.08, z: 0.38 },
    accepts: ['vertical-spinner', 'drum', 'saw', 'wedge', 'hammer', 'flipper'],
    invertible: false,
    frameIntegrity: 28000,
    cost: 1250,
    blurb: 'Tiny and light so the weight goes into weapon and drive. Fragile if caught.',
  },
];

export const chassisById = (id: string): ChassisSpec =>
  CHASSIS.find((c) => c.id === id) ?? CHASSIS[0]!;

// ---------------------------------------------------------------------------
// Drive motors and wheels
// ---------------------------------------------------------------------------

export interface MotorSpec {
  id: string;
  name: string;
  /** No-load speed at the bot's pack voltage, revolutions per minute. */
  freeRpm: number;
  /** Stall torque at the motor shaft, newton-metres. */
  stallTorque: number;
  /** Mass of one motor including its gearbox housing, kg. */
  mass: number;
  /** Continuous electrical draw at full send, watts — feeds the battery model. */
  drawWatts: number;
  cost: number;
  blurb: string;
}

export const DRIVE_MOTORS: readonly MotorSpec[] = [
  {
    id: 'brushed550',
    name: 'AF-550 Brushed',
    freeRpm: 5200,
    stallTorque: 1.15,
    mass: 0.34,
    drawWatts: 260,
    cost: 60,
    blurb: 'Cheap brushed can. Fine for a light bot, cooks itself in a long push match.',
  },
  {
    id: 'bl63',
    name: 'Vortex 63 Brushless',
    freeRpm: 9200,
    stallTorque: 2.35,
    mass: 0.62,
    drawWatts: 700,
    cost: 210,
    blurb: 'The sensible modern default. Strong, efficient, spins forever.',
  },
  {
    id: 'ironhide',
    name: 'Ironhide 750',
    freeRpm: 3100,
    stallTorque: 6.2,
    mass: 1.15,
    drawWatts: 900,
    cost: 320,
    blurb: 'Slow-revving torque monster. Wins shoving matches, never wins races.',
  },
  {
    id: 'hyperion',
    name: 'Hyperion Drive Pod',
    freeRpm: 12800,
    stallTorque: 3.4,
    mass: 0.94,
    drawWatts: 1450,
    cost: 480,
    blurb: 'Outrunner and planetary in one pod. Frightening speed if you can steer it.',
  },
];

export const motorById = (id: string): MotorSpec =>
  DRIVE_MOTORS.find((m) => m.id === id) ?? DRIVE_MOTORS[1]!;

export interface WheelSpec {
  id: string;
  name: string;
  /** Rolling radius, metres. */
  radius: number;
  width: number;
  mass: number;
  /** Coefficient of friction against the steel floor. */
  grip: number;
  /** Joules the wheel takes before it is torn off the hub. */
  toughness: number;
  cost: number;
  blurb: string;
}

export const WHEELS: readonly WheelSpec[] = [
  {
    id: 'foamfill',
    name: 'Foam-Filled Colson',
    radius: 0.076,
    width: 0.05,
    mass: 0.9,
    grip: 1.15,
    toughness: 3400,
    cost: 40,
    blurb: 'Grippy, forgiving, and it keeps rolling after it has been chewed.',
  },
  {
    id: 'solidrubber',
    name: 'Solid Rubber Lug',
    radius: 0.089,
    width: 0.062,
    mass: 1.4,
    grip: 1.34,
    toughness: 4200,
    cost: 70,
    blurb: 'Maximum traction. Heavy, and a big fat target hanging off your frame.',
  },
  {
    id: 'hubmotor',
    name: 'Armoured Hub',
    radius: 0.064,
    width: 0.044,
    mass: 1.1,
    grip: 0.95,
    toughness: 6800,
    cost: 160,
    blurb: 'Steel shrouded and tucked inside the frame. Survives what others do not.',
  },
  {
    id: 'bigroller',
    name: 'Big Roller',
    radius: 0.108,
    width: 0.07,
    mass: 2.1,
    grip: 1.2,
    toughness: 3900,
    cost: 95,
    blurb: 'Tall enough to drive inverted and climb over a wedge. Costs you weight.',
  },
];

export const wheelById = (id: string): WheelSpec =>
  WHEELS.find((w) => w.id === id) ?? WHEELS[0]!;

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export interface WeaponSpec {
  id: string;
  name: string;
  kind: WeaponKind;
  /** Structural mass of the mount, motor, belts and armour around the weapon. */
  mountMass: number;
  /** Rotating element, for spinners. */
  rotor?: {
    shape: RotorShape;
    /** Swing radius / half-length, metres. */
    radius: number;
    /** Thickness of the plate or wall, metres. */
    thickness: number;
    /** Bar length or drum width, metres. */
    span: number;
    /** Number of impact teeth. More teeth means more hits but less bite each. */
    teeth: number;
    /**
     * Fraction of the nominal swept volume that is actually metal. Real weapons
     * are pocketed and drilled to move mass outward, so this is well below 1.
     */
    fill: number;
    /** Motor power available to spin it up, watts. */
    motorWatts: number;
    /** Redline, radians per second. */
    maxOmega: number;
    /** Spin axis in chassis-local space. */
    axis: 'x' | 'y' | 'z';
  };
  /** Single-shot actuators: flipper, hammer. */
  actuator?: {
    /** Energy delivered per firing, joules. */
    energy: number;
    /** Shots available before the gas bottle is empty. */
    shots: number;
    /** Seconds between shots. */
    cycleTime: number;
    /** Arm swing, radians. */
    sweep: number;
    /** Arm length, metres. */
    reach: number;
  };
  /** Sustained-force actuators: crusher jaw. */
  clamp?: {
    /** Peak jaw force, newtons. */
    force: number;
    closeTime: number;
    reach: number;
  };
  /** Damage multiplier applied on top of the physical energy calculation. */
  bite: number;
  cost: number;
  blurb: string;
}

export const WEAPONS: readonly WeaponSpec[] = [
  {
    id: 'vert-disc',
    name: 'Vertical Disc',
    kind: 'vertical-spinner',
    mountMass: 9.5,
    rotor: {
      shape: 'disc',
      radius: 0.24,
      thickness: 0.022,
      span: 0.022,
      teeth: 3,
      fill: 0.72,
      motorWatts: 11000,
      maxOmega: 340,
      axis: 'x',
    },
    bite: 1.0,
    cost: 3100,
    blurb: 'A heavy steel wheel spun edge-on. Launches opponents at the lighting rig.',
  },
  {
    id: 'vert-eggbeater',
    name: 'Eggbeater Rotor',
    kind: 'vertical-spinner',
    mountMass: 8.2,
    rotor: {
      shape: 'ring',
      radius: 0.2,
      thickness: 0.018,
      span: 0.34,
      teeth: 4,
      fill: 1,
      motorWatts: 9600,
      maxOmega: 330,
      axis: 'x',
    },
    bite: 0.92,
    cost: 2900,
    blurb: 'Wide cage rotor. Slower at the tip than a disc but it carries more energy, and it never misses low.',
  },
  {
    id: 'horiz-bar',
    name: 'Horizontal Bar',
    kind: 'horizontal-spinner',
    mountMass: 10.5,
    rotor: {
      shape: 'bar',
      radius: 0.46,
      thickness: 0.03,
      span: 0.92,
      teeth: 2,
      fill: 0.86,
      motorWatts: 12500,
      maxOmega: 230,
      axis: 'y',
    },
    bite: 1.12,
    cost: 3600,
    blurb: 'A metre of spinning steel at head height. Enormous reach, enormous gyro.',
  },
  {
    id: 'undercutter',
    name: 'Undercutter Blade',
    kind: 'undercutter',
    mountMass: 9.8,
    rotor: {
      shape: 'bar',
      radius: 0.5,
      thickness: 0.024,
      span: 1.0,
      teeth: 2,
      fill: 0.8,
      motorWatts: 11500,
      maxOmega: 215,
      axis: 'y',
    },
    bite: 1.18,
    cost: 3500,
    blurb: 'Sweeps below the armour line and takes the wheels off. Wedges cannot stop it.',
  },
  {
    id: 'drum',
    name: 'Kinetic Drum',
    kind: 'drum',
    mountMass: 11.5,
    rotor: {
      shape: 'drum',
      radius: 0.155,
      thickness: 0.016,
      span: 0.28,
      teeth: 3,
      fill: 0.92,
      motorWatts: 10500,
      maxOmega: 360,
      axis: 'x',
    },
    bite: 0.95,
    cost: 3300,
    blurb: 'Low, fast and hard to avoid. Scoops opponents up and throws them backwards.',
  },
  {
    id: 'flipper',
    name: 'CO2 Flipper',
    kind: 'flipper',
    mountMass: 16.5,
    actuator: { energy: 2400, shots: 14, cycleTime: 2.6, sweep: 1.35, reach: 0.42 },
    bite: 0.35,
    cost: 3800,
    blurb: 'No cutting, no sparks — just puts the other bot on its back or over the wall.',
  },
  {
    id: 'hammer',
    name: 'Pneumatic Hammer',
    kind: 'hammer',
    mountMass: 14,
    actuator: { energy: 1900, shots: 22, cycleTime: 1.7, sweep: 2.5, reach: 0.55 },
    bite: 1.45,
    cost: 3200,
    blurb: 'Overhead axe with a tool-steel beak. Punches straight through top armour.',
  },
  {
    id: 'crusher',
    name: 'Hydraulic Crusher',
    kind: 'crusher',
    mountMass: 19,
    clamp: { force: 68000, closeTime: 1.4, reach: 0.5 },
    bite: 1.6,
    cost: 4100,
    blurb: 'Sixty-eight kilonewtons of jaw. Slow, relentless, and it does not let go.',
  },
  {
    id: 'saw',
    name: 'Articulated Saw',
    kind: 'saw',
    mountMass: 6.5,
    rotor: {
      shape: 'disc',
      radius: 0.16,
      thickness: 0.008,
      span: 0.008,
      teeth: 24,
      fill: 0.85,
      motorWatts: 2600,
      maxOmega: 360,
      axis: 'x',
    },
    bite: 0.75,
    cost: 1700,
    blurb: 'Light, cheap, showery. Grinds armour away rather than removing it at once.',
  },
  {
    id: 'wedge',
    name: 'Fixed Wedge',
    kind: 'wedge',
    mountMass: 4.5,
    bite: 0.2,
    cost: 700,
    blurb: 'No moving parts to break. Wins on control, aggression and the judges.',
  },
];

export const weaponById = (id: string): WeaponSpec =>
  WEAPONS.find((w) => w.id === id) ?? WEAPONS[0]!;

// ---------------------------------------------------------------------------
// Accessories
// ---------------------------------------------------------------------------

export type AccessoryEffect =
  | 'srimech'
  | 'forks'
  | 'wedgelets'
  | 'ablative'
  | 'bigbattery'
  | 'antispin'
  | 'skirts';

export interface AccessorySpec {
  id: AccessoryEffect;
  name: string;
  mass: number;
  cost: number;
  blurb: string;
}

export const ACCESSORIES: readonly AccessorySpec[] = [
  {
    id: 'srimech',
    name: 'Self-Righting Arm',
    mass: 5.4,
    cost: 900,
    blurb: 'Gets you off your back. Non-negotiable unless the frame runs both ways up.',
  },
  {
    id: 'forks',
    name: 'Ground-Scraping Forks',
    mass: 3.1,
    cost: 420,
    blurb: 'Titanium tines that slide under an opponent before their wedge finds you.',
  },
  {
    id: 'wedgelets',
    name: 'Hinged Wedgelets',
    mass: 2.4,
    cost: 380,
    blurb: 'Floating mini-wedges that follow the floor, closing the gap under your armour.',
  },
  {
    id: 'ablative',
    name: 'Ablative Armour Pack',
    mass: 7.8,
    cost: 640,
    blurb: 'Sacrificial panels that shed energy and fly off spectacularly, saving the frame.',
  },
  {
    id: 'bigbattery',
    name: 'Extended Battery',
    mass: 4.6,
    cost: 750,
    blurb: 'More amp-hours: the weapon spins back up faster and the drive never sags.',
  },
  {
    id: 'antispin',
    name: 'Gyro Compensator',
    mass: 2.9,
    cost: 1100,
    blurb: 'Flywheel and IMU that cancel the gyroscopic lean of a big horizontal weapon.',
  },
  {
    id: 'skirts',
    name: 'Armoured Skirts',
    mass: 6.2,
    cost: 520,
    blurb: 'Drops the armour line to the floor so undercutters cannot reach your wheels.',
  },
];

export const accessoryById = (id: AccessoryEffect): AccessorySpec =>
  ACCESSORIES.find((a) => a.id === id) ?? ACCESSORIES[0]!;

// ---------------------------------------------------------------------------
// Cosmetics
// ---------------------------------------------------------------------------

export interface FinishSpec {
  id: string;
  name: string;
  metalness: number;
  roughness: number;
  clearcoat: number;
}

export const FINISHES: readonly FinishSpec[] = [
  { id: 'gloss', name: 'Gloss Enamel', metalness: 0.15, roughness: 0.18, clearcoat: 1 },
  { id: 'matte', name: 'Matte Wrap', metalness: 0.05, roughness: 0.82, clearcoat: 0 },
  { id: 'metallic', name: 'Metallic Flake', metalness: 0.72, roughness: 0.3, clearcoat: 0.7 },
  { id: 'chrome', name: 'Polished Chrome', metalness: 1.0, roughness: 0.08, clearcoat: 0.4 },
  { id: 'raw', name: 'Bare Metal', metalness: 0.94, roughness: 0.46, clearcoat: 0 },
  { id: 'rust', name: 'Weathered', metalness: 0.55, roughness: 0.9, clearcoat: 0 },
];

export const finishById = (id: string): FinishSpec =>
  FINISHES.find((f) => f.id === id) ?? FINISHES[0]!;

export type DecalId = 'none' | 'stripes' | 'flames' | 'checker' | 'hazard' | 'camo' | 'circuit';

export const DECALS: readonly { id: DecalId; name: string }[] = [
  { id: 'none', name: 'Clean' },
  { id: 'stripes', name: 'Racing Stripes' },
  { id: 'flames', name: 'Flames' },
  { id: 'checker', name: 'Checkerboard' },
  { id: 'hazard', name: 'Hazard Chevrons' },
  { id: 'camo', name: 'Splinter Camo' },
  { id: 'circuit', name: 'Circuit Trace' },
];

// ---------------------------------------------------------------------------
// Derived physical quantities
// ---------------------------------------------------------------------------

/**
 * Where the wheels sit on a given frame.
 *
 * One description, used by the drivetrain that raycasts from these points, the
 * mesh that draws the wheels and cuts the arches for them, and the workshop
 * preview. It was written out three times, which is two opportunities for the
 * collider and the model to disagree about where a wheel is — and they did.
 */
export function driveLayout(
  chassis: ChassisSpec,
  wheel: WheelSpec,
): {
  halfTrack: number;
  /** Height of the wheel centre in body coordinates, the right way up. */
  wheelLocalY: number;
  rows: number;
  /** Body-frame z of each row of wheels, front to back. */
  rowZ: number[];
} {
  const halfTrack = chassis.width / 2 - wheel.width * 0.15;
  const wheelLocalY = wheel.radius - chassis.height / 2 - chassis.groundClearance;
  const rows = chassis.wheelCount / 2;
  const usableLength = chassis.length / 2 - wheel.radius - 0.03;
  const rowZ: number[] = [];
  for (let row = 0; row < rows; row++) {
    rowZ.push(rows === 1 ? 0 : -usableLength + (2 * usableLength * row) / (rows - 1));
  }
  return { halfTrack, wheelLocalY, rows, rowZ };
}

/**
 * Where the weapon actually hangs on a given machine.
 *
 * The catalogue's `weaponMount` is the frame designer's intent, and on its own it
 * is not enough: nothing reconciled it with the rotor that ends up bolted there,
 * and the combinations the builder happily offers include several the intent
 * cannot survive.
 *
 * - A vertical rotor is a disc `radius` tall. On the Lowline Wedge the stock
 *   Vertical Disc was created 88 mm *below the arena floor*, so the machine parked
 *   nose-up on its own weapon with 68% of its weight on the rotor and the blade
 *   ground to a complete stop — 0.0 kJ of a promised 47.8.
 * - A horizontal rotor sweeps a disc wider than the machine, straight through
 *   where the wheels are. It has to pass over the tyres or it passes through them.
 *
 * Both are the same question — what does the rotor's envelope have to clear — so
 * both are answered here, once, for the rig, the mesh and the workshop preview.
 */
export function weaponMountFor(
  chassis: ChassisSpec,
  wheel: WheelSpec,
  weapon: WeaponSpec,
): { x: number; y: number; z: number } {
  const mount = chassis.weaponMount;
  const rotor = weapon.rotor;
  if (!rotor) return mount;

  const clearance = 0.012;
  const rideHeight = chassis.height / 2 + chassis.groundClearance;

  if (rotor.axis === 'x') {
    // Vertical: the bottom of the swept disc has to stay off the floor.
    const lowest = -rideHeight + rotor.radius + clearance;
    return { ...mount, y: Math.max(mount.y, lowest) };
  }

  // Horizontal: the blade sweeps the machine's own footprint, so it has to clear
  // the top of the tyres it sweeps across.
  const { wheelLocalY } = driveLayout(chassis, wheel);
  const halfThickness = (rotor.shape === 'bar' ? rotor.thickness : rotor.span) / 2;
  const aboveWheels = wheelLocalY + wheel.radius + halfThickness + clearance;
  return { ...mount, y: Math.max(mount.y, aboveWheels) };
}

/**
 * Mass of a spinning weapon element, from its geometry and material.
 * Each shape uses its real swept volume rather than a fudge factor.
 */
export function rotorMass(spec: WeaponSpec, material: MaterialSpec): number {
  const r = spec.rotor;
  if (!r) return 0;
  let volume: number;
  switch (r.shape) {
    case 'disc':
      // Flat plate, pocketed around the hub.
      volume = Math.PI * r.radius * r.radius * r.thickness;
      break;
    case 'bar':
      // Rectangular bar: `span` long, 0.24 radii deep, `thickness` thick.
      volume = r.span * (r.radius * 0.24) * r.thickness;
      break;
    case 'drum': {
      // Hollow cylinder wall.
      const outer = Math.PI * r.radius * r.radius;
      const inner = Math.PI * (r.radius - r.thickness) ** 2;
      volume = (outer - inner) * r.span;
      break;
    }
    case 'ring': {
      // Open cage: two annular end plates joined by `teeth` bars along the span.
      const ringWidth = r.thickness * 2.8;
      const ringArea = Math.PI * (r.radius ** 2 - (r.radius - ringWidth) ** 2);
      const endPlates = ringArea * r.thickness * 2;
      const bars = r.teeth * r.span * (r.thickness * 2.2) * (r.thickness * 1.6);
      volume = endPlates + bars;
      break;
    }
  }
  return volume * r.fill * material.density;
}

/**
 * Moment of inertia about the spin axis, kg·m². This is what actually decides how
 * much energy a weapon stores and how long it takes to wind up.
 */
export function rotorInertia(spec: WeaponSpec, material: MaterialSpec): number {
  const r = spec.rotor;
  if (!r) return 0;
  const m = rotorMass(spec, material);
  switch (r.shape) {
    case 'disc': {
      /*
       * A pocketed disc, not a solid one.
       *
       * `fill` has already taken the pocketed metal out of the mass, and the whole
       * point of pocketing a weapon disc is that the metal you remove comes from
       * near the hub, where it contributes almost nothing. Charging that reduced
       * mass the *solid* disc's r^2/2 threw the benefit away and under-reported
       * every disc's stored energy. Treating what is left as an annulus of the
       * same outer radius gives the hollow radius from the fill directly:
       * pi(r^2 - ri^2) = f.pi.r^2, so ri^2 = r^2(1 - f), and I = m(r^2 + ri^2)/2.
       */
      const innerSq = r.radius * r.radius * Math.max(0, 1 - r.fill);
      return 0.5 * m * (r.radius * r.radius + innerSq);
    }
    case 'bar':
      return (1 / 12) * m * r.span * r.span;
    case 'drum':
      // Thin-walled cylinder.
      return m * (r.radius - r.thickness * 0.5) ** 2;
    case 'ring':
      return m * r.radius * r.radius * 0.86;
  }
}

/** Stored kinetic energy in joules at a given angular velocity. */
export const rotorEnergy = (inertia: number, omega: number): number =>
  0.5 * inertia * omega * omega;

/** Linear speed of the outermost tooth, m/s. */
export const tipSpeed = (radius: number, omega: number): number => radius * omega;

/**
 * Principal moments of inertia in the weapon body's own frame, kg·m².
 *
 * The solver is given these numbers directly rather than deriving them from the
 * collision shapes, so the energy the builder promises is exactly the energy the
 * fight delivers.
 */
export function rotorInertiaTensor(
  spec: WeaponSpec,
  material: MaterialSpec,
): { x: number; y: number; z: number } {
  const r = spec.rotor;
  if (!r) return { x: 0.01, y: 0.01, z: 0.01 };

  const spin = rotorInertia(spec, material);
  const m = rotorMass(spec, material);
  let transverse: number;

  switch (r.shape) {
    case 'disc':
      // Perpendicular axis theorem: a flat rotor's transverse inertia is half its spin inertia.
      transverse = spin * 0.5;
      break;
    case 'ring':
    case 'drum':
      // Not flat: a cage or a drum is 340 mm long, and the perpendicular axis
      // theorem does not apply to it. Its transverse inertia is the flat-rotor
      // term plus the stick term for its own length, exactly as for the drum —
      // ignoring the span under-reported an eggbeater's by more than a third.
      transverse = spin * 0.5 + (1 / 12) * m * r.span * r.span;
      break;
    case 'bar':
      // About the bar's own long axis it is essentially a stick: negligible.
      transverse = Math.max(spin * 0.02, (1 / 12) * m * (r.thickness ** 2 + (r.radius * 0.24) ** 2));
      break;
  }

  /*
   * Exactly one axis carries the spin inertia; the other two are transverse.
   *
   * Both non-default branches were wrong: `z` was a verbatim copy of `y`, so a
   * z-axis rotor's spin inertia was written onto Y and its transverse onto Z, and
   * `y` put `spin` on Z as well — giving a horizontal bar fifty times the real
   * transverse inertia. That is the term the gyroscopic model reads, so the
   * machines it should make lean hardest were the ones it barely touched.
   */
  switch (r.axis) {
    case 'y':
      return { x: transverse, y: spin, z: transverse };
    case 'z':
      return { x: transverse, y: transverse, z: spin };
    case 'x':
    default:
      return { x: spin, y: transverse, z: transverse };
  }
}
