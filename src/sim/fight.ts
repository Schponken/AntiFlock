/**
 * The fight: two robots, an arena, a clock, and the bookkeeping that turns
 * physics contacts into damage.
 *
 * This is where the physics layer meets the damage model. The important
 * decision here is how energy is measured, and it is different for each kind of
 * impact:
 *
 *  - A spinner hit uses the rotor's own kinetic-energy loss over the step. The
 *    solver already slowed the rotor down by exactly the amount of energy it
 *    put into the target, so this is a measurement rather than an estimate.
 *  - A ram uses the reduced-mass kinetic energy of the closing velocity, which
 *    is the standard result for an inelastic collision between two free bodies.
 *  - Hazards deliver a known energy: a rate per second for the killsaws, a
 *    fixed figure per swing for the pulverisers.
 */

import { clamp01 } from '../core/math';
import { Rng } from '../core/rng';
import {
  PULVERISER_ENERGY,
  SAW_BITE_INTERVAL,
  SAW_ENERGY_RATE,
  START_POSITIONS,
  buildArena,
  firePulveriser,
  isUnderPulveriser,
  stepArena,
  type Arena,
} from './arena';
import { Bot, neutralControl, type BotControl } from './bot';
import { condition, type DamageResult, type Hit } from './damage';
import { judgeDecision, createScoreCard, type Decision, type ScoreCard } from './judging';
import { Match, type MatchEvent } from './match';
import type { BotDesign } from './parts';
import {
  Physics,
  dot,
  normalize,
  pointVelocity,
  sub,
  type ContactReport,
  type Vec3,
} from './physics';

/** Closing speed below which two robots touching is a shove, not a hit. */
const RAM_THRESHOLD_MPS = 1.6;
/** Seconds before the same pair of robots can register another ram. */
const RAM_COOLDOWN = 0.3;
/** Closing speed below which hitting a wall does nothing. */
const WALL_THRESHOLD_MPS = 3.0;
const WALL_COOLDOWN = 0.4;
/** Robots inside this distance are considered engaged, for scoring. */
const ENGAGEMENT_RANGE = 2.4;

export type FightEventKind =
  | 'weapon-hit'
  | 'ram'
  | 'wall-hit'
  | 'saw-hit'
  | 'pulveriser-hit'
  | 'weapon-clash'
  | 'penetration'
  | 'wheel-lost'
  | 'weapon-dead'
  | 'self-right';

/** Something worth a spark, a sound, or a camera cut. */
export interface FightEvent {
  kind: FightEventKind;
  /** Which robot took it. */
  side: 'a' | 'b';
  point: Vec3;
  /** Energy involved, joules. */
  energyJ: number;
  /** 0..1, how much of a shower of sparks this deserves. */
  intensity: number;
  damage?: DamageResult;
}

export interface FightOptions {
  redDesign: BotDesign;
  blueDesign: BotDesign;
  seed?: number;
  /** Enable the arena's automatic hazards. */
  hazards?: boolean;
}

export class Fight {
  readonly physics: Physics;
  readonly arena: Arena;
  readonly red: Bot;
  readonly blue: Bot;
  readonly match = new Match();
  readonly scores: { a: ScoreCard; b: ScoreCard } = {
    a: createScoreCard(),
    b: createScoreCard(),
  };
  decision: Decision | null = null;

  private readonly rng: Rng;
  private readonly cooldowns = new Map<string, number>();
  /** Events raised since the last drain. */
  private events: FightEvent[] = [];
  private matchEvents: MatchEvent[] = [];
  /** Weapon energy already spent this step, so one rotor cannot hit twice. */
  private weaponSpent = { a: false, b: false };

  constructor(physics: Physics, options: FightOptions) {
    this.physics = physics;
    this.rng = new Rng(options.seed ?? 0xba7713);
    this.arena = buildArena(physics);
    this.arena.active = options.hazards ?? true;

    this.red = new Bot(physics, 'red', 'a', options.redDesign, START_POSITIONS.red, 0);
    this.blue = new Bot(physics, 'blue', 'b', options.blueDesign, START_POSITIONS.blue, Math.PI);
  }

  botFor(side: 'a' | 'b'): Bot {
    return side === 'a' ? this.red : this.blue;
  }

  /** Begin the broadcast opening. */
  start(): void {
    this.match.start();
  }

  setControl(side: 'a' | 'b', control: BotControl): void {
    this.botFor(side).control = control;
  }

  /** Advance one rendered frame. */
  update(frameTime: number): void {
    const live = this.match.live;

    this.physics.advance({
      frameTime,
      preStep: (dt) => {
        // Robots are held in their squares until the light goes green.
        if (!live) {
          this.red.control = neutralControl();
          this.blue.control = neutralControl();
        }
        this.red.preStep(dt, live);
        this.blue.preStep(dt, live);
        stepArena(this.arena, dt);
        this.decayCooldowns(dt);
        this.weaponSpent.a = false;
        this.weaponSpent.b = false;
      },
      postStep: (dt, contacts) => {
        // The rotor energy measurement has to be taken every step, whether or
        // not anything was touching.
        this.red.postStep();
        this.blue.postStep();
        if (contacts.length > 0) this.resolveContacts(contacts);
        if (live) {
          this.applyPulverisers(dt);
          this.accumulateScores(dt);
        }
      },
    });

    const events = this.match.tick(frameTime, this.tickInput('a'), this.tickInput('b'));
    if (events.length > 0) this.matchEvents.push(...events);

    // When the clock runs out, go to the judges immediately.
    if (this.match.phase === 'decision' && !this.decision) {
      this.decision = judgeDecision(this.scores.a, this.scores.b, this.rng.int(1, 1 << 20));
      this.match.concludeByDecision(this.decision.winner);
      this.matchEvents.push(...this.match.tick(0, this.tickInput('a'), this.tickInput('b')));
    }
  }

  /** Take the fight events raised since the last call. */
  drainEvents(): FightEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  /** Take the match events raised since the last call. */
  drainMatchEvents(): MatchEvent[] {
    const out = this.matchEvents;
    this.matchEvents = [];
    return out;
  }

  /** Overall condition of a robot, 0..1, for the HUD. */
  conditionOf(side: 'a' | 'b'): number {
    return condition(this.botFor(side).health);
  }

  private tickInput(side: 'a' | 'b') {
    const bot = this.botFor(side);
    return {
      immobilised: bot.immobilised,
      speed: bot.speed,
      yawRate: bot.body.angvel().y,
      destroyed: bot.destroyed,
    };
  }

  // -------------------------------------------------------------------------
  // Contact resolution
  // -------------------------------------------------------------------------

  private resolveContacts(contacts: ContactReport[]): void {
    // A spinner can touch several colliders in one step. Attribute its energy
    // loss to the single hardest contact so it is never counted twice.
    let bestWeaponContact: { report: ContactReport; attacker: 'a' | 'b' } | null = null;
    let bestWeaponForce = 0;

    for (const contact of contacts) {
      const { a, b } = contact;

      const aBot = a.botId ? this.botById(a.botId) : null;
      const bBot = b.botId ? this.botById(b.botId) : null;

      // --- Weapon into the other robot ---------------------------------------
      if (a.kind === 'weapon' && bBot && aBot && aBot !== bBot) {
        if (contact.forceMag > bestWeaponForce) {
          bestWeaponForce = contact.forceMag;
          bestWeaponContact = { report: contact, attacker: aBot.side };
        }
        continue;
      }
      if (b.kind === 'weapon' && aBot && bBot && aBot !== bBot) {
        if (contact.forceMag > bestWeaponForce) {
          bestWeaponForce = contact.forceMag;
          bestWeaponContact = { report: contact, attacker: bBot.side };
        }
        continue;
      }

      // --- Robot into robot ---------------------------------------------------
      if (aBot && bBot && aBot !== bBot) {
        this.resolveRam(aBot, bBot, contact);
        continue;
      }

      // --- Killsaws -----------------------------------------------------------
      if (a.kind === 'saw' && bBot) this.resolveSaw(bBot, contact);
      else if (b.kind === 'saw' && aBot) this.resolveSaw(aBot, contact);
      // --- Walls and floor ----------------------------------------------------
      else if ((a.kind === 'wall' || a.kind === 'ceiling') && bBot) this.resolveWall(bBot, contact);
      else if ((b.kind === 'wall' || b.kind === 'ceiling') && aBot) this.resolveWall(aBot, contact);
    }

    if (bestWeaponContact) {
      this.resolveWeaponHit(bestWeaponContact.report, bestWeaponContact.attacker);
    }
  }

  private botById(id: string): Bot | null {
    if (id === this.red.id) return this.red;
    if (id === this.blue.id) return this.blue;
    return null;
  }

  private resolveWeaponHit(contact: ContactReport, attackerSide: 'a' | 'b'): void {
    if (this.weaponSpent[attackerSide]) return;

    const attacker = this.botFor(attackerSide);
    const defenderSide = attackerSide === 'a' ? 'b' : 'a';
    const defender = this.botFor(defenderSide);

    // The rotor's energy loss this step is exactly what it put into the target.
    const energyJ = attacker.weaponEnergyLostJ;
    if (energyJ <= 0) return;
    this.weaponSpent[attackerSide] = true;

    const targetPart = contact.a.kind === 'weapon' ? contact.b : contact.a;

    // Squareness: how aligned the rotor's tip velocity is with the contact
    // normal. A bar sliding along a wedge transfers almost nothing.
    const squareness = this.squarenessAt(attacker, defender, contact);

    const isWeaponClash = targetPart.kind === 'weapon';
    const onWheel = targetPart.kind === 'wheel';

    const hit: Hit = {
      energyJ,
      zone: defender.zoneAt(contact.point),
      squareness,
      bite: attacker.stats.weapon.biteFactor,
      onWheel,
      wheelIndex: onWheel ? targetPart.index : undefined,
      onWeapon: isWeaponClash,
    };

    const damage = defender.takeHit(hit, this.rng);

    this.scores[attackerSide].damageDealtJ += damage.effectiveEnergyJ;
    this.scores[attackerSide].hpDealt += damage.hpLost;
    this.scores[attackerSide].hitsLanded += 1;

    // A weapon clash chews up the attacker's rotor too.
    if (isWeaponClash) {
      const backHit: Hit = {
        energyJ: energyJ * 0.45,
        zone: 'front',
        squareness,
        bite: defender.stats.weapon.biteFactor,
        onWeapon: true,
      };
      attacker.takeHit(backHit, this.rng);
    }

    this.raise({
      kind: isWeaponClash ? 'weapon-clash' : 'weapon-hit',
      side: defenderSide,
      point: contact.point,
      energyJ,
      intensity: clamp01(damage.sparkIntensity + (isWeaponClash ? 0.35 : 0)) *
        (0.35 + 0.65 * defender.stats.armor.sparkiness),
      damage,
    });

    this.raiseFollowUps(defenderSide, contact.point, damage);
  }

  private resolveRam(a: Bot, b: Bot, contact: ContactReport): void {
    const key = `ram:${a.id}:${b.id}`;
    if ((this.cooldowns.get(key) ?? 0) > 0) return;

    const va = pointVelocity(a.body, contact.point);
    const vb = pointVelocity(b.body, contact.point);
    const relative = sub(va, vb);
    const normal = normalize(contact.normal);
    const closing = Math.abs(dot(relative, normal));

    if (closing < RAM_THRESHOLD_MPS) {
      // Not a hit, but sustained shoving is worth control points.
      const pusher = dot(a.forwardVector, normalize(sub(b.position, a.position))) > 0.5 ? a : b;
      const pushed = pusher === a ? b : a;
      this.scores[pusher.side].controlTime += 1 / 240;
      this.scores[pushed.side].timeControlled += 1 / 240;
      return;
    }

    this.cooldowns.set(key, RAM_COOLDOWN);

    // Reduced mass gives the energy actually available in the collision.
    const ma = a.body.mass();
    const mb = b.body.mass();
    const reduced = (ma * mb) / Math.max(ma + mb, 1e-6);
    const energyJ = 0.5 * reduced * closing * closing;

    // Whoever was driving into the other one is the aggressor.
    const aDrivingIn = dot(a.forwardVector, normalize(sub(b.position, a.position)));
    const bDrivingIn = dot(b.forwardVector, normalize(sub(a.position, b.position)));
    const attacker = aDrivingIn >= bDrivingIn ? a : b;
    const defender = attacker === a ? b : a;

    // A wedge that gets underneath transfers very little damage but wins the
    // exchange positionally.
    const squareness = clamp01(Math.abs(dot(normal, normalize(relative))));

    for (const [target, share] of [
      [defender, 0.65],
      [attacker, 0.35],
    ] as const) {
      const hit: Hit = {
        energyJ: energyJ * share,
        zone: target.zoneAt(contact.point),
        squareness,
        bite: 0.55, // bare armour on bare armour has no teeth
      };
      const damage = target.takeHit(hit, this.rng);
      if (target === defender) {
        this.scores[attacker.side].damageDealtJ += damage.effectiveEnergyJ;
        this.scores[attacker.side].hpDealt += damage.hpLost;
        this.scores[attacker.side].hitsLanded += 1;
      }
      this.raiseFollowUps(target.side, contact.point, damage);
    }

    this.raise({
      kind: 'ram',
      side: defender.side,
      point: contact.point,
      energyJ,
      intensity: clamp01(energyJ / 2500) * 0.6,
    });
  }

  private resolveWall(bot: Bot, contact: ContactReport): void {
    const key = `wall:${bot.id}`;
    if ((this.cooldowns.get(key) ?? 0) > 0) return;

    const v = pointVelocity(bot.body, contact.point);
    const normal = normalize(contact.normal);
    const closing = Math.abs(dot(v, normal));
    if (closing < WALL_THRESHOLD_MPS) return;

    this.cooldowns.set(key, WALL_COOLDOWN);

    // Only a fraction of the robot's energy goes into the wall impact.
    const energyJ = 0.5 * bot.body.mass() * closing * closing * 0.25;
    const damage = bot.takeHit(
      {
        energyJ,
        zone: bot.zoneAt(contact.point),
        squareness: clamp01(Math.abs(dot(normal, normalize(v)))),
        bite: 0.4,
      },
      this.rng,
    );

    this.raise({
      kind: 'wall-hit',
      side: bot.side,
      point: contact.point,
      energyJ,
      intensity: clamp01(energyJ / 3000) * 0.5,
      damage,
    });
    this.raiseFollowUps(bot.side, contact.point, damage);
  }

  private resolveSaw(bot: Bot, contact: ContactReport): void {
    const key = `saw:${bot.id}`;
    if ((this.cooldowns.get(key) ?? 0) > 0) return;
    this.cooldowns.set(key, SAW_BITE_INTERVAL);

    const energyJ = SAW_ENERGY_RATE * SAW_BITE_INTERVAL;
    const damage = bot.takeHit(
      {
        energyJ,
        zone: bot.zoneAt(contact.point),
        squareness: 0.85,
        bite: 0.9,
      },
      this.rng,
    );

    // The other robot gets control credit for putting them there.
    const other = bot.side === 'a' ? 'b' : 'a';
    this.scores[other].hazardDeliveries += SAW_BITE_INTERVAL * 0.5;

    this.raise({
      kind: 'saw-hit',
      side: bot.side,
      point: contact.point,
      energyJ,
      intensity: 0.55 * (0.4 + 0.6 * bot.stats.armor.sparkiness),
      damage,
    });
    this.raiseFollowUps(bot.side, contact.point, damage);
  }

  private applyPulverisers(dt: number): void {
    for (const pulveriser of this.arena.pulverisers) {
      // Fire automatically when a robot drives underneath.
      if (!pulveriser.firing && pulveriser.cooldown <= 0) {
        for (const bot of [this.red, this.blue]) {
          if (isUnderPulveriser(pulveriser, bot.position)) {
            firePulveriser(pulveriser);
            break;
          }
        }
      }

      if (!pulveriser.justStruck) continue;

      for (const bot of [this.red, this.blue]) {
        if (!isUnderPulveriser(pulveriser, bot.position)) continue;

        const point: Vec3 = {
          x: bot.position.x,
          y: bot.position.y + bot.hullCenterY,
          z: bot.position.z,
        };
        const damage = bot.takeHit(
          { energyJ: PULVERISER_ENERGY, zone: 'top', squareness: 0.95, bite: 1.1 },
          this.rng,
        );
        // Drive the robot into the floor.
        bot.body.applyImpulseAtPoint({ x: 0, y: -bot.body.mass() * 3.2, z: 0 }, point, true);

        const other = bot.side === 'a' ? 'b' : 'a';
        this.scores[other].hazardDeliveries += 1;

        this.raise({
          kind: 'pulveriser-hit',
          side: bot.side,
          point,
          energyJ: PULVERISER_ENERGY,
          intensity: 0.8 * (0.4 + 0.6 * bot.stats.armor.sparkiness),
          damage,
        });
        this.raiseFollowUps(bot.side, point, damage);
      }
    }
    void dt;
  }

  // -------------------------------------------------------------------------
  // Scoring
  // -------------------------------------------------------------------------

  private accumulateScores(dt: number): void {
    const gap = sub(this.blue.position, this.red.position);
    const distance = Math.hypot(gap.x, gap.z);
    if (distance > ENGAGEMENT_RANGE) return;

    for (const bot of [this.red, this.blue]) {
      const other = bot === this.red ? this.blue : this.red;
      const toOther = normalize(sub(other.position, bot.position));
      const facing = dot(bot.forwardVector, toOther);
      const closing = dot(bot.body.linvel() as Vec3, toOther);
      // Aggression is pointing at them and going forwards.
      if (facing > 0.55 && closing > 0.4) {
        this.scores[bot.side].aggressionTime += dt;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private squarenessAt(attacker: Bot, defender: Bot, contact: ContactReport): number {
    void defender;
    const tipVelocity = attacker.weaponBody
      ? pointVelocity(attacker.weaponBody, contact.point)
      : pointVelocity(attacker.body, contact.point);
    const dir = normalize(tipVelocity);
    const normal = normalize(contact.normal);
    return clamp01(Math.abs(dot(dir, normal)));
  }

  private raiseFollowUps(side: 'a' | 'b', point: Vec3, damage: DamageResult): void {
    if (damage.penetrated) {
      this.raise({ kind: 'penetration', side, point, energyJ: 0, intensity: 0.9, damage });
    }
    if (damage.wheelLost) {
      this.raise({ kind: 'wheel-lost', side, point, energyJ: 0, intensity: 0.7, damage });
    }
    if (damage.weaponKilled) {
      this.raise({ kind: 'weapon-dead', side, point, energyJ: 0, intensity: 0.8, damage });
    }
  }

  private raise(event: FightEvent): void {
    // Keep the queue bounded: a grinding saw can generate hundreds a second and
    // the renderer only needs the loudest of them.
    if (this.events.length > 96) return;
    this.events.push(event);
  }

  private decayCooldowns(dt: number): void {
    for (const [key, value] of this.cooldowns) {
      const next = value - dt;
      if (next <= 0) this.cooldowns.delete(key);
      else this.cooldowns.set(key, next);
    }
  }
}
