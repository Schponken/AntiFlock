/**
 * Rapier interaction groups.
 *
 * A Rapier `InteractionGroups` is a 32-bit value: the high 16 bits are the
 * membership bitmask ("what am I?") and the low 16 bits are the filter
 * ("what am I allowed to touch?"). Two colliders interact only if each one's
 * membership appears in the other one's filter.
 */

export const Layer = {
  ARENA: 1 << 0,
  HAZARD: 1 << 1,
  DEBRIS: 1 << 2,
  /** Chassis, armour and wheels of team 0 / team 1. */
  BODY_0: 1 << 3,
  BODY_1: 1 << 4,
  /** Spinners, hammers, flipper arms of team 0 / team 1. */
  WEAPON_0: 1 << 5,
  WEAPON_1: 1 << 6,
} as const;

export type LayerMask = number;

export const groups = (membership: LayerMask, filter: LayerMask): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

export const membershipOf = (interactionGroups: number): LayerMask =>
  (interactionGroups >>> 16) & 0xffff;

export const filterOf = (interactionGroups: number): LayerMask => interactionGroups & 0xffff;

const ALL = 0xffff;

/** Arena shell and floor: collides with everything. */
export const ARENA_GROUPS = groups(Layer.ARENA, ALL);

/** Powered hazards (killsaws, pulverisers): collide with bots and debris. */
export const HAZARD_GROUPS = groups(
  Layer.HAZARD,
  Layer.BODY_0 | Layer.BODY_1 | Layer.WEAPON_0 | Layer.WEAPON_1 | Layer.DEBRIS | Layer.ARENA,
);

/**
 * Torn-off parts: bounce around the box and can get in a bot's way.
 *
 * The weapon layers belong in this filter. Interaction is an AND of both sides'
 * masks, and the weapon filter already lists DEBRIS — leaving WEAPON_0/WEAPON_1
 * out here made that half of the agreement void, so a shed panel passed straight
 * through a spinning bar as if neither existed. Debris being batted across the box
 * by a live weapon is one of the most recognisable images in the sport.
 */
export const DEBRIS_GROUPS = groups(
  Layer.DEBRIS,
  Layer.ARENA |
    Layer.HAZARD |
    Layer.DEBRIS |
    Layer.BODY_0 |
    Layer.BODY_1 |
    Layer.WEAPON_0 |
    Layer.WEAPON_1,
);

const bodyLayer = (team: number): LayerMask => (team === 0 ? Layer.BODY_0 : Layer.BODY_1);
const weaponLayer = (team: number): LayerMask => (team === 0 ? Layer.WEAPON_0 : Layer.WEAPON_1);

/**
 * A bot's own weapon must not collide with its own frame — the two are held
 * together by a joint, and self-collision would instantly stall the weapon.
 * Everything belonging to the opposing bot is fair game.
 */
export const bodyGroups = (team: number): number => {
  const enemy = team === 0 ? 1 : 0;
  return groups(
    bodyLayer(team),
    Layer.ARENA | Layer.HAZARD | Layer.DEBRIS | bodyLayer(enemy) | weaponLayer(enemy),
  );
};

export const weaponGroups = (team: number): number => {
  const enemy = team === 0 ? 1 : 0;
  return groups(
    weaponLayer(team),
    Layer.ARENA | Layer.HAZARD | Layer.DEBRIS | bodyLayer(enemy) | weaponLayer(enemy),
  );
};

/** True when two interaction-group values are mutually permitted to interact. */
export const canInteract = (a: number, b: number): boolean =>
  (membershipOf(a) & filterOf(b)) !== 0 && (membershipOf(b) & filterOf(a)) !== 0;
