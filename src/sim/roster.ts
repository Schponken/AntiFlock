/**
 * A roster of opponent robots.
 *
 * Each of these is a legal 250 lb build expressing a different school of
 * design, so the player meets genuinely different problems: something that
 * cannot be out-armoured, something that cannot be out-driven, something that
 * will throw them at the ceiling. They are built through the same customiser
 * the player uses — there is no special hardware here.
 */

import { Rng } from '../core/rng';
import {
  ARMOR,
  CHASSIS,
  DRIVES,
  LIVERIES,
  WEAPONS,
  WHEELS,
  computeStats,
  isMountCompatible,
  maxLegalThickness,
  type BotDesign,
} from './parts';

/** Trim a design's armour down until it makes weight. */
export function makeLegal(design: BotDesign): BotDesign {
  const limit = maxLegalThickness(design);
  return {
    ...design,
    armorThicknessMm: limit > 0 ? Math.min(design.armorThicknessMm, limit) : 0.5,
  };
}

const ROSTER_SOURCE: readonly BotDesign[] = [
  {
    name: 'TOMBWEIGHT',
    chassisId: 'barframe',
    armorId: 'ar500',
    armorThicknessMm: 3,
    driveId: '4wd-chain',
    wheelId: 'colson',
    weaponId: 'bar',
    primaryColor: 0x1b1d22,
    secondaryColor: 0xd7d9dd,
    accentColor: 0xff6a1a,
    livery: 'plain',
    srimech: false,
  },
  {
    name: 'HIGH VOLTAGE',
    chassisId: 'wedge',
    armorId: 'ti64',
    armorThicknessMm: 7,
    driveId: '4wd-brushless',
    wheelId: 'colson',
    weaponId: 'flipper',
    primaryColor: 0xf2c218,
    secondaryColor: 0x1a1c20,
    accentColor: 0x35e0ff,
    livery: 'hazard',
    srimech: true,
  },
  {
    name: 'ROTOVATOR',
    chassisId: 'drumframe',
    armorId: 'ar500',
    armorThicknessMm: 5,
    driveId: '4wd-sprint',
    wheelId: 'foam',
    weaponId: 'drum',
    primaryColor: 0x2f8f3f,
    secondaryColor: 0x0e1a10,
    accentColor: 0xc8ff3a,
    livery: 'stripes',
    srimech: false,
  },
  {
    name: 'BLOCKHOUSE',
    chassisId: 'tank',
    armorId: 'ar500',
    armorThicknessMm: 6,
    driveId: '6wd',
    wheelId: 'hub',
    weaponId: 'hammer',
    primaryColor: 0x6b6f76,
    secondaryColor: 0x22262c,
    accentColor: 0xffb020,
    livery: 'rivets',
    srimech: false,
  },
  {
    name: 'UNDERCUT',
    chassisId: 'drumframe',
    armorId: 'ti64',
    armorThicknessMm: 4,
    driveId: '4wd-chain',
    wheelId: 'colson',
    weaponId: 'disc',
    primaryColor: 0x8f2bd6,
    secondaryColor: 0x14061f,
    accentColor: 0xff3ad0,
    livery: 'splitface',
    srimech: false,
  },
  {
    name: 'CUTTING BOARD',
    chassisId: 'wedge',
    armorId: 'uhmw',
    armorThicknessMm: 26,
    driveId: '6wd',
    wheelId: 'pneumatic',
    weaponId: 'none',
    primaryColor: 0xe9e6dc,
    secondaryColor: 0x2a2d33,
    accentColor: 0xff3a24,
    livery: 'checker',
    srimech: true,
  },
  {
    name: 'MEATGRINDER',
    chassisId: 'shell',
    armorId: 's7',
    armorThicknessMm: 4,
    driveId: '4wd-chain',
    wheelId: 'hub',
    weaponId: 'bar',
    primaryColor: 0x8c1f18,
    secondaryColor: 0xdedede,
    accentColor: 0xffaa00,
    livery: 'flames',
    srimech: false,
  },
  {
    name: 'THE VICE',
    chassisId: 'liftframe',
    armorId: 'ti64',
    armorThicknessMm: 6,
    driveId: '4wd-chain',
    wheelId: 'colson',
    weaponId: 'crusher',
    primaryColor: 0x1c4f8f,
    secondaryColor: 0xd8e4f2,
    accentColor: 0xffd400,
    livery: 'stripes',
    srimech: true,
  },
];

/** Every roster entry, trimmed to make weight. */
export const ROSTER: readonly BotDesign[] = ROSTER_SOURCE.map(makeLegal);

/** Pick an opponent, avoiding a mirror match where possible. */
export function pickOpponent(rng: Rng, avoidName?: string): BotDesign {
  const options = ROSTER.filter((d) => d.name !== avoidName);
  return { ...rng.pick(options.length > 0 ? options : ROSTER) };
}

const NAME_PARTS_A = [
  'IRON', 'BLACK', 'RED', 'STEEL', 'MAD', 'DEAD', 'SKULL', 'RAZOR', 'STORM',
  'THUNDER', 'GRIM', 'ATOMIC', 'SAVAGE', 'RUST', 'VOID',
];
const NAME_PARTS_B = [
  'HAMMER', 'JAW', 'FANG', 'WEDGE', 'CLAW', 'BREAKER', 'RIPPER', 'CRUSHER',
  'SPIKE', 'ANVIL', 'BLADE', 'REAPER', 'BRICK', 'MAULER', 'SHREDDER',
];

/**
 * Generate a random legal robot. Used by the garage's dice button and to fill
 * out the field.
 */
export function randomDesign(rng: Rng): BotDesign {
  // Pick a frame first, then only weapons that fit it.
  const chassis = rng.pick(CHASSIS);
  const fitting = WEAPONS.filter((w) => isMountCompatible(chassis, w));
  const weapon = rng.pick(fitting);
  const drive = rng.pick(DRIVES);
  const wheel = rng.pick(WHEELS);
  const armor = rng.pick(ARMOR);

  const base: BotDesign = {
    name: `${rng.pick(NAME_PARTS_A)}${rng.pick(NAME_PARTS_B)}`.slice(0, 16),
    chassisId: chassis.id,
    armorId: armor.id,
    armorThicknessMm: armor.maxThicknessMm,
    driveId: drive.id,
    wheelId: wheel.id,
    weaponId: weapon.id,
    primaryColor: rng.int(0, 0xffffff),
    secondaryColor: rng.int(0, 0xffffff),
    accentColor: rng.int(0, 0xffffff),
    livery: rng.pick(LIVERIES).id,
    srimech: !chassis.invertible && rng.chance(0.6),
  };

  const legal = makeLegal(base);

  // If the combination simply cannot make weight, drop the srimech and try
  // again; failing that, fall back to something from the roster.
  if (computeStats(legal).legal) return legal;

  const lighter = makeLegal({ ...base, srimech: false });
  if (computeStats(lighter).legal) return lighter;

  return { ...rng.pick(ROSTER), name: base.name };
}
