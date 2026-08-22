/**
 * The fight itself: two machines, one box, and the bookkeeping that turns solver
 * contacts into damage, sparks, flying panels and knockouts.
 *
 * Two different contact channels are used, because a spinner hit and a shoving
 * match are genuinely different events:
 *
 * - Weapon strikes come from *collision start* events. Each new contact is one
 *   tooth finding a target, so it maps cleanly onto one discrete hit with an
 *   energy budget drawn from the rotor's real stored energy.
 * - Ramming, wall slams and floor landings come from *contact force* events,
 *   where the solver's own impulse tells us how hard the two things met.
 */

import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { Emitter } from '../core/emitter.ts';
import { clamp, clamp01 } from '../core/mathx.ts';
import { fxRng } from '../core/rng.ts';
import type { PhysicsWorld } from '../physics/world.ts';
import { Arena, START_SQUARES } from './arena.ts';
import { Bot, type PartRef } from './bot.ts';
import {
  MIN_DAMAGING_ENERGY,
  WEAPON_WEAR,
  type ArmorFace,
  type PartState,
} from './damage.ts';
import type { BotDesign } from './design.ts';
import { Debris } from './debris.ts';

export interface ImpactEvent {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** Joules transferred. */
  energy: number;
  /** 0-1 how big this felt. */
  severity: number;
  attacker: Bot | null;
  defender: Bot | null;
  partId: string;
  kind: 'weapon' | 'ram' | 'wall' | 'hazard';
}

export interface CombatEvents {
  impact: ImpactEvent;
  partDestroyed: { bot: Bot; part: PartState; position: THREE.Vector3 };
  knockout: { bot: Bot; reason: 'counted-out' | 'out-of-bounds' | 'destroyed' };
  hazardArmed: { kind: string };
}

/** Minimum gap between two damaging hits on the same attacker/defender pair. */
const HIT_COOLDOWN = 0.075;

/** Rammed contacts below this impulse are just shoving, not damage. */
const RAM_IMPULSE_THRESHOLD = 260;

export class Combat {
  readonly events = new Emitter<CombatEvents>();
  readonly arena: Arena;
  readonly bots: Bot[] = [];
  readonly debris: Debris;
  readonly group = new THREE.Group();

  private world: PhysicsWorld;
  private headless: boolean;
  /** collider handle -> owning part, across every bot. */
  private colliderIndex = new Map<number, PartRef>();
  private hitCooldowns = new Map<string, number>();
  private knockedOut = new Set<number>();
  private running = false;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(world: PhysicsWorld, options: { headless?: boolean } = {}) {
    this.world = world;
    this.headless = options.headless ?? false;
    this.arena = new Arena(world, { headless: this.headless });
    this.debris = new Debris(world, { headless: this.headless });
    if (!this.headless) {
      this.group.add(this.arena.group);
      this.group.add(this.debris.group);
    }

    world.events.on('preStep', ({ dt }) => {
      if (!this.running) return;
      this.arena.update(dt);
      for (const bot of this.bots) bot.preStep(dt);
    });

    world.events.on('postStep', ({ dt }) => {
      if (!this.running) return;
      for (const bot of this.bots) bot.postStep(dt);
      this.debris.update(dt);
      this.tickCooldowns(dt);
      this.checkKnockouts();
    });

    world.events.on('collision', (event) => {
      if (!this.running || !event.started) return;
      this.onCollisionStart(event.colliderA, event.colliderB);
    });

    world.events.on('contact', (event) => {
      if (!this.running) return;
      this.onContactForce(event.colliderA, event.colliderB, event.impulse, {
        x: event.nx,
        y: event.ny,
        z: event.nz,
      });
    });
  }

  // -------------------------------------------------------------------------

  addBot(design: BotDesign, team: 0 | 1): Bot {
    const square = START_SQUARES[team]!;
    const bot = new Bot({
      world: this.world,
      design,
      team,
      position: { x: square.x, y: 0, z: square.z },
      facing: square.facing,
      headless: this.headless,
    });
    this.bots.push(bot);
    for (const [handle, ref] of bot.colliderParts) this.colliderIndex.set(handle, ref);
    if (bot.visual) this.group.add(bot.visual.root);
    return bot;
  }

  opponentOf(bot: Bot): Bot | null {
    return this.bots.find((b) => b !== bot) ?? null;
  }

  /** Nothing moves and nothing takes damage until the fight is live. */
  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    for (const bot of this.bots) bot.disable();
  }

  get isRunning(): boolean {
    return this.running;
  }

  syncVisuals(dt: number): void {
    for (const bot of this.bots) bot.syncVisual(dt);
    this.debris.syncVisuals();
  }

  dispose(): void {
    for (const bot of this.bots) bot.dispose();
    this.bots.length = 0;
    this.debris.dispose();
    this.arena.dispose();
    this.colliderIndex.clear();
    this.events.clear();
  }

  // -------------------------------------------------------------------------
  // Contact handling
  // -------------------------------------------------------------------------

  private tickCooldowns(dt: number): void {
    for (const [key, value] of this.hitCooldowns) {
      const next = value - dt;
      if (next <= 0) this.hitCooldowns.delete(key);
      else this.hitCooldowns.set(key, next);
    }
  }

  private onCollisionStart(handleA: number, handleB: number): void {
    const refA = this.colliderIndex.get(handleA);
    const refB = this.colliderIndex.get(handleB);

    // Hazard versus machine.
    const hazardA = this.arena.hazardColliders.get(handleA);
    const hazardB = this.arena.hazardColliders.get(handleB);
    if (hazardA && refB) return this.applyHazard(hazardA.kind, hazardA.energy, refB, handleA, handleB);
    if (hazardB && refA) return this.applyHazard(hazardB.kind, hazardB.energy, refA, handleB, handleA);

    if (!refA || !refB) return;
    if (refA.bot === refB.bot) return;

    // Exactly one side must be a weapon for this to be a strike.
    if (refA.isWeapon === refB.isWeapon) return;
    const attackerRef = refA.isWeapon ? refA : refB;
    const defenderRef = refA.isWeapon ? refB : refA;
    const attackerHandle = refA.isWeapon ? handleA : handleB;
    const defenderHandle = refA.isWeapon ? handleB : handleA;

    this.applyWeaponStrike(attackerRef, defenderRef, attackerHandle, defenderHandle);
  }

  private applyWeaponStrike(
    attackerRef: PartRef,
    defenderRef: PartRef,
    attackerHandle: number,
    defenderHandle: number,
  ): void {
    const attacker = attackerRef.bot;
    const defender = defenderRef.bot;
    const key = `w:${attacker.id}:${defender.id}`;
    if (this.hitCooldowns.has(key)) return;

    const weapon = attacker.stats.parts.weapon;
    const contact = this.contactPoint(attackerHandle, defenderHandle);
    const point = contact.point;
    const normal = contact.normal;

    // What the weapon can deliver: the tooth's own speed plus the closing speed,
    // through the reduced mass of a rotor-versus-machine collision.
    const radius = weapon.rotor?.radius ?? weapon.actuator?.reach ?? 0.35;
    const tipSpeed = Math.abs(attacker.omega) * radius;
    const closing = this.closingSpeed(attacker, defender, normal);
    const relative = tipSpeed + Math.max(0, closing);

    const rotorEffectiveMass =
      weapon.rotor && radius > 0 ? attacker.weaponInertia / (radius * radius) : attacker.stats.weaponMass;
    const targetMass = defender.stats.totalMass;
    const reduced = 1 / (1 / Math.max(0.5, rotorEffectiveMass) + 1 / Math.max(0.5, targetMass));

    let available = 0.5 * reduced * relative * relative;
    if (weapon.rotor) {
      available = Math.min(available, attacker.weaponEnergy);
    } else if (weapon.actuator || weapon.clamp) {
      // A flipper, hammer or crusher delivers its charge, not a kinetic-energy
      // budget — but only when it is actually swinging or biting. `Bot` owns that
      // state, so it owns the number.
      available = Math.max(available, attacker.actuatorStrikeEnergy * 0.55);
    }

    if (available < MIN_DAMAGING_ENERGY) return;

    // How squarely the tooth met the surface.
    const squareness = clamp01(Math.abs(normal.y) < 0.98 ? 0.45 + 0.55 * Math.abs(
      normal.dot(this.tmpA.copy(point).sub(defender.position(this.tmpB)).normalize()),
    ) : 0.6);

    const face: ArmorFace = defenderRef.face ?? defender.faceForContact(point);
    const part: PartState = this.pickTargetPart(defender, face, point);

    const result = defender.damage.hit({
      energy: available,
      bite: weapon.bite,
      squareness,
      targetMaterial: defender.stats.parts.armor,
      part,
    });

    this.hitCooldowns.set(key, HIT_COOLDOWN);
    /*
     * Everything the strike did to the defender, not just the panel's share.
     *
     * Shock through the armour into the frame is structural damage the attacker
     * caused, and the judges score on `damageDealt` alone — so crediting only the
     * absorbed part meant up to 69% of the damage an attacker inflicted went
     * unrecorded. Worse, the uncredited share is set by the *defender's* armour, so
     * it does not cancel between the two machines: a spinner working on a plastic
     * bot could out-damage its opponent two to one and lose the damage column.
     */
    const inflicted = result.damage + result.shockConsumed;
    attacker.damageDealt += inflicted;
    attacker.aggression += inflicted * 0.0002;

    // What the panel refused comes back up the weapon, scaled by how hard that
    // panel is. Hitting tool steel blunts a rotor; hitting plastic barely marks it.
    const refused = Math.max(0, available - result.energyTransferred);
    attacker.damage.wearWeapon(refused * WEAPON_WEAR * defender.stats.parts.armor.hardness);

    /*
     * Plastic deformation has to come from somewhere: take it out of the rotor.
     *
     * All of it — the panel's share *and* the shock that carried on through into
     * the frame. Charging only the absorbed part while `BotDamage.hit` quietly
     * spent the rest on the frame put up to three times as many joules into a
     * machine's structure as ever left the weapon that hit it. The whole premise of this model is one shared
     * currency — the joules that come off the rotor are the joules that go into
     * the other machine's structure — and taking only a fraction back meant a
     * spinner destroyed nearly twice as much armour as it paid for. (The energy
     * that goes into throwing the two machines apart is a separate account:
     * Rapier's contact resolution takes that out of the bodies' own kinetic
     * energy, so charging the rotor exactly what the panel absorbed is not
     * double-counting.) A big hit now genuinely costs a spinner its wind-up, which
     * is the single most recognisable rhythm in the sport.
     */
    if (weapon.rotor) attacker.bleedWeaponEnergy(result.energyTransferred + result.shockConsumed);

    this.events.emit('impact', {
      position: point.clone(),
      normal: normal.clone(),
      energy: result.energyTransferred,
      severity: result.severity,
      attacker,
      defender,
      partId: part.id,
      kind: 'weapon',
    });

    if (result.destroyed) this.destroyPart(defender, part, point);
  }

  private onContactForce(
    handleA: number,
    handleB: number,
    impulse: number,
    normal: { x: number; y: number; z: number },
  ): void {
    if (impulse < RAM_IMPULSE_THRESHOLD) return;

    const refA = this.colliderIndex.get(handleA);
    const refB = this.colliderIndex.get(handleB);
    const wallA = this.arena.wallColliders.has(handleA);
    const wallB = this.arena.wallColliders.has(handleB);

    const n = this.tmpA.set(normal.x, normal.y, normal.z);

    // Machine into wall or floor.
    if ((wallA && refB) || (wallB && refA)) {
      const ref = (wallA ? refB : refA)!;
      if (ref.isWeapon) return;
      const bot = ref.bot;
      const key = `wall:${bot.id}`;
      if (this.hitCooldowns.has(key)) return;

      const speed = bot.speed + Math.abs(bot.chassis.linvel().y);
      const energy = 0.5 * impulse * speed;
      if (energy < MIN_DAMAGING_ENERGY * 4) return;

      /*
       * Use the manifold's own contact point rather than pushing the bot's centre
       * along the event normal. Rapier reports that normal in the pair's order,
       * which is whichever way round the broad phase happened to register the two
       * colliders — so the offset landed on the correct face roughly half the time
       * and put the damage straight through the opposite panel the rest of it.
       */
      const point = this.contactPoint(handleA, handleB).point;
      const face = bot.faceForContact(point);
      const part = this.pickTargetPart(bot, face, point);
      const result = bot.damage.hit({
        energy,
        bite: 0.4,
        squareness: 0.5,
        targetMaterial: bot.stats.parts.armor,
        part,
      });
      this.hitCooldowns.set(key, 0.4);
      if (result.damage > 1) {
        this.events.emit('impact', {
          position: point,
          normal: n.clone(),
          energy: result.energyTransferred,
          severity: result.severity * 0.7,
          attacker: null,
          defender: bot,
          partId: part.id,
          kind: 'wall',
        });
        if (result.destroyed) this.destroyPart(bot, part, point);
      }
      return;
    }

    // Machine into machine, no weapon involved: a shoving match with some bite.
    if (refA && refB && refA.bot !== refB.bot && !refA.isWeapon && !refB.isWeapon) {
      const key = `ram:${Math.min(refA.bot.id, refB.bot.id)}:${Math.max(refA.bot.id, refB.bot.id)}`;
      if (this.hitCooldowns.has(key)) return;

      const closing = Math.abs(this.closingSpeed(refA.bot, refB.bot, n));
      const energy = 0.5 * impulse * closing;
      if (energy < MIN_DAMAGING_ENERGY * 3) return;
      this.hitCooldowns.set(key, 0.3);

      // The faster machine is the one doing the ramming.
      const aggressor = refA.bot.speed >= refB.bot.speed ? refA : refB;
      const victim = aggressor === refA ? refB : refA;
      const point = this.contactPoint(handleA, handleB).point;
      const face = victim.face ?? victim.bot.faceForContact(point);
      const part = this.pickTargetPart(victim.bot, face, point);
      const result = victim.bot.damage.hit({
        energy,
        bite: 0.5,
        squareness: 0.55,
        targetMaterial: victim.bot.stats.parts.armor,
        part,
      });
      aggressor.bot.aggression += 0.05;
      aggressor.bot.control += 0.05;
      // The judges score on `damageDealt` and nothing else, so a machine that wins
      // by driving its opponent into the wall has to be credited for it. Only
      // weapon strikes were being counted, which handed every ramming build a 0 in
      // the damage column of a decision it had comfortably earned.
      // Panel *and* the shock it drove into the frame, exactly as the weapon path
      // does. Crediting only the panel's share left the ram column skewed by the
      // defender's armour: measured, an aggressor facing plastic was credited 9%
      // of what it actually did against 69% facing tool steel.
      aggressor.bot.damageDealt += result.damage + result.shockConsumed;
      if (result.damage > 1) {
        this.events.emit('impact', {
          position: point,
          normal: n.clone(),
          energy: result.energyTransferred,
          severity: result.severity * 0.6,
          attacker: aggressor.bot,
          defender: victim.bot,
          partId: part.id,
          kind: 'ram',
        });
        if (result.destroyed) this.destroyPart(victim.bot, part, point);
      }
    }
  }

  private applyHazard(
    kind: string,
    energy: number,
    ref: PartRef,
    _hazardHandle: number,
    victimHandle: number,
  ): void {
    const bot = ref.bot;
    const key = `hz:${kind}:${bot.id}`;
    if (this.hitCooldowns.has(key)) return;
    this.hitCooldowns.set(key, 0.22);

    const point = this.colliderWorldPoint(victimHandle);
    const face = ref.face ?? bot.faceForContact(point);
    const part = this.pickTargetPart(bot, face, point);
    const result = bot.damage.hit({
      energy,
      bite: kind === 'pulverizer' ? 1.3 : 0.9,
      squareness: 0.8,
      targetMaterial: bot.stats.parts.armor,
      part,
    });

    this.events.emit('impact', {
      position: point,
      normal: new THREE.Vector3(0, 1, 0),
      energy: result.energyTransferred,
      severity: clamp01(result.severity + 0.25),
      attacker: null,
      defender: bot,
      partId: part.id,
      kind: 'hazard',
    });
    if (result.destroyed) this.destroyPart(bot, part, point);
  }

  // -------------------------------------------------------------------------

  /**
   * Choose what actually takes the hit. Once a panel is gone the frame is
   * exposed, and a low contact near a corner is much more likely to find a wheel.
   */
  private pickTargetPart(bot: Bot, face: ArmorFace, worldPoint: THREE.Vector3): PartState {
    const wheels = bot.damage.parts.filter((p) => p.kind === 'wheel' && !p.destroyed);
    if (wheels.length > 0) {
      const t = bot.chassis.translation();
      const height = worldPoint.y - t.y;
      const lowHit = height < -bot.stats.parts.chassis.height * 0.18;
      const sideHit = face === 'left' || face === 'right' || face === 'bottom';
      /*
       * Armoured skirts are what they are for: a strip of plate hanging down the
       * side to stop a weapon getting under the machine and into the wheels. The
       * accessory used to add 6.2 kg and a decorative mesh and nothing else — the
       * damage model could not see it at all — which made it a trap rather than a
       * choice.
       */
      const skirted = bot.stats.parts.accessories.includes('skirts');
      if (lowHit && sideHit && fxRng.bool(skirted ? 0.18 : 0.55)) {
        return fxRng.pick(wheels);
      }
    }

    // A hit that lands on the weapon housing damages the weapon.
    if (face === 'front' && fxRng.bool(0.12)) {
      const weapon = bot.damage.get('weapon');
      if (weapon && !weapon.destroyed) return weapon;
    }

    return bot.damage.partForFace(face);
  }

  private destroyPart(bot: Bot, part: PartState, position: THREE.Vector3): void {
    bot.onPartDestroyed(part.id);
    this.events.emit('partDestroyed', { bot, part, position: position.clone() });

    if (part.detachable && part.kind === 'armor') {
      const face = part.face!;
      const size = this.panelSize(bot, face);
      this.debris.spawnPanel({
        position,
        size,
        velocity: this.tmpB
          .copy(position)
          .sub(bot.position(this.tmpA))
          .normalize()
          .multiplyScalar(4 + fxRng.range(0, 5))
          .setY(3 + fxRng.range(0, 4)),
        color: bot.design.paint.primary,
        mass: Math.max(0.6, bot.stats.armorMass * 0.12),
      });
    } else if (part.kind === 'wheel') {
      this.debris.spawnWheel({
        position,
        radius: bot.stats.parts.wheel.radius,
        width: bot.stats.parts.wheel.width,
        velocity: new THREE.Vector3(fxRng.spread(4), 3 + fxRng.range(0, 3), fxRng.spread(4)),
        mass: bot.stats.parts.wheel.mass,
      });
    }

    if (part.kind === 'frame') {
      bot.damage.countOut();
    }
  }

  private panelSize(bot: Bot, face: ArmorFace): THREE.Vector3 {
    const { width, height, length } = bot.stats.parts.chassis;
    const plate = Math.max(0.006, bot.design.armorThicknessMm / 1000);
    switch (face) {
      case 'front':
      case 'rear':
        return new THREE.Vector3(width, height, plate);
      case 'left':
      case 'right':
        return new THREE.Vector3(plate, height, length);
      default:
        return new THREE.Vector3(width, plate, length);
    }
  }

  private checkKnockouts(): void {
    for (const bot of this.bots) {
      if (this.knockedOut.has(bot.id)) continue;

      if (this.arena.isOutOfBounds(bot.position(this.tmpA))) {
        bot.damage.countOut();
        this.knockedOut.add(bot.id);
        bot.disable();
        this.events.emit('knockout', { bot, reason: 'out-of-bounds' });
        continue;
      }

      if (bot.damage.countedOut) {
        this.knockedOut.add(bot.id);
        bot.disable();
        this.events.emit('knockout', {
          bot,
          reason: bot.damage.wrecked ? 'destroyed' : 'counted-out',
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------

  /** World-space contact point and normal for a colliding pair. */
  private contactPoint(handleA: number, handleB: number): {
    point: THREE.Vector3;
    normal: THREE.Vector3;
  } {
    const rapier = this.world.world;
    const colliderA = rapier.getCollider(handleA);
    const colliderB = rapier.getCollider(handleB);
    const point = new THREE.Vector3();
    const normal = new THREE.Vector3(0, 1, 0);

    if (colliderA && colliderB) {
      let found = false;
      rapier.contactPair(colliderA, colliderB, (manifold, flipped) => {
        if (found || manifold.numContacts() === 0) return;
        const local = manifold.localContactPoint1(0);
        const n = manifold.normal();
        if (!local) return;
        const source = flipped ? colliderB : colliderA;
        const t = source.translation();
        const r = source.rotation();
        this.tmpQ.set(r.x, r.y, r.z, r.w);
        point.set(local.x, local.y, local.z).applyQuaternion(this.tmpQ).add(
          new THREE.Vector3(t.x, t.y, t.z),
        );
        normal.set(n.x, n.y, n.z);
        if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
        found = true;
      });
      if (!found) {
        const ta = colliderA.translation();
        const tb = colliderB.translation();
        point.set((ta.x + tb.x) / 2, (ta.y + tb.y) / 2, (ta.z + tb.z) / 2);
        normal.set(tb.x - ta.x, tb.y - ta.y, tb.z - ta.z);
        if (normal.lengthSq() < 1e-6) normal.set(0, 1, 0);
        else normal.normalize();
      }
    }
    return { point, normal };
  }

  private colliderWorldPoint(handle: number): THREE.Vector3 {
    const collider = this.world.world.getCollider(handle);
    if (!collider) return new THREE.Vector3();
    const t = collider.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** Speed at which two machines are closing along the contact normal. */
  private closingSpeed(a: Bot, b: Bot, normal: THREE.Vector3): number {
    const va = a.chassis.linvel();
    const vb = b.chassis.linvel();
    return (
      (vb.x - va.x) * -normal.x + (vb.y - va.y) * -normal.y + (vb.z - va.z) * -normal.z
    );
  }
}

/** Convenience for the AI and HUD: how healthy a bot looks from the outside. */
export const botCondition = (bot: Bot): number =>
  clamp(
    bot.damage.integrity * 0.55 + bot.damage.mobility * 0.3 + bot.damage.weaponCondition * 0.15,
    0,
    1,
  );

export type { RAPIER };
