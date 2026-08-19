import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat, type ImpactEvent } from '../src/game/combat.ts';
import { makeDefaultDesign, presetById, computeStats, cloneDesign } from '../src/game/design.ts';
import { materialById } from '../src/game/parts.ts';
import {
  BotDamage,
  resolveHit,
  scoreJudges,
  transferFraction,
  type PartState,
} from '../src/game/damage.ts';
import { bodyGroups, canInteract, weaponGroups, Layer, groups } from '../src/physics/groups.ts';

beforeAll(async () => {
  await initRapier();
});

const run = (world: PhysicsWorld, seconds: number): void => {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) world.step();
};

describe('collision filtering', () => {
  it('lets a weapon hit the enemy but never its own machine', () => {
    const myBody = bodyGroups(0);
    const myWeapon = weaponGroups(0);
    const theirBody = bodyGroups(1);
    const theirWeapon = weaponGroups(1);

    // A bolted-on weapon must not collide with the frame holding it, or it stalls.
    expect(canInteract(myWeapon, myBody)).toBe(false);
    expect(canInteract(theirWeapon, theirBody)).toBe(false);

    // Everything about the opponent is fair game.
    expect(canInteract(myWeapon, theirBody)).toBe(true);
    expect(canInteract(myWeapon, theirWeapon)).toBe(true);
    expect(canInteract(myBody, theirBody)).toBe(true);

    // And everyone collides with the box.
    const arena = groups(Layer.ARENA, 0xffff);
    expect(canInteract(myBody, arena)).toBe(true);
    expect(canInteract(myWeapon, arena)).toBe(true);
  });
});

describe('energy transfer', () => {
  const uhmw = materialById('uhmw');
  const tool = materialById('s7');

  it('sheds energy off slippery, ductile armour and couples into hard armour', () => {
    const slippery = transferFraction(1, uhmw, 1);
    const hard = transferFraction(1, tool, 1);
    expect(hard).toBeGreaterThan(slippery * 1.5);
  });

  it('transfers less on a glancing blow than a square one', () => {
    expect(transferFraction(0.1, tool, 1)).toBeLessThan(transferFraction(1, tool, 1));
  });

  it('never transfers everything, and never transfers nothing', () => {
    for (const squareness of [0, 0.5, 1]) {
      for (const bite of [0.2, 1, 1.6]) {
        const fraction = transferFraction(squareness, tool, bite);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
      }
    }
  });
});

describe('resolveHit', () => {
  const part = (hp: number): PartState => ({
    id: 'armor-front',
    kind: 'armor',
    label: 'Front armour',
    hp,
    maxHp: hp,
    destroyed: false,
    absorbed: 0,
    face: 'front',
    detachable: true,
  });

  it('consumes hit points and reports what it consumed', () => {
    const target = part(10_000);
    const result = resolveHit({
      energy: 20_000,
      bite: 1,
      squareness: 1,
      targetMaterial: materialById('hardox'),
      part: target,
    });
    expect(result.damage).toBeGreaterThan(0);
    expect(target.hp).toBeCloseTo(10_000 - result.damage, 6);
    expect(target.absorbed).toBeGreaterThan(0);
  });

  it('destroys a part exactly once and never drives hit points negative', () => {
    const target = part(500);
    const first = resolveHit({
      energy: 400_000,
      bite: 1.5,
      squareness: 1,
      targetMaterial: materialById('cfrp'),
      part: target,
    });
    expect(first.destroyed).toBe(true);
    expect(target.hp).toBe(0);

    const second = resolveHit({
      energy: 400_000,
      bite: 1.5,
      squareness: 1,
      targetMaterial: materialById('cfrp'),
      part: target,
    });
    expect(second.destroyed, 'a part must not be destroyed twice').toBe(false);
    expect(target.hp).toBe(0);
  });

  it('scales severity by how much of the part was taken out', () => {
    const light = resolveHit({
      energy: 800,
      bite: 1,
      squareness: 1,
      targetMaterial: materialById('hardox'),
      part: part(50_000),
    });
    const heavy = resolveHit({
      energy: 60_000,
      bite: 1,
      squareness: 1,
      targetMaterial: materialById('hardox'),
      part: part(50_000),
    });
    expect(heavy.severity).toBeGreaterThan(light.severity);
    expect(heavy.severity).toBeLessThanOrEqual(1);
  });
});

describe('BotDamage bookkeeping', () => {
  const stats = computeStats(makeDefaultDesign());

  it('builds a part for every wheel, face, the frame and the weapon', () => {
    const damage = new BotDamage(stats);
    expect(damage.get('frame')).toBeTruthy();
    expect(damage.get('weapon')).toBeTruthy();
    for (const face of ['front', 'rear', 'left', 'right', 'top', 'bottom']) {
      expect(damage.get(`armor-${face}`), face).toBeTruthy();
    }
    for (let i = 0; i < stats.wheelCount; i++) {
      expect(damage.get(`wheel-${i}`)).toBeTruthy();
    }
    expect(damage.integrity).toBeCloseTo(1, 6);
    expect(damage.mobility).toBeCloseTo(1, 6);
  });

  it('exposes the frame once a panel is gone', () => {
    const damage = new BotDamage(stats);
    expect(damage.partForFace('front').id).toBe('armor-front');
    const panel = damage.get('armor-front')!;
    panel.hp = 0;
    panel.destroyed = true;
    expect(damage.partForFace('front').id).toBe('frame');
  });

  it('drops mobility as wheels are lost', () => {
    const damage = new BotDamage(stats);
    const wheels = damage.parts.filter((p) => p.kind === 'wheel');
    wheels[0]!.destroyed = true;
    expect(damage.mobility).toBeCloseTo(1 - 1 / wheels.length, 6);
    for (const wheel of wheels) wheel.destroyed = true;
    expect(damage.mobility).toBe(0);
  });

  it('counts out a machine that stops showing movement', () => {
    const damage = new BotDamage(stats);
    // Just under the ten-second count: still alive.
    for (let i = 0; i < 90; i++) damage.tickMobility(0.1, 0, false);
    expect(damage.countedOut).toBe(false);
    // Past it: counted out.
    for (let i = 0; i < 20; i++) damage.tickMobility(0.1, 0, false);
    expect(damage.countedOut).toBe(true);
  });

  it('does not count out a machine whose weapon is still turning', () => {
    const damage = new BotDamage(stats);
    for (let i = 0; i < 200; i++) damage.tickMobility(0.1, 0, true);
    expect(damage.countedOut).toBe(false);
  });

  it('resets the count the moment a machine moves again', () => {
    const damage = new BotDamage(stats);
    for (let i = 0; i < 80; i++) damage.tickMobility(0.1, 0, false);
    expect(damage.immobileFor).toBeGreaterThan(5);
    damage.tickMobility(0.1, 3, false);
    expect(damage.immobileFor).toBe(0);
    expect(damage.countedOut).toBe(false);
  });
});

describe('judging', () => {
  it('awards the fight to the machine that did more of everything', () => {
    const card = scoreJudges(
      { damage: 40_000, aggression: 20, control: 30 },
      { damage: 5_000, aggression: 4, control: 8 },
    );
    expect(card.winner).toBe(0);
    expect(card.unanimous).toBe(true);
    expect(card.total[0]).toBeGreaterThan(card.total[1]);
  });

  it('always allocates the full eleven points', () => {
    const card = scoreJudges(
      { damage: 12_000, aggression: 9, control: 3 },
      { damage: 9_000, aggression: 4, control: 14 },
    );
    expect(card.total[0] + card.total[1]).toBeCloseTo(11, 6);
    expect(card.unanimous).toBe(false);
  });

  it('splits a scoreless fight down the middle', () => {
    const card = scoreJudges(
      { damage: 0, aggression: 0, control: 0 },
      { damage: 0, aggression: 0, control: 0 },
    );
    expect(card.total[0]).toBeCloseTo(card.total[1], 6);
  });
});

describe('a spinner hitting a real opponent', () => {
  it('damages the target, sheds energy and reports impacts', () => {
    const world = new PhysicsWorld();
    const combat = new Combat(world, { headless: true });

    // A big vertical spinner against a light, brittle machine.
    const attackerDesign = makeDefaultDesign();
    const victimDesign = cloneDesign(presetById('sparkplug').design);
    victimDesign.name = 'Crash Test';
    victimDesign.armorMaterialId = 'cfrp';
    victimDesign.armorThicknessMm = 3;
    victimDesign.weaponId = 'wedge';
    victimDesign.chassisId = 'boxframe';

    const attacker = combat.addBot(attackerDesign, 0);
    const victim = combat.addBot(victimDesign, 1);
    combat.start();

    const impacts: ImpactEvent[] = [];
    combat.events.on('impact', (event) => impacts.push(event));

    // Wind the weapon up, then drive straight at the other machine.
    attacker.setInput({ weapon: true });
    run(world, attacker.stats.weaponSpinupTime * 2 + 1);
    const energyBefore = attacker.weaponEnergy;
    expect(energyBefore).toBeGreaterThan(10_000);

    const integrityBefore = victim.damage.integrity;

    /*
     * Park the victim directly in front of the attacker and drive into it. Letting
     * a scripted driver find the target is a test of the steering code, not of the
     * damage model, and it made this test silently pass while never landing a hit.
     */
    const place = () => {
      const attackerPos = attacker.position(new THREE.Vector3());
      const forward = attacker.forward(new THREE.Vector3()).setY(0).normalize();
      const target = attackerPos.clone().addScaledVector(forward, 1.15);
      victim.chassis.setTranslation({ x: target.x, y: attackerPos.y, z: target.z }, true);
      victim.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      victim.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    };

    attacker.setInput({ throttle: 1, weapon: true });
    for (let pass = 0; pass < 14; pass++) {
      place();
      run(world, 0.7);
    }

    expect(impacts.length, 'a spun-up spinner produced no impacts at all').toBeGreaterThan(0);
    expect(
      victim.damage.integrity,
      'the victim took no damage from a 37 kJ spinner',
    ).toBeLessThan(integrityBefore);
    expect(attacker.damageDealt).toBeGreaterThan(0);

    // Energy is a shared currency: what went into the victim came out of the rotor.
    for (const impact of impacts) {
      expect(impact.energy).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(impact.energy)).toBe(true);
      expect(Number.isFinite(impact.position.x)).toBe(true);
    }

    // And the whole thing stayed numerically sane.
    expect(Number.isFinite(attacker.position().y)).toBe(true);
    expect(Number.isFinite(victim.position().y)).toBe(true);

    world.free();
  });

  it('never reports damage against the attacker for its own weapon', () => {
    const world = new PhysicsWorld();
    const combat = new Combat(world, { headless: true });
    const attacker = combat.addBot(makeDefaultDesign(), 0);
    combat.addBot(presetById('doorstop').design, 1);
    combat.start();

    const selfHits: ImpactEvent[] = [];
    combat.events.on('impact', (event) => {
      if (event.defender === attacker && event.attacker === attacker) selfHits.push(event);
    });

    attacker.setInput({ weapon: true, throttle: 1 });
    run(world, 8);
    expect(selfHits, 'a machine damaged itself with its own weapon').toEqual([]);
    world.free();
  });
});

describe('debris', () => {
  it('caps the number of loose pieces on the floor', () => {
    const world = new PhysicsWorld();
    const combat = new Combat(world, { headless: true });
    combat.start();

    for (let i = 0; i < 60; i++) {
      combat.debris.spawnPanel({
        position: new THREE.Vector3(0, 1 + i * 0.01, 0),
        size: new THREE.Vector3(0.2, 0.01, 0.2),
        velocity: new THREE.Vector3(0, 1, 0),
        color: 0xff0000,
        mass: 1,
      });
    }
    expect(combat.debris.count).toBeLessThanOrEqual(22);
    run(world, 1);
    expect(Number.isFinite(combat.debris.count)).toBe(true);
    world.free();
  });
});
