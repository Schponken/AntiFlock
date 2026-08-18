/**
 * The arena: a sealed steel-and-polycarbonate box with hazards in the floor
 * and the corners.
 *
 * The dimensions live here as plain constants because both the physics build
 * and the renderer read from them — there is exactly one source of truth for
 * where the walls are.
 */

import { clamp01, smoothstep } from '../core/math';
import {
  GROUPS,
  RAPIER,
  type Physics,
  type Vec3,
} from './physics';

/** Interior floor is a 48 ft square, same as the real cage. */
export const ARENA_SIZE = 14.63;
export const ARENA_HALF = ARENA_SIZE / 2;
/** Polycarbonate goes up this high before the roof structure starts. */
export const WALL_HEIGHT = 2.6;
/** Roof height — vertical spinners genuinely reach it. */
export const CEILING_HEIGHT = 4.2;
/** Thickness of the wall colliders. */
export const WALL_THICKNESS = 0.35;
/** Height of the angled steel kick plate around the bottom of the walls. */
export const KICKPLATE_HEIGHT = 0.42;

/** Where the two robots are placed for the start of a match. */
export const START_POSITIONS = {
  red: { x: -4.4, y: 0.35, z: 0 } as Vec3,
  blue: { x: 4.4, y: 0.35, z: 0 } as Vec3,
};

/** Two banks of killsaws set into the floor, three blades each. */
export interface SawBankLayout {
  /** Centre of the bank on the floor. */
  readonly x: number;
  readonly z: number;
  /** Blades run along Z; this is the spacing between them. */
  readonly spacing: number;
  readonly bladeCount: number;
  readonly radius: number;
  readonly thickness: number;
  /** Seconds between automatic firings. */
  readonly period: number;
  /** Offset into the cycle, so the two banks do not fire together. */
  readonly phase: number;
}

export const SAW_BANKS: readonly SawBankLayout[] = [
  { x: -2.6, z: 0, spacing: 0.38, bladeCount: 3, radius: 0.34, thickness: 0.02, period: 9, phase: 0 },
  { x: 2.6, z: 0, spacing: 0.38, bladeCount: 3, radius: 0.34, thickness: 0.02, period: 9, phase: 4.5 },
];

/** How far a saw rises out of its slot when fired. */
export const SAW_RISE = 0.3;
/** Seconds the saws stay up. */
export const SAW_UP_TIME = 2.6;
/** Blade speed. */
export const SAW_RPM = 2600;

/** Corner pulverisers — hinged hammers that slam down on command. */
export interface PulveriserLayout {
  readonly x: number;
  readonly z: number;
  /** Yaw so the hammer swings toward the middle of the arena. */
  readonly yaw: number;
}

export const PULVERISERS: readonly PulveriserLayout[] = [
  { x: -ARENA_HALF + 1.5, z: -ARENA_HALF + 1.5, yaw: Math.PI * 0.25 },
  { x: ARENA_HALF - 1.5, z: -ARENA_HALF + 1.5, yaw: Math.PI * 0.75 },
  { x: -ARENA_HALF + 1.5, z: ARENA_HALF - 1.5, yaw: -Math.PI * 0.25 },
  { x: ARENA_HALF - 1.5, z: ARENA_HALF - 1.5, yaw: -Math.PI * 0.75 },
];

/** Reach of a pulveriser arm from its pivot. */
export const PULVERISER_REACH = 1.5;
/** Seconds for a full down-and-up cycle. */
export const PULVERISER_CYCLE = 1.1;
/** Energy a pulveriser puts into whatever is underneath it, joules. */
export const PULVERISER_ENERGY = 2400;
/** Radius on the floor within which a pulveriser can connect. */
export const PULVERISER_RADIUS = 0.95;
/** Seconds a pulveriser must recharge between swings. */
export const PULVERISER_COOLDOWN = 2.4;

/** Energy a killsaw delivers per second of sustained contact, joules. */
export const SAW_ENERGY_RATE = 1200;
/**
 * Saw damage is applied in discrete bites rather than every physics step.
 * Stepping at 240 Hz would otherwise push a per-step energy so small it falls
 * under the damage threshold, while still firing 240 times a second.
 */
export const SAW_BITE_INTERVAL = 0.08;

// ---------------------------------------------------------------------------
// Runtime hazard state
// ---------------------------------------------------------------------------

export interface SawState {
  readonly layout: SawBankLayout;
  /** 0 = fully retracted in the slot, 1 = fully deployed. */
  extension: number;
  /** Blade angle, radians. */
  angle: number;
  /** Currently commanded up. */
  firing: boolean;
  timer: number;
  /** Rigid bodies for the blades, one per blade. */
  bodies: RAPIER.RigidBody[];
  /** Resting Y of the blade centres when fully retracted. */
  restY: number;
}

export interface PulveriserState {
  readonly layout: PulveriserLayout;
  /** 0 = fully raised, 1 = fully slammed down. */
  swing: number;
  firing: boolean;
  timer: number;
  cooldown: number;
  /** Set for one tick on the frame the head lands. */
  justStruck: boolean;
}

export interface Arena {
  saws: SawState[];
  pulverisers: PulveriserState[];
  /** True when the automatic hazard timers are running. */
  active: boolean;
}

/**
 * Build the arena's static colliders and the kinematic hazard bodies.
 */
export function buildArena(physics: Physics): Arena {
  const { world } = physics;

  const staticBox = (
    hx: number,
    hy: number,
    hz: number,
    pos: Vec3,
    kind: 'floor' | 'wall' | 'ceiling',
    friction: number,
    restitution: number,
  ) => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z));
    const collider = world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setFriction(friction)
        .setRestitution(restitution)
        .setCollisionGroups(GROUPS.arena)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(600),
      body,
    );
    physics.register(collider, { kind });
    return collider;
  };

  // Floor. Steel plate: grippy, and it does not give.
  staticBox(ARENA_HALF, 0.5, ARENA_HALF, { x: 0, y: -0.5, z: 0 }, 'floor', 0.9, 0.05);

  // Four walls, set just outside the playing surface.
  const wallY = WALL_HEIGHT / 2;
  const outset = ARENA_HALF + WALL_THICKNESS / 2;
  staticBox(WALL_THICKNESS / 2, wallY, ARENA_HALF + WALL_THICKNESS, { x: -outset, y: wallY, z: 0 }, 'wall', 0.25, 0.35);
  staticBox(WALL_THICKNESS / 2, wallY, ARENA_HALF + WALL_THICKNESS, { x: outset, y: wallY, z: 0 }, 'wall', 0.25, 0.35);
  staticBox(ARENA_HALF + WALL_THICKNESS, wallY, WALL_THICKNESS / 2, { x: 0, y: wallY, z: -outset }, 'wall', 0.25, 0.35);
  staticBox(ARENA_HALF + WALL_THICKNESS, wallY, WALL_THICKNESS / 2, { x: 0, y: wallY, z: outset }, 'wall', 0.25, 0.35);

  // Roof, so a vertical spinner throwing a robot four metres up does not lose it.
  staticBox(
    ARENA_HALF + WALL_THICKNESS,
    0.25,
    ARENA_HALF + WALL_THICKNESS,
    { x: 0, y: CEILING_HEIGHT + 0.25, z: 0 },
    'ceiling',
    0.3,
    0.2,
  );

  // --- Killsaws -------------------------------------------------------------
  const saws: SawState[] = SAW_BANKS.map((layout) => {
    const bodies: RAPIER.RigidBody[] = [];
    const restY = -layout.radius - 0.02; // fully buried in the slot
    const first = -((layout.bladeCount - 1) / 2) * layout.spacing;

    for (let i = 0; i < layout.bladeCount; i++) {
      const z = layout.z + first + i * layout.spacing;
      const body = world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(layout.x, restY, z),
      );
      const collider = world.createCollider(
        RAPIER.ColliderDesc.cylinder(layout.thickness / 2, layout.radius)
          // A cylinder's axis is Y; rotate it so the disc stands upright and
          // spins about the arena's X axis.
          .setRotation(quatFromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2))
          .setFriction(0.45)
          .setRestitution(0.1)
          .setCollisionGroups(GROUPS.hazard)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(200),
        body,
      );
      physics.register(collider, { kind: 'saw' });
      bodies.push(body);
    }

    return { layout, extension: 0, angle: 0, firing: false, timer: layout.phase, bodies, restY };
  });

  // --- Pulverisers ----------------------------------------------------------
  const pulverisers: PulveriserState[] = PULVERISERS.map((layout) => ({
    layout,
    swing: 0,
    firing: false,
    timer: 0,
    cooldown: 0,
    justStruck: false,
  }));

  return { saws, pulverisers, active: false };
}

/** Quaternion from an axis and an angle. */
export function quatFromAxisAngle(axis: Vec3, angle: number): RAPIER.Rotation {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

/**
 * Advance the hazards. Returns nothing; the caller reads the state for
 * rendering and for damage.
 */
export function stepArena(arena: Arena, dt: number): void {
  const sawOmega = (SAW_RPM * 2 * Math.PI) / 60;

  for (const saw of arena.saws) {
    if (arena.active) {
      saw.timer += dt;
      if (!saw.firing && saw.timer >= saw.layout.period) {
        saw.firing = true;
        saw.timer = 0;
      } else if (saw.firing && saw.timer >= SAW_UP_TIME) {
        saw.firing = false;
        saw.timer = 0;
      }
    }

    // Rise fast, retract more slowly.
    const target = saw.firing ? 1 : 0;
    const rate = saw.firing ? 4.5 : 2.2;
    saw.extension += Math.sign(target - saw.extension) * Math.min(rate * dt, Math.abs(target - saw.extension));
    saw.extension = clamp01(saw.extension);

    // Blades only turn while they are out of the slot.
    if (saw.extension > 0.02) saw.angle = (saw.angle + sawOmega * dt) % (Math.PI * 2);

    const y = saw.restY + saw.extension * (saw.layout.radius + SAW_RISE);
    for (const body of saw.bodies) {
      const t = body.translation();
      body.setNextKinematicTranslation({ x: t.x, y, z: t.z });
    }
  }

  for (const pulveriser of arena.pulverisers) {
    pulveriser.justStruck = false;
    if (pulveriser.cooldown > 0) pulveriser.cooldown = Math.max(0, pulveriser.cooldown - dt);

    if (pulveriser.firing) {
      const before = pulveriser.timer;
      pulveriser.timer += dt;
      const t = pulveriser.timer / PULVERISER_CYCLE;
      // Slam down over the first third of the cycle, wind back up over the rest.
      pulveriser.swing = t < 0.33 ? smoothstep(0, 0.33, t) : 1 - smoothstep(0.33, 1, t);
      // The head lands at the bottom of the stroke.
      const strikeAt = 0.33 * PULVERISER_CYCLE;
      if (before < strikeAt && pulveriser.timer >= strikeAt) pulveriser.justStruck = true;
      if (pulveriser.timer >= PULVERISER_CYCLE) {
        pulveriser.firing = false;
        pulveriser.timer = 0;
        pulveriser.swing = 0;
        pulveriser.cooldown = PULVERISER_COOLDOWN;
      }
    }
  }
}

/** Fire a pulveriser, if it is charged. Returns true if it actually swung. */
export function firePulveriser(pulveriser: PulveriserState): boolean {
  if (pulveriser.firing || pulveriser.cooldown > 0) return false;
  pulveriser.firing = true;
  pulveriser.timer = 0;
  return true;
}

/** World-space position of a pulveriser's head at its current swing. */
export function pulveriserHeadPosition(p: PulveriserState): Vec3 {
  const pivotY = 2.35;
  // The arm sweeps from straight out to straight down.
  const angle = -Math.PI / 2 + p.swing * (Math.PI / 2 - 0.18);
  const reach = PULVERISER_REACH;
  const horizontal = Math.cos(angle) * reach;
  return {
    x: p.layout.x - Math.cos(p.layout.yaw) * horizontal,
    y: pivotY + Math.sin(angle) * reach,
    z: p.layout.z - Math.sin(p.layout.yaw) * horizontal,
  };
}

/** True when a point on the floor is under a given pulveriser's head. */
export function isUnderPulveriser(p: PulveriserState, point: Vec3): boolean {
  const head = pulveriserHeadPosition(p);
  const dx = point.x - head.x;
  const dz = point.z - head.z;
  return dx * dx + dz * dz <= PULVERISER_RADIUS * PULVERISER_RADIUS;
}

/** True when a world point is inside the playing surface. */
export function isInsideArena(point: Vec3, margin = 0): boolean {
  return (
    Math.abs(point.x) <= ARENA_HALF - margin &&
    Math.abs(point.z) <= ARENA_HALF - margin &&
    point.y > -1 &&
    point.y < CEILING_HEIGHT + 1
  );
}

/** Distance from a point to the nearest wall, negative when outside. */
export function distanceToWall(point: Vec3): number {
  return Math.min(
    ARENA_HALF - Math.abs(point.x),
    ARENA_HALF - Math.abs(point.z),
  );
}
