/**
 * The physics world.
 *
 * Rapier does the rigid-body integration; this module owns the world, the
 * fixed-timestep accumulator, and the bookkeeping that lets a raw collider
 * handle coming out of a contact event be traced back to the robot part it
 * belongs to.
 *
 * Fixed timestep is not optional here. A bar spinner at 1400 rpm sweeps 140°
 * of arc in a single 60 Hz frame; stepping at 240 Hz keeps the contact
 * resolution honest and stops fast rotors tunnelling through armour.
 */

import RAPIER from '@dimforge/rapier3d-compat';

/** Physics runs at a fixed 240 Hz regardless of display refresh rate. */
export const PHYSICS_HZ = 240;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
/** Never simulate more than this much wall-clock time in one frame. */
export const MAX_FRAME_TIME = 0.1;

let initialised = false;

/** Load the Rapier wasm module. Safe to call more than once. */
export async function initPhysics(): Promise<void> {
  if (initialised) return;
  await RAPIER.init();
  initialised = true;
}

export { RAPIER };

export type PartKind =
  | 'floor'
  | 'wall'
  | 'ceiling'
  | 'saw'
  | 'hammer'
  | 'hull'
  | 'wheel'
  | 'weapon'
  | 'debris';

/** What a collider belongs to, so contacts can be attributed. */
export interface ColliderOwner {
  kind: PartKind;
  /** Which robot, when the collider is part of one. */
  botId?: string;
  /** Wheel index, for wheel colliders. */
  index?: number;
}

/** Collision membership bits. */
export const GROUP = {
  ARENA: 0x0001,
  BOT: 0x0002,
  WEAPON: 0x0004,
  HAZARD: 0x0008,
  DEBRIS: 0x0010,
} as const;

/**
 * Build a Rapier interaction group: membership in the high 16 bits, the set of
 * groups it will collide with in the low 16.
 */
export function interactionGroups(membership: number, collidesWith: number): number {
  return ((membership & 0xffff) << 16) | (collidesWith & 0xffff);
}

const ALL_SOLID = GROUP.ARENA | GROUP.BOT | GROUP.WEAPON | GROUP.HAZARD;

export const GROUPS = {
  arena: interactionGroups(GROUP.ARENA, ALL_SOLID | GROUP.DEBRIS),
  hull: interactionGroups(GROUP.BOT, ALL_SOLID),
  weapon: interactionGroups(GROUP.WEAPON, ALL_SOLID),
  hazard: interactionGroups(GROUP.HAZARD, ALL_SOLID),
  // Debris bounces off the arena but never off robots or other debris, so a
  // shower of shrapnel can never affect the outcome of a fight.
  debris: interactionGroups(GROUP.DEBRIS, GROUP.ARENA),
} as const;

/** One contact reported to the game layer. */
export interface ContactReport {
  a: ColliderOwner;
  b: ColliderOwner;
  /** World-space point of the strongest contact. */
  point: RAPIER.Vector3;
  /** Unit direction of the strongest force. */
  normal: RAPIER.Vector3;
  /** Peak contact force magnitude, newtons. */
  forceMag: number;
}

export class Physics {
  readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  private readonly owners = new Map<number, ColliderOwner>();
  private accumulator = 0;
  /** Total simulated time, seconds. */
  elapsed = 0;
  /** How many fixed steps the last `advance` call ran. */
  lastStepCount = 0;

  constructor(gravityY = -9.81) {
    if (!initialised) {
      throw new Error('initPhysics() must be awaited before constructing Physics');
    }
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    // Four solver iterations keeps heavy robots from sinking into each other
    // when a spinner is grinding against armour.
    this.world.numSolverIterations = 8;
    this.events = new RAPIER.EventQueue(true);
  }

  /** Register what a collider belongs to. */
  register(collider: RAPIER.Collider, owner: ColliderOwner): void {
    this.owners.set(collider.handle, owner);
  }

  unregister(collider: RAPIER.Collider): void {
    this.owners.delete(collider.handle);
  }

  ownerOf(handle: number): ColliderOwner | undefined {
    return this.owners.get(handle);
  }

  /**
   * Run the fixed-step loop for one rendered frame.
   *
   * `preStep` runs immediately before each physics step, so per-step forces
   * (drive, weapon motors, hazards) are applied at the simulation rate rather
   * than the frame rate. `postStep` runs immediately after every step —
   * including steps that produced no contacts at all — and receives that step's
   * contacts, which is where per-step measurements like a rotor's energy loss
   * have to be taken.
   */
  advance(callbacks: {
    frameTime: number;
    preStep: (dt: number) => void;
    postStep?: (dt: number, contacts: ContactReport[]) => void;
  }): void {
    const { frameTime, preStep, postStep } = callbacks;
    this.accumulator += Math.min(frameTime, MAX_FRAME_TIME);
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT) {
      this.accumulator -= PHYSICS_DT;
      preStep(PHYSICS_DT);
      this.world.timestep = PHYSICS_DT;
      this.world.step(this.events);
      this.elapsed += PHYSICS_DT;
      steps++;
      if (postStep) {
        postStep(PHYSICS_DT, this.collectContacts());
      } else {
        this.events.drainContactForceEvents(() => {});
        this.events.drainCollisionEvents(() => {});
      }
    }
    this.lastStepCount = steps;
  }

  /** Fraction of a physics step left over, for render interpolation. */
  get interpolationAlpha(): number {
    return this.accumulator / PHYSICS_DT;
  }

  private collectContacts(): ContactReport[] {
    const out: ContactReport[] = [];

    this.events.drainContactForceEvents((event) => {
      const h1 = event.collider1();
      const h2 = event.collider2();
      const a = this.owners.get(h1);
      const b = this.owners.get(h2);
      if (!a || !b) return;

      const c1 = this.world.getCollider(h1);
      const c2 = this.world.getCollider(h2);
      if (!c1 || !c2) return;

      const normal = event.maxForceDirection();
      const forceMag = event.maxForceMagnitude();

      // Dig the actual contact point out of the manifold so damage can be
      // attributed to the right armour zone.
      let point: RAPIER.Vector3 = { x: 0, y: 0, z: 0 } as RAPIER.Vector3;
      let found = false;
      this.world.contactPair(c1, c2, (manifold) => {
        const solverCount = manifold.numSolverContacts();
        if (solverCount === 0) return;

        // Prefer the contact carrying the most impulse — that is the one that
        // actually did the damage. The impulse and solver-point arrays are
        // indexed separately, so only trust an index valid in both.
        let bestIndex = 0;
        let bestImpulse = -Infinity;
        const impulseCount = Math.min(manifold.numContacts(), solverCount);
        for (let i = 0; i < impulseCount; i++) {
          const impulse = manifold.contactImpulse(i);
          if (impulse > bestImpulse) {
            bestImpulse = impulse;
            bestIndex = i;
          }
        }

        const p = manifold.solverContactPoint(bestIndex) ?? manifold.solverContactPoint(0);
        if (p) {
          point = p as RAPIER.Vector3;
          found = true;
        }
      });

      if (!found) {
        // No manifold detail available; fall back to the midpoint of the pair.
        const p1 = c1.translation();
        const p2 = c2.translation();
        point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 } as RAPIER.Vector3;
      }

      out.push({ a, b, point, normal: normal as RAPIER.Vector3, forceMag });
    });

    // Collision start/stop events are enabled on the same colliders; drain them
    // so the queue does not grow without bound.
    this.events.drainCollisionEvents(() => {});

    return out;
  }

  /** Tear the world down and release the wasm memory it holds. */
  dispose(): void {
    this.owners.clear();
    this.events.free();
    this.world.free();
  }
}

// ---------------------------------------------------------------------------
// Small vector helpers. Rapier hands back plain {x,y,z} objects, and doing the
// arithmetic here avoids allocating a Three.js Vector3 inside the physics loop.
// ---------------------------------------------------------------------------

export type Vec3 = { x: number; y: number; z: number };

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-9 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Rotate a vector by a quaternion. */
export function rotateVec(q: { x: number; y: number; z: number; w: number }, v: Vec3): Vec3 {
  // t = 2 * (q.xyz x v); result = v + q.w * t + q.xyz x t
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/** Rotate a vector by the inverse of a quaternion (world → local). */
export function rotateVecInverse(
  q: { x: number; y: number; z: number; w: number },
  v: Vec3,
): Vec3 {
  return rotateVec({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, v);
}

/** Velocity of a specific world-space point on a rigid body. */
export function pointVelocity(body: RAPIER.RigidBody, worldPoint: Vec3): Vec3 {
  const com = body.worldCom();
  const lin = body.linvel();
  const ang = body.angvel();
  const r = sub(worldPoint, com as Vec3);
  const rot = cross(ang as Vec3, r);
  return { x: lin.x + rot.x, y: lin.y + rot.y, z: lin.z + rot.z };
}
