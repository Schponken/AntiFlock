/**
 * The opponent driver.
 *
 * This is written as a driver, not as a pathfinder. It has the same controls a
 * human has — two sticks and a weapon trigger — and it makes the decisions a
 * driver makes: get the weapon up to speed before committing, line the wedge up
 * before charging, back off and re-approach after a big hit, keep off the
 * killsaws, and if it is upside down, do something about it.
 *
 * Difficulty changes reaction time and how well it aims, not how much grip or
 * power its robot has. The robot is always exactly what its design says it is.
 */

import { clamp, clamp01, damp } from '../core/math';
import { Rng } from '../core/rng';
import { SAW_BANKS, ARENA_HALF } from '../sim/arena';
import type { Bot, BotControl } from '../sim/bot';
import { dot, normalize, sub, type Vec3 } from '../sim/physics';

export type Difficulty = 'rookie' | 'veteran' | 'champion';

interface Profile {
  /** Seconds of lag before it reacts to a change. */
  reaction: number;
  /** How accurately it aims, 0..1. */
  aim: number;
  /** How much spin-up it insists on before charging, 0..1. */
  patience: number;
  /** How likely it is to back off and reset after a hit. */
  discipline: number;
  /** Random steering jitter, in control units. */
  wobble: number;
}

const PROFILES: Record<Difficulty, Profile> = {
  rookie: { reaction: 0.42, aim: 0.55, patience: 0.35, discipline: 0.25, wobble: 0.22 },
  veteran: { reaction: 0.22, aim: 0.8, patience: 0.7, discipline: 0.6, wobble: 0.1 },
  champion: { reaction: 0.1, aim: 0.95, patience: 0.88, discipline: 0.85, wobble: 0.04 },
};

type Tactic = 'spin-up' | 'engage' | 'reposition' | 'recover' | 'evade';

export class OpponentDriver {
  private rng: Rng;
  private profile: Profile;
  private tactic: Tactic = 'spin-up';
  private tacticTime = 0;
  /** Lagged copy of the target's position, so it cannot react instantly. */
  private believedTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private steerSmoothed = 0;
  private throttleSmoothed = 0;
  private fireCooldown = 0;

  constructor(
    public difficulty: Difficulty = 'veteran',
    seed = 0xa1b2,
  ) {
    this.rng = new Rng(seed);
    this.profile = PROFILES[difficulty];
  }

  setDifficulty(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    this.profile = PROFILES[difficulty];
  }

  /** Decide this frame's controls. */
  drive(self: Bot, target: Bot, dt: number, live: boolean): BotControl {
    if (!live) {
      return { throttle: 0, steer: 0, weapon: 0, fire: false, selfRight: false };
    }

    this.tacticTime += dt;
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // Perception lag: it steers at where it thinks the target is.
    const actual = target.position;
    const lag = Math.max(this.profile.reaction, 1e-3);
    this.believedTarget.x = damp(this.believedTarget.x, actual.x, lag, dt);
    this.believedTarget.y = damp(this.believedTarget.y, actual.y, lag, dt);
    this.believedTarget.z = damp(this.believedTarget.z, actual.z, lag, dt);

    const toTarget = sub(this.believedTarget, self.position);
    const distance = Math.hypot(toTarget.x, toTarget.z);
    const heading = normalize({ x: toTarget.x, y: 0, z: toTarget.z });

    this.chooseTactic(self, target, distance);

    let throttle = 0;
    let steer = 0;
    let weapon = 0;
    let fire = false;
    let selfRight = false;

    const forward = self.forwardVector;
    // An invertible robot driving upside down has mirrored steering, exactly as
    // it does for the player, so the AI has to flip its stick too.
    const flipped = self.isUpsideDown && self.stats.invertible;

    // Signed bearing to the target: positive means it is to our right.
    const right = { x: -forward.z, y: 0, z: forward.x };
    const facing = dot(forward, heading);
    const bearing = dot(right, heading);

    switch (this.tactic) {
      case 'spin-up': {
        weapon = 1;
        // Circle at a distance while the rotor comes up, keeping the weapon
        // pointed roughly at the other robot.
        steer = clamp(bearing * 1.6, -1, 1) * 0.65 + 0.35;
        throttle = 0.35;
        break;
      }

      case 'engage': {
        weapon = 1;
        // Turn to face, then drive through them.
        steer = clamp(bearing * 2.6, -1, 1);
        // Only commit the throttle once roughly lined up, so it does not
        // present a flank on the way in.
        const alignment = clamp01((facing - 0.25) / 0.75);
        throttle = 0.35 + alignment * 0.65;

        if (self.stats.weapon.burstJ > 0 && distance < 1.5 && facing > 0.75 && self.burstReady) {
          if (this.fireCooldown <= 0) {
            fire = true;
            this.fireCooldown = 0.4;
          }
        }
        break;
      }

      case 'reposition': {
        weapon = 1;
        // Back off, turn around, come again.
        throttle = -0.7;
        steer = clamp(-bearing * 1.4, -1, 1);
        break;
      }

      case 'recover': {
        // Upside down: try the self-righter, and rock back and forth.
        selfRight = true;
        weapon = self.stats.weapon.kind === 'flipper' || self.stats.weapon.kind === 'hammer' ? 1 : 0;
        if (self.burstReady && this.fireCooldown <= 0) {
          fire = true;
          this.fireCooldown = 0.6;
        }
        throttle = Math.sin(this.tacticTime * 6) > 0 ? 1 : -1;
        steer = Math.sin(this.tacticTime * 2.4);
        break;
      }

      case 'evade': {
        weapon = 1;
        // Get away from whatever is dangerous, usually a live killsaw.
        const escape = this.escapeVector(self);
        const escapeBearing = dot(right, escape);
        const escapeFacing = dot(forward, escape);
        steer = clamp(escapeBearing * 2.4, -1, 1);
        throttle = escapeFacing > 0 ? 1 : -0.9;
        break;
      }
    }

    if (flipped) steer = -steer;

    // A driver's hands are never perfectly steady.
    steer += this.rng.spread(this.profile.wobble);
    // Aim quality degrades the steering toward the ideal.
    steer *= 0.45 + 0.55 * this.profile.aim;

    // Smooth the sticks so the robot does not twitch.
    this.steerSmoothed = damp(this.steerSmoothed, clamp(steer, -1, 1), 0.07, dt);
    this.throttleSmoothed = damp(this.throttleSmoothed, clamp(throttle, -1, 1), 0.09, dt);

    return {
      throttle: this.throttleSmoothed,
      steer: this.steerSmoothed,
      weapon,
      fire,
      selfRight,
    };
  }

  private chooseTactic(self: Bot, target: Bot, distance: number): void {
    const previous = this.tactic;

    // Upside down and unable to drive inverted: nothing else matters. Note this
    // checks whether it can *drive* inverted, not whether it can right itself —
    // a robot with a self-righting arm still has to use it.
    if (self.isUpsideDown && !self.stats.invertible) {
      this.tactic = 'recover';
    } else if (this.nearLiveSaw(self)) {
      this.tactic = 'evade';
    } else if (self.stats.weapon.rpm > 0 && self.weaponSpinFraction < this.profile.patience && distance > 2) {
      // Keep the distance while the bar comes up to speed.
      this.tactic = 'spin-up';
    } else if (
      previous === 'engage' &&
      this.tacticTime > 1.4 &&
      distance < 1.2 &&
      this.rng.chance(this.profile.discipline * 0.03)
    ) {
      // Disengage occasionally rather than grinding nose to nose.
      this.tactic = 'reposition';
    } else if (previous === 'reposition' && (this.tacticTime > 1.1 || distance > 4)) {
      this.tactic = 'engage';
    } else if (previous !== 'reposition') {
      this.tactic = 'engage';
    }

    // Do not chase a robot that has already been counted out.
    if (target.destroyed) this.tactic = 'reposition';

    if (this.tactic !== previous) this.tacticTime = 0;
  }

  /** Is a killsaw up and close enough to matter? */
  private nearLiveSaw(self: Bot): boolean {
    const p = self.position;
    for (const bank of SAW_BANKS) {
      const dx = p.x - bank.x;
      const dz = p.z - bank.z;
      if (dx * dx + dz * dz < 1.6 * 1.6) return true;
    }
    return false;
  }

  /** Direction to run in when something is dangerous. */
  private escapeVector(self: Bot): Vec3 {
    const p = self.position;
    // Head for the middle of the nearest clear quadrant, staying off the walls.
    let x = -p.x;
    let z = -p.z;
    for (const bank of SAW_BANKS) {
      const dx = p.x - bank.x;
      const dz = p.z - bank.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 9) {
        const inv = 1 / Math.max(Math.sqrt(d2), 0.2);
        x += dx * inv * 3;
        z += dz * inv * 3;
      }
    }
    // Keep away from the walls too.
    const margin = ARENA_HALF - 1.5;
    if (Math.abs(p.x) > margin) x -= Math.sign(p.x) * 2;
    if (Math.abs(p.z) > margin) z -= Math.sign(p.z) * 2;
    return normalize({ x, y: 0, z });
  }

  /** What the AI is currently doing, for the debug overlay. */
  get currentTactic(): string {
    return this.tactic;
  }

  reset(): void {
    this.tactic = 'spin-up';
    this.tacticTime = 0;
    this.steerSmoothed = 0;
    this.throttleSmoothed = 0;
    this.fireCooldown = 0;
  }
}
