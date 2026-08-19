import RAPIER from '@dimforge/rapier3d-compat';
import { Emitter } from '../core/emitter.ts';

/**
 * Simulation rate.
 *
 * This is not a taste decision. Rapier hard-clamps a rigid body's angular
 * velocity to a quarter turn per step — `(PI/4) / dt` — to keep its rotation
 * integrator well behaved. At 240 Hz that ceiling is 188 rad/s, which is slower
 * than any real heavyweight spinner and would quietly cap every weapon in the
 * game at half speed. 480 Hz raises the ceiling to 377 rad/s, which covers the
 * whole weapon catalogue with headroom to spare.
 */
export const FIXED_DT = 1 / 480;

/** The engine's angular velocity ceiling at the current timestep, rad/s. */
export const MAX_SIMULABLE_OMEGA = Math.PI / 4 / FIXED_DT;

/**
 * Never simulate more than this many steps in one frame — a slow frame must not
 * spiral into an ever-growing backlog. At 480 Hz, 24 steps covers a full frame's
 * worth of simulation down to 20 fps before the world starts falling behind.
 */
const MAX_STEPS_PER_FRAME = 24;

export interface ContactImpact {
  colliderA: number;
  colliderB: number;
  /** Sum of contact-force magnitudes reported by Rapier, in newtons. */
  forceMagnitude: number;
  /** Impulse over the step, N·s. */
  impulse: number;
  /** World-space direction of the strongest contact force. */
  nx: number;
  ny: number;
  nz: number;
}

export interface CollisionPair {
  colliderA: number;
  colliderB: number;
  started: boolean;
}

export interface PhysicsEvents {
  /** Emitted once per fixed step, before the step is integrated. */
  preStep: { dt: number };
  /** Emitted once per fixed step, after integration, with that step's events. */
  postStep: { dt: number };
  contact: ContactImpact;
  collision: CollisionPair;
}

let rapierReady: Promise<void> | null = null;

/** Rapier compiles its WASM once per process; every world awaits the same promise. */
export function initRapier(): Promise<void> {
  if (!rapierReady) rapierReady = RAPIER.init();
  return rapierReady;
}

/**
 * Thin wrapper over a Rapier world that owns the fixed-timestep accumulator and
 * turns Rapier's event queue into typed events the game systems subscribe to.
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly events = new Emitter<PhysicsEvents>();

  private queue: RAPIER.EventQueue;
  private accumulator = 0;
  /** Fraction of a fixed step already consumed — used to interpolate the render pose. */
  private _alpha = 0;
  private _stepCount = 0;
  private _simTime = 0;

  constructor(gravity = { x: 0, y: -9.81, z: 0 }) {
    this.world = new RAPIER.World(gravity);
    this.world.integrationParameters.dt = FIXED_DT;
    // Robot combat is a pile of stacked constraints hit by very fast bodies; a
    // richer solver budget is what keeps a spinner from tunnelling or exploding.
    this.world.integrationParameters.numSolverIterations = 8;
    this.world.integrationParameters.numInternalPgsIterations = 2;
    this.world.integrationParameters.maxCcdSubsteps = 4;
    this.queue = new RAPIER.EventQueue(true);
  }

  get alpha(): number {
    return this._alpha;
  }

  get stepCount(): number {
    return this._stepCount;
  }

  /** Seconds of simulated time since the world was created. */
  get simTime(): number {
    return this._simTime;
  }

  /**
   * Advance the world by `frameDt` seconds of wall time using fixed steps.
   * Returns the number of steps actually simulated.
   */
  update(frameDt: number): number {
    // Clamp pathological frames (tab restored from background, breakpoint hit).
    this.accumulator += Math.min(frameDt, MAX_STEPS_PER_FRAME * FIXED_DT);
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
      this.step();
      this.accumulator -= FIXED_DT;
      steps++;
    }
    this._alpha = this.accumulator / FIXED_DT;
    return steps;
  }

  /** Run exactly one fixed step. Exposed for deterministic tests. */
  step(): void {
    this.events.emit('preStep', { dt: FIXED_DT });
    this.world.step(this.queue);
    this._stepCount++;
    this._simTime += FIXED_DT;
    this.drainEvents();
    this.events.emit('postStep', { dt: FIXED_DT });
  }

  private drainEvents(): void {
    this.queue.drainCollisionEvents((colliderA, colliderB, started) => {
      this.events.emit('collision', { colliderA, colliderB, started });
    });

    this.queue.drainContactForceEvents((event) => {
      const dir = event.maxForceDirection();
      const force = event.totalForceMagnitude();
      this.events.emit('contact', {
        colliderA: event.collider1(),
        colliderB: event.collider2(),
        forceMagnitude: force,
        impulse: force * FIXED_DT,
        nx: dir.x,
        ny: dir.y,
        nz: dir.z,
      });
    });
  }

  /** Reset the accumulator, e.g. after a long pause in the pit or on the menu. */
  resetClock(): void {
    this.accumulator = 0;
    this._alpha = 0;
  }

  free(): void {
    this.events.clear();
    this.queue.free();
    this.world.free();
  }
}

export { RAPIER };
