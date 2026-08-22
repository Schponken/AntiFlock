/**
 * The opponent driver.
 *
 * This is written as a driver, not as a chase function. It has a reaction time,
 * it aims imperfectly, and it plays its machine to that machine's strengths: a
 * spinner keeps its weapon pointed at you and charges in straight lines, a wedge
 * bot works the angles and drives you into the wall, a flipper closes and waits
 * for the shot. It also knows when it is losing and backs off to regroup.
 */

import * as THREE from 'three';
import { clamp, clamp01, wrapAngle } from '../core/mathx.ts';
import { Rng } from '../core/rng.ts';
import type { Bot, BotInput } from './bot.ts';
import type { Arena } from './arena.ts';
import { ARENA_HALF } from './arena.ts';

export type Difficulty = 'rookie' | 'veteran' | 'champion';

interface DifficultyProfile {
  /** Seconds between decisions. */
  reaction: number;
  /** Radians of aiming error. */
  aimError: number;
  /** 0-1 willingness to charge into a spun-up weapon. */
  aggression: number;
  /** 0-1 chance of noticing an active hazard in time. */
  awareness: number;
  /** Throttle scaling — a rookie does not use all of the machine. */
  commitment: number;
}

const PROFILES: Record<Difficulty, DifficultyProfile> = {
  rookie: { reaction: 0.34, aimError: 0.42, aggression: 0.45, awareness: 0.35, commitment: 0.72 },
  veteran: { reaction: 0.18, aimError: 0.2, aggression: 0.72, awareness: 0.7, commitment: 0.9 },
  champion: { reaction: 0.09, aimError: 0.08, aggression: 0.92, awareness: 0.95, commitment: 1 },
};

type AiState = 'spinup' | 'engage' | 'reposition' | 'recover' | 'evade';

export class BotAI {
  private bot: Bot;
  private arena: Arena;
  private profile: DifficultyProfile;
  private rng: Rng;

  private state: AiState = 'spinup';
  private timer = 0;
  private stateTime = 0;
  private aimBias = 0;
  private output: BotInput = {
    throttle: 0,
    steer: 0,
    weapon: false,
    fire: false,
    selfRight: false,
  };
  private fireLatch = false;
  private stuckTimer = 0;
  private lastPosition = new THREE.Vector3();
  private reverseUntil = 0;
  private elapsed = 0;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(bot: Bot, arena: Arena, difficulty: Difficulty = 'veteran', seed = 12345) {
    this.bot = bot;
    this.arena = arena;
    this.profile = PROFILES[difficulty];
    this.rng = new Rng(seed);
    bot.position(this.lastPosition);
  }

  /** Called once per rendered frame; the driver only re-decides on its own clock. */
  update(dt: number, opponent: Bot | null): BotInput {
    this.elapsed += dt;
    this.timer -= dt;
    this.stateTime += dt;

    // Fire is a rising edge, so it must be cleared every frame after being read.
    this.output.fire = false;
    if (this.fireLatch) {
      this.output.fire = true;
      this.fireLatch = false;
    }

    this.trackStuck(dt);

    if (this.timer <= 0) {
      this.timer = this.profile.reaction;
      this.aimBias = this.rng.spread(this.profile.aimError);
      this.decide(opponent);
    }

    this.drive(opponent);
    return this.output;
  }

  private setState(state: AiState): void {
    if (this.state === state) return;
    this.state = state;
    this.stateTime = 0;
  }

  /** Notice when we have been shoved into a wall and are going nowhere. */
  private trackStuck(dt: number): void {
    const position = this.bot.position(this.tmpA);
    const moved = position.distanceTo(this.lastPosition);
    this.lastPosition.copy(position);

    const wantsToMove = Math.abs(this.output.throttle) > 0.3;
    if (wantsToMove && moved < 0.006) this.stuckTimer += dt;
    else this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);

    if (this.stuckTimer > 0.7) {
      this.reverseUntil = this.elapsed + 0.9;
      this.stuckTimer = 0;
    }
  }

  private decide(opponent: Bot | null): void {
    const bot = this.bot;

    // Nothing matters more than being the right way up.
    if (bot.inverted && !bot.stats.invertible) {
      this.setState('recover');
      return;
    }

    if (!opponent) {
      this.setState('spinup');
      return;
    }

    const distance = bot.position(this.tmpA).distanceTo(opponent.position(this.tmpB));
    const weapon = bot.stats.parts.weapon;
    const wantsCharge = weapon.rotor !== undefined;

    // A spinner that has not wound up is a brick. Back off and get to speed.
    if (wantsCharge && bot.weaponCharge < 0.55 && bot.damage.weaponCondition > 0.2) {
      this.setState(distance < 3 ? 'reposition' : 'spinup');
      return;
    }

    // Badly hurt: play for the clock rather than trade hits.
    const condition = bot.damage.integrity * 0.6 + bot.damage.mobility * 0.4;
    if (condition < 0.32 && this.rng.next() > this.profile.aggression) {
      this.setState('reposition');
      return;
    }

    // Stay out of a live hazard unless we are too committed to care.
    if (this.arena.killsawsUp && this.rng.next() < this.profile.awareness) {
      const overSaws = bot.position(this.tmpA).length() < 2.4;
      if (overSaws) {
        this.setState('evade');
        return;
      }
    }

    this.setState('engage');
  }

  private drive(opponent: Bot | null): void {
    const bot = this.bot;
    const weapon = bot.stats.parts.weapon;

    this.output.weapon = weapon.kind !== 'wedge';
    this.output.selfRight = false;

    if (this.elapsed < this.reverseUntil) {
      // Backing out of a wall: reverse and swing the nose away.
      this.output.throttle = -this.profile.commitment;
      this.output.steer = this.stuckTimer > 0 ? 0.6 : 0.4;
      return;
    }

    switch (this.state) {
      case 'recover': {
        this.output.throttle = 0;
        this.output.steer = 0;
        // Deploy the srimech, and rock the machine to help it over.
        this.output.selfRight = true;
        if (this.stateTime % 1.2 < 0.6) this.output.throttle = 0.8;
        else this.output.throttle = -0.8;
        return;
      }

      case 'spinup': {
        if (!opponent) {
          this.output.throttle = 0.2;
          this.output.steer = 0.35;
          return;
        }
        // Keep our weapon between us and them while the rotor winds up.
        const angle = this.angleToTarget(opponent.position(this.tmpB));
        this.output.steer = clamp(angle * 1.6, -1, 1);
        const distance = bot.position(this.tmpA).distanceTo(opponent.position(this.tmpB));
        this.output.throttle = distance < 4 ? -0.55 * this.profile.commitment : 0;
        return;
      }

      case 'evade': {
        // Drive away from the middle of the box, where the saws live.
        const away = bot.position(this.tmpA).normalize();
        const angle = this.angleToDirection(away);
        this.output.steer = clamp(angle * 1.5, -1, 1);
        this.output.throttle = this.profile.commitment;
        return;
      }

      case 'reposition': {
        if (!opponent) {
          this.output.throttle = 0.3;
          this.output.steer = 0.4;
          return;
        }
        // Circle at a respectful distance rather than fleeing in a straight line.
        const toSelf = bot.position(this.tmpA).sub(opponent.position(this.tmpB));
        const orbit = this.tmpB.set(-toSelf.z, 0, toSelf.x).normalize();
        const angle = this.angleToDirection(orbit);
        this.output.steer = clamp(angle * 1.4, -1, 1);
        this.output.throttle = 0.65 * this.profile.commitment;
        return;
      }

      case 'engage':
      default: {
        if (!opponent) {
          this.output.throttle = 0.25;
          this.output.steer = 0.3;
          return;
        }
        const target = opponent.position(this.tmpB);

        // Control bots try to put the opponent between themselves and the wall.
        if (weapon.kind === 'wedge' || weapon.kind === 'crusher') {
          const pushDirection = target.clone().normalize().multiplyScalar(ARENA_HALF);
          target.lerp(pushDirection, 0.25);
        }

        const angle = this.angleToTarget(target);
        const distance = bot.position(this.tmpA).distanceTo(opponent.position(new THREE.Vector3()));
        this.output.steer = clamp(angle * 1.8, -1, 1);

        // Only commit forward once roughly lined up, or a spinner just gets hit
        // in the side on the way in.
        const alignment = clamp01(1 - Math.abs(angle) / 0.9);
        this.output.throttle = clamp(
          (0.35 + alignment * 0.75) * this.profile.commitment,
          -1,
          1,
        );

        // Actuators fire when close and lined up.
        if ((weapon.actuator || weapon.clamp) && distance < 1.5 && Math.abs(angle) < 0.35) {
          if (weapon.clamp) this.output.weapon = true;
          else this.fireLatch = true;
        }
        return;
      }
    }
  }

  /** Signed steering error toward a world point, including this driver's aim wobble. */
  private angleToTarget(target: THREE.Vector3): number {
    const position = this.bot.position(new THREE.Vector3());
    const direction = target.clone().sub(position);
    direction.y = 0;
    if (direction.lengthSq() < 1e-6) return 0;
    return this.angleToDirection(direction.normalize());
  }

  private angleToDirection(direction: THREE.Vector3): number {
    const forward = this.bot.forward(new THREE.Vector3());
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) return 0;
    forward.normalize();

    /*
     * Turn a bearing into a steering command, with the sign the controls use.
     *
     * `atan2(x, z)` increases as the machine swings towards body +X — and with
     * forward at +Z and up at +Y, body +X is the machine's *left* (forward is
     * up x right, so right is -X). `BotInput.steer` is positive to the right, so
     * the bearing error has to be negated to become a steering command. It was
     * not, which cancelled out against a matching sign error in the drivetrain
     * and left the driver looking correct while both halves were wrong; with the
     * drivetrain fixed, the AI drove away from everything it aimed at.
     */
    const desired = Math.atan2(direction.x, direction.z);
    const current = Math.atan2(forward.x, forward.z);
    let error = -wrapAngle(desired - current) + this.aimBias;

    // Driving inverted means the controls are mirrored, and a real driver
    // takes a moment to remember that.
    if (this.bot.inverted && this.bot.stats.invertible) error = -error;
    return error;
  }

  get currentState(): AiState {
    return this.state;
  }
}
