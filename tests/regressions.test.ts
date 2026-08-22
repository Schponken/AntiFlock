/**
 * Regressions.
 *
 * Every test in here pins a defect that shipped once. They are written against
 * the real engine — a real Rapier world, the real catalogue, the real damage
 * model — because every one of these bugs looked perfectly correct in the source
 * and only showed up when something was actually simulated.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { Arena } from '../src/game/arena.ts';
import { BotAI, type Difficulty } from '../src/game/ai.ts';
import {
  PRESETS,
  computeStats,
  makeDefaultDesign,
  presetById,
  validateDesign,
  type BotDesign,
} from '../src/game/design.ts';
import {
  MATERIALS,
  WEAPONS,
  materialById,
  rotorInertiaTensor,
  weaponById,
} from '../src/game/parts.ts';
import {
  BotDamage,
  SHOCK_COUPLING,
  resolveHit,
  scoreJudges,
  transferFraction,
} from '../src/game/damage.ts';
import { DEBRIS_GROUPS, Layer, filterOf } from '../src/physics/groups.ts';
import type { Bot } from '../src/game/bot.ts';
import { StartSequence } from '../src/game/startSequence.ts';
import { panelGeometry } from '../src/render/botMesh.ts';
import { GeometryRegistry } from '../src/render/hardware.ts';

beforeAll(async () => {
  await initRapier();
});

/*
 * Rapier worlds are WASM allocations that nothing reclaims when the JavaScript
 * handle goes out of scope, and a test that fails an assertion never reaches its
 * own `world.free()`. Sweeping up afterwards keeps a red run from also being a
 * leaking one. `PhysicsWorld.free` is idempotent, so the explicit calls stay.
 */
const worlds: PhysicsWorld[] = [];
afterEach(() => {
  for (const world of worlds.splice(0)) world.free();
});

const run = (world: PhysicsWorld, seconds: number): void => {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) world.step();
};

function solo(design: BotDesign) {
  const world = new PhysicsWorld();
  const combat = new Combat(world, { headless: true });
  const bot = combat.addBot(design, 0);
  combat.start();
  worlds.push(world);
  return { world, combat, bot };
}

function fight(a: BotDesign, b: BotDesign) {
  const world = new PhysicsWorld();
  const combat = new Combat(world, { headless: true });
  const red = combat.addBot(a, 0);
  const blue = combat.addBot(b, 1);
  combat.start();
  worlds.push(world);
  return { world, combat, red, blue };
}

const drive = (bot: Bot, throttle: number, steer = 0): void => {
  bot.setInput({ throttle, steer, weapon: false, fire: false, selfRight: false });
};

// ---------------------------------------------------------------------------
// Drivetrain
// ---------------------------------------------------------------------------

describe('drivetrain', () => {
  it('keeps every preset off its belly once the suspension settles', () => {
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const { world, bot } = solo(preset.design);
      run(world, 1.5);
      const clearance =
        (bot as unknown as { chassis: { translation(): { y: number } } }).chassis.translation().y -
        stats.parts.chassis.height / 2;
      expect(clearance, `${preset.design.name} has sunk onto its frame`).toBeGreaterThan(0.003);
      world.free();
    }
  });

  it('drives every preset, including the two-wheel frames', () => {
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const { world, bot } = solo(preset.design);
      run(world, 1);
      const start = bot.position().clone();
      drive(bot, 1);
      run(world, 2);
      const moved = bot.position().distanceTo(start);
      expect(
        moved,
        `${preset.design.name} (${stats.parts.chassis.wheelCount} wheels) barely moved`,
      ).toBeGreaterThan(1);
      world.free();
    }
  });

  it('steers the way the key says: right yaws right', () => {
    const { world, bot } = solo(presetById('sparkplug').design);
    run(world, 1);
    const before = bot.forward().clone();
    drive(bot, 0, 1);
    run(world, 1.5);
    const after = bot.forward().clone();

    // The machine's own right-hand side is body -X, so a right turn takes the
    // forward vector from +Z towards -X. That is a negative Y component on
    // before x after.
    const yaw = before.z * after.x - before.x * after.z;
    expect(yaw).toBeLessThan(-0.1);
    world.free();
  });

  it('does not exceed the top speed it advertises', () => {
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const { world, bot } = solo(preset.design);
      drive(bot, 1);
      run(world, 4);
      expect(bot.speed, `${preset.design.name} ran past its own spec sheet`).toBeLessThanOrEqual(
        stats.topSpeed * 1.08,
      );
      world.free();
    }
  });

  it('simulates exactly the mass the builder quoted', () => {
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const { world, bot } = solo(preset.design);
      const rig = bot as unknown as {
        chassis: { mass(): number };
        weaponBody: { mass(): number } | null;
      };
      const simulated = rig.chassis.mass() + (rig.weaponBody?.mass() ?? 0);
      expect(simulated, `${preset.design.name} is not the weight it was weighed at`).toBeCloseTo(
        stats.totalMass,
        2,
      );
      world.free();
    }
  });

  it('is under the class limit in the solver, not just on the spec sheet', () => {
    for (const preset of PRESETS) {
      const { world, bot } = solo(preset.design);
      const rig = bot as unknown as {
        chassis: { mass(): number };
        weaponBody: { mass(): number } | null;
      };
      expect(rig.chassis.mass() + (rig.weaponBody?.mass() ?? 0)).toBeLessThanOrEqual(113.398);
      world.free();
    }
  });
});

// ---------------------------------------------------------------------------
// Inversion and self-righting
// ---------------------------------------------------------------------------

describe('inversion', () => {
  /**
   * Roll a machine onto its back and let it settle.
   *
   * Placed at its own resting height rather than dropped: a drop bounces, and a
   * bounce is enough to flop several of the frames back the right way up, which
   * would quietly turn these into tests of nothing.
   */
  function flip(bot: Bot, world: PhysicsWorld, height: number): void {
    const rig = bot as unknown as { chassis: any; weaponBody: any | null };
    const chassis = rig.chassis;

    const from = chassis.translation();
    const fromRotation = chassis.rotation();
    const to = { x: from.x, y: height / 2 + 0.02, z: from.z };
    // 180 degrees about the machine's long axis.
    const toRotation = { x: 1, y: 0, z: 0, w: 0 };

    /*
     * The weapon is a separate rigid body on a joint. Moving the chassis without
     * moving it leaves the joint stretched by however far the chassis jumped, and
     * the solver answers that by hurling the machine across the arena — which is
     * a great way to write a test that quietly stops testing what it says it
     * does. Carry the weapon through the same rigid transform.
     */
    const q0 = new THREE.Quaternion(
      fromRotation.x,
      fromRotation.y,
      fromRotation.z,
      fromRotation.w,
    );
    const q1 = new THREE.Quaternion(toRotation.x, toRotation.y, toRotation.z, toRotation.w);
    const delta = q1.clone().multiply(q0.clone().invert());

    if (rig.weaponBody) {
      const wt = rig.weaponBody.translation();
      const wr = rig.weaponBody.rotation();
      const offset = new THREE.Vector3(wt.x - from.x, wt.y - from.y, wt.z - from.z).applyQuaternion(
        delta,
      );
      rig.weaponBody.setTranslation(
        { x: to.x + offset.x, y: to.y + offset.y, z: to.z + offset.z },
        true,
      );
      rig.weaponBody.setRotation(
        delta.clone().multiply(new THREE.Quaternion(wr.x, wr.y, wr.z, wr.w)),
        true,
      );
      rig.weaponBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rig.weaponBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    chassis.setRotation(toRotation, true);
    chassis.setTranslation(to, true);
    chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    run(world, 1.2);
  }

  it('drives an invertible frame upside-down', () => {
    const design = presetById('anvilhead').design;
    const stats = computeStats(design);
    expect(stats.invertible, 'preset is not an invertible frame').toBe(true);

    const { world, bot } = solo(design);
    run(world, 1);
    flip(bot, world, stats.parts.chassis.height);
    expect(bot.inverted).toBe(true);

    const start = bot.position().clone();
    drive(bot, 1);
    run(world, 3);
    expect(
      bot.position().distanceTo(start),
      'invertible frame is stranded on its back',
    ).toBeGreaterThan(0.5);
    expect(bot.inverted, 'it should still be running upside-down, not have flopped over').toBe(
      true,
    );
    world.free();
  });

  it('steers the same way round when it is upside-down', () => {
    // Two things reverse when a frame rolls over and they cancel for steering.
    // Getting that wrong is invisible until someone actually drives inverted.
    for (const steer of [1, -1]) {
      const design = presetById('anvilhead').design;
      const stats = computeStats(design);
      const { world, bot } = solo(design);
      run(world, 1);
      flip(bot, world, stats.parts.chassis.height);
      expect(bot.inverted).toBe(true);

      const before = bot.forward().clone();
      drive(bot, 0, steer);
      run(world, 1.5);
      const after = bot.forward().clone();
      const yaw = before.z * after.x - before.x * after.z;

      // Same sign convention as the right-way-up test: right is negative.
      if (steer > 0) expect(yaw, 'inverted right turn went left').toBeLessThan(0);
      else expect(yaw, 'inverted left turn went right').toBeGreaterThan(0);
      world.free();
    }
  });

  it('lets a machine with a srimech right itself, invertible frame or not', () => {
    // `discshell` is the case the srimech guard used to get wrong: an invertible
    // frame that is perfectly happy upside-down, but is still entitled to fit a
    // srimech and use it. `boxframe` is the ordinary case.
    for (const chassisId of ['discshell', 'boxframe']) {
      const design = makeDefaultDesign();
      design.chassisId = chassisId;
      design.weaponId = 'wedge';
      design.accessories = ['srimech'];
      design.armorThicknessMm = 4;
      const stats = computeStats(design);
      const { world, bot } = solo(design);
      run(world, 1);
      flip(bot, world, stats.parts.chassis.height);
      expect(bot.inverted, `${chassisId} did not stay inverted`).toBe(true);
      expect(bot.damage.srimechWorks).toBe(true);

      // The arm has a cooldown, so a real driver hits it more than once.
      for (let attempt = 0; attempt < 4 && bot.up().y < 0.5; attempt++) {
        bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: false, selfRight: false });
        run(world, 0.1);
        bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: false, selfRight: true });
        run(world, 2.6);
      }
      expect(bot.up().y, `${chassisId} could not use its srimech`).toBeGreaterThan(0.5);
      world.free();
    }
  });
});

// ---------------------------------------------------------------------------
// Weapons and damage
// ---------------------------------------------------------------------------

describe('weapons', () => {
  it('gives every actuator and clamp weapon a real energy budget', () => {
    for (const weapon of WEAPONS) {
      if (weapon.rotor || weapon.kind === 'wedge') continue;
      const design = makeDefaultDesign();
      design.chassisId = 'boxframe';
      design.weaponId = weapon.id;
      const stats = computeStats(design);
      expect(stats.actuatorEnergy, `${weapon.name} has no charge to deliver`).toBeGreaterThan(100);
    }
  });

  it('deals no actuator damage until the arm is actually fired', () => {
    const design = makeDefaultDesign();
    design.chassisId = 'boxframe';
    design.weaponId = 'flipper';
    const { world, bot } = solo(design);
    run(world, 0.5);
    expect(bot.actuatorStrikeEnergy).toBe(0);

    bot.setInput({ throttle: 0, steer: 0, weapon: true, fire: true, selfRight: false });
    run(world, 0.1);
    expect(bot.actuatorStrikeEnergy).toBeGreaterThan(0);
    world.free();
  });

  it('runs a flipper out of gas and then does nothing at all', () => {
    const design = makeDefaultDesign();
    design.chassisId = 'boxframe';
    design.weaponId = 'flipper';
    const shots = weaponById('flipper').actuator!.shots;
    const { world, bot } = solo(design);
    run(world, 0.5);
    expect(bot.actuatorShots).toBe(shots);

    for (let i = 0; i < shots + 3; i++) {
      bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: true, selfRight: false });
      run(world, 0.1);
      bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: false, selfRight: false });
      // Longer than the flipper's own 2.6 s cycle, or the shot is simply refused
      // because the arm has not come back down yet.
      run(world, 2.9);
    }

    expect(bot.actuatorShots).toBe(0);
    bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: true, selfRight: false });
    run(world, 0.2);
    expect(bot.actuatorStrikeEnergy, 'an empty bottle still delivered a charge').toBe(0);
    world.free();
  });

  it('puts a rotor spin inertia on exactly one axis', () => {
    for (const weapon of WEAPONS) {
      if (!weapon.rotor) continue;
      const tensor = rotorInertiaTensor(weapon, materialById('ar500'));
      const axis = weapon.rotor.axis;
      const spin = tensor[axis];
      const others = (['x', 'y', 'z'] as const).filter((a) => a !== axis).map((a) => tensor[a]);
      for (const other of others) {
        expect(other, `${weapon.name}: transverse inertia is on the spin axis`).toBeLessThan(spin);
      }
    }
  });
});

describe('damage accounting', () => {
  const part = () => ({
    id: 'armor-front',
    kind: 'armor' as const,
    label: 'Front armour',
    hp: 1e9,
    maxHp: 1e9,
    destroyed: false,
    absorbed: 0,
    detachable: true,
  });

  it('never removes more armour-joules than the strike delivered', () => {
    for (const material of MATERIALS) {
      for (const bite of [0.4, 1, 1.6, 2]) {
        const result = resolveHit({
          energy: 10_000,
          bite,
          squareness: 0.9,
          targetMaterial: material,
          part: part(),
        });
        expect(result.damage).toBeLessThanOrEqual(result.energyTransferred + 1e-6);
        expect(result.energyTransferred).toBeLessThanOrEqual(10_000);
      }
    }
  });

  it('conserves the strike: absorbed plus shock never exceeds what was thrown', () => {
    for (const material of MATERIALS) {
      const result = resolveHit({
        energy: 10_000,
        bite: 1,
        squareness: 0.8,
        targetMaterial: material,
        part: part(),
      });
      expect(result.energyTransferred + result.shock).toBeLessThanOrEqual(10_000);
      expect(result.shock).toBeGreaterThan(0);
    }
  });

  it('has no strictly dominant armour material', () => {
    // For each material, how much strike energy the machine survives and how fast
    // it wears the attacker's weapon down. A material that beats every other on
    // both, at no weight cost, would make the armour choice meaningless.
    const rows = MATERIALS.map((material) => {
      const design = makeDefaultDesign();
      design.armorMaterialId = material.id;
      // Thickest legal plate that keeps the build under 14 kg of armour.
      let thickness = 3;
      for (let mm = 3; mm <= 20; mm += 0.5) {
        design.armorThicknessMm = mm;
        if (computeStats(design).armorMass > 14) break;
        thickness = mm;
      }
      design.armorThicknessMm = thickness;
      const stats = computeStats(design);
      const damage = new BotDamage(stats);
      const fraction = transferFraction(0.7, material, 1);
      const panel = damage.get('armor-front')!.maxHp / fraction;
      const frame = stats.frameHp / ((1 - fraction) * SHOCK_COUPLING * material.ductility ** 2);
      return {
        id: material.id,
        mass: stats.armorMass,
        cost: material.costPerKg,
        survives: Math.min(panel, frame),
        wearsWeapon: (1 - fraction) * material.hardness,
      };
    });

    for (const a of rows) {
      const dominated = rows.filter(
        (b) =>
          b.id !== a.id &&
          a.survives >= b.survives &&
          a.wearsWeapon >= b.wearsWeapon &&
          a.mass <= b.mass &&
          a.cost <= b.cost,
      );
      expect(
        dominated.map((b) => b.id),
        `${a.id} is strictly better than ${dominated.map((b) => b.id).join(', ')}`,
      ).toEqual([]);
    }
  });

  it('calls a fight nobody scored in a draw, not a unanimous decision', () => {
    const card = scoreJudges(
      { damage: 0, aggression: 0, control: 0 },
      { damage: 0, aggression: 0, control: 0 },
    );
    expect(card.draw).toBe(true);
    expect(card.unanimous).toBe(false);
  });

  it('still returns a clean unanimous card when one machine wins everything', () => {
    const card = scoreJudges(
      { damage: 9000, aggression: 40, control: 40 },
      { damage: 200, aggression: 4, control: 3 },
    );
    expect(card.draw).toBe(false);
    expect(card.winner).toBe(0);
    expect(card.unanimous).toBe(true);
  });

  it('separates a count-out from a machine that was taken apart', () => {
    const stats = computeStats(makeDefaultDesign());
    const damage = new BotDamage(stats);
    damage.countOut();
    expect(damage.countedOut).toBe(true);
    expect(damage.wrecked, 'a counted-out machine is not a destroyed one').toBe(false);
    expect(damage.isDead).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Arena, hazards and debris
// ---------------------------------------------------------------------------

describe('arena', () => {
  it('raises the killsaws over a quarter second instead of teleporting them', () => {
    const world = new PhysicsWorld();
    const arena = new Arena(world, { headless: true });
    const hazards = (arena as unknown as { hazards: { kind: string; body: any }[] }).hazards;
    const saw = hazards.find((h) => h.kind === 'killsaw')!;
    const home = saw.body.translation().y;

    arena.triggerKillsaws(2);
    let previous = home;
    let biggestStep = 0;
    for (let i = 0; i < Math.round(0.4 / FIXED_DT); i++) {
      arena.update(FIXED_DT);
      world.step();
      const y = saw.body.translation().y;
      biggestStep = Math.max(biggestStep, Math.abs(y - previous));
      previous = y;
    }

    // 620 mm over 250 ms is 2.5 m/s, so one 2 ms step can move at most ~5 mm.
    expect(biggestStep, 'the blade jumped in a single step').toBeLessThan(0.02);
    expect(previous - home, 'the blade never came up').toBeGreaterThan(0.5);
    world.free();
  });

  it('takes real damage off a machine dropped onto a live killsaw', () => {
    const { world, combat, red } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    combat.arena.triggerKillsaws(6);

    const before = red.damage.integrity;
    const chassis = (red as unknown as { chassis: any }).chassis;
    for (let i = 0; i < 8 && red.damage.integrity >= before; i++) {
      chassis.setTranslation({ x: 0, y: 0.5, z: 0 }, true);
      chassis.setLinvel({ x: 0, y: -2, z: 0 }, true);
      run(world, 0.6);
    }
    expect(red.damage.integrity, 'the killsaws did nothing').toBeLessThan(before);
    world.free();
  });

  it('lets debris be hit by a live weapon', () => {
    // Interaction is an AND of both filters, so the weapon layers have to appear
    // on the debris side too.
    const filter = filterOf(DEBRIS_GROUPS);
    expect(filter & Layer.WEAPON_0).toBeTruthy();
    expect(filter & Layer.WEAPON_1).toBeTruthy();
  });

  it('creates debris when a panel is destroyed', () => {
    const { world, combat, red } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    const before = combat.debris.count;
    const panel = red.damage.get('armor-front')!;
    panel.hp = 1;
    (combat as unknown as { destroyPart(bot: Bot, part: unknown, at: THREE.Vector3): void }).destroyPart(
      red,
      panel,
      red.position().clone(),
    );
    run(world, 0.2);
    expect(combat.debris.count, 'a destroyed panel left nothing behind').toBeGreaterThan(before);
    world.free();
  });
});

// ---------------------------------------------------------------------------
// The opponent
// ---------------------------------------------------------------------------

describe('opponent AI', () => {
  for (const difficulty of ['rookie', 'veteran', 'champion'] as Difficulty[]) {
    it(`drives and engages on ${difficulty}`, () => {
      // Both machines carry spinners, so "did it use its weapon" is a question
      // the test can actually ask.
      const { world, combat, red, blue } = fight(
        presetById('sparkplug').design,
        presetById('anvilhead').design,
      );
      const ai = new BotAI(blue, combat.arena, difficulty, 4242);

      const start = blue.position().clone();
      const startSeparation = blue.position().distanceTo(red.position());
      let closest = Infinity;
      let spunUp = 0;
      for (let i = 0; i < Math.round(8 / FIXED_DT); i++) {
        if (i % 8 === 0) blue.setInput(ai.update(FIXED_DT * 8, red));
        world.step();
        closest = Math.min(closest, blue.position().distanceTo(red.position()));
        spunUp = Math.max(spunUp, Math.abs(blue.omega));
      }

      expect(blue.position().distanceTo(start), 'the AI never moved').toBeGreaterThan(0.5);
      expect(closest, 'the AI never closed on its opponent').toBeLessThan(startSeparation * 0.7);
      expect(spunUp, 'the AI never spun its weapon up').toBeGreaterThan(5);
      expect(Number.isFinite(blue.position().y)).toBe(true);
      world.free();
    });
  }
});

// ---------------------------------------------------------------------------
// The builder's own rules
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('can actually reach every warning it defines', () => {
    // A validator whose thresholds sit above anything the catalogue can build is
    // not coverage, it is decoration. Sweep the catalogue and prove each message
    // fires for at least one legal-to-express design.
    const seen = new Set<string>();
    const design = makeDefaultDesign();
    for (const chassisId of ['boxframe', 'lowwedge', 'brick', 'discshell', 'longbed', 'sprinter']) {
      for (const weapon of WEAPONS) {
        for (const material of MATERIALS) {
          for (const thickness of [3, 10, 20]) {
            for (const gear of [6, 20, 40]) {
              const candidate: BotDesign = {
                ...design,
                chassisId,
                weaponId: weapon.id,
                weaponMaterialId: material.id,
                armorMaterialId: material.id,
                armorThicknessMm: thickness,
                gearRatio: gear,
              };
              for (const issue of validateDesign(candidate)) seen.add(issue.message.slice(0, 24));
            }
          }
        }
      }
    }

    const expected = [
      'Gyroscopic forces from t',
      'Spin-up takes',
      'Overweight by',
      'Wildly over-geared for t',
    ];
    for (const prefix of expected) {
      expect(
        [...seen].some((message) => message.startsWith(prefix)),
        `no build in the catalogue can trigger "${prefix}..."`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The show open
// ---------------------------------------------------------------------------

describe('show open', () => {
  interface Call {
    at: number;
    target: string;
    method: string;
    args: unknown[];
  }

  /**
   * Build a start sequence wired to recorders instead of the real audio, lights
   * and camera.
   *
   * The open is a timeline, and a timeline is testable: what has to be true is
   * that the cues fire in the right order, at the right times, and that skipping
   * leaves nothing running. None of that needs a GPU or an audio context, and
   * everything about it used to be untested — the only coverage the show open had
   * was an end-to-end check that *a* card appeared before it was skipped.
   */
  function makeSequence() {
    const calls: Call[] = [];
    let clock = 0;
    const recorder = (target: string): any =>
      new Proxy(
        {},
        {
          get: (_t, method: string) => {
            if (method === 'then') return undefined;
            return (...args: unknown[]) => {
              calls.push({ at: clock, target, method, args });
              return undefined;
            };
          },
        },
      );

    const bot = (name: string): any => ({
      name,
      stats: { totalMass: 100, parts: { weapon: { name: 'Vertical Disc' } } },
      position: (target?: THREE.Vector3) => (target ?? new THREE.Vector3()).set(0, 0.2, 0),
      forward: (target?: THREE.Vector3) => (target ?? new THREE.Vector3()).set(0, 0, 1),
    });

    const sequence = new StartSequence({
      audio: recorder('audio'),
      announcer: recorder('announcer'),
      lights: recorder('lights'),
      camera: recorder('camera'),
      stage: recorder('stage'),
      red: bot('Sparkplug'),
      blue: bot('Anvilhead'),
    });

    const cards: string[] = [];
    sequence.events.on('card', ({ text }) => cards.push(text));
    sequence.events.on('cardClear', () => cards.push('(clear)'));
    let fights = 0;
    sequence.events.on('fight', () => (fights += 1));

    return {
      sequence,
      calls,
      cards,
      get fights() {
        return fights;
      },
      advance(seconds: number) {
        const step = 1 / 60;
        for (let t = 0; t < seconds; t += step) {
          clock += step;
          sequence.update(step);
        }
      },
      at(seconds: number) {
        clock = seconds;
      },
      find(target: string, method: string) {
        return calls.filter((c) => c.target === target && c.method === method);
      },
    };
  }

  it('runs the whole open in order and hands over to the fight exactly once', () => {
    const show = makeSequence();
    show.sequence.start();
    show.advance(30);

    expect(show.cards).toEqual([
      'SPARKPLUG',
      'ANVILHEAD',
      '(clear)',
      '3',
      '2',
      '1',
      'ACTIVATE!',
      '(clear)',
    ]);
    expect(show.fights, 'the fight was started more than once').toBe(1);
    expect(show.sequence.finished).toBe(true);
  });

  it('lights the arena before it counts down, and counts down on the beat', () => {
    const show = makeSequence();
    show.sequence.start();
    show.advance(30);

    const lightsUp = show.find('lights', 'setArena').find((c) => c.args[0] === 1)!;
    const beeps = show.find('audio', 'countdownBeep');
    expect(lightsUp, 'the arena lights never came up').toBeTruthy();
    expect(beeps.length, 'expected 3, 2, 1 and the go tone').toBe(4);
    expect(lightsUp.at).toBeLessThan(beeps[0]!.at);
    // One second between each of 3, 2, 1 and the go tone.
    for (let i = 1; i < beeps.length; i++) {
      expect(beeps[i]!.at - beeps[i - 1]!.at).toBeCloseTo(1, 1);
    }
  });

  it('never leaves the arena dark once the fight is live', () => {
    const show = makeSequence();
    show.sequence.start();
    show.advance(30);
    const arenaLevels = show.find('lights', 'setArena').map((c) => c.args[0]);
    expect(arenaLevels[arenaLevels.length - 1]).toBe(1);
  });

  it('plays a music bed under the introductions, not just after them', () => {
    const show = makeSequence();
    show.sequence.start();
    show.advance(30);
    const started = show.find('audio', 'startMusic')[0];
    const activate = show.find('audio', 'klaxon').slice(-1)[0]!;
    expect(started, 'the open ran with no music at all').toBeTruthy();
    expect(started!.at, 'the music only started once the fight did').toBeLessThan(activate.at - 10);
  });

  it('stops the riser, the strobe and the caption when the open is skipped', () => {
    const show = makeSequence();
    show.sequence.start();
    // Far enough in that the riser is running and the strobe has been fired.
    show.advance(18);
    expect(show.find('audio', 'riser').length).toBe(1);
    expect(show.find('lights', 'strobe').length).toBe(1);

    show.sequence.skip();
    expect(show.find('audio', 'stopRiser').length, 'the riser kept rising').toBeGreaterThan(0);
    expect(show.find('lights', 'stopStrobe').length, 'the strobe kept flashing').toBeGreaterThan(0);
    expect(show.find('announcer', 'cancel').length, 'the caption stayed up').toBeGreaterThan(0);
    expect(show.find('audio', 'startMusic').length).toBeGreaterThan(0);
    expect(show.fights).toBe(1);
  });

  it('cannot start the fight twice by skipping after it has already begun', () => {
    const show = makeSequence();
    show.sequence.start();
    show.advance(30);
    expect(show.fights).toBe(1);
    show.sequence.skip();
    expect(show.fights).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The shared energy currency
// ---------------------------------------------------------------------------

describe('energy conservation', () => {
  it('takes off the rotor exactly what it puts into the target', () => {
    const { world, combat, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );

    let delivered = 0;
    combat.events.on('impact', (impact) => {
      if (impact.kind === 'weapon' && impact.attacker === red) delivered += impact.energy;
    });

    // Spin up, then drive into the opponent for a while.
    red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 6);

    const before = red.weaponEnergy;
    red.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
    blue.setInput({ throttle: -1, steer: 0, weapon: false, fire: false, selfRight: false });
    run(world, 6);
    const spent = before - red.weaponEnergy;

    expect(delivered, 'the weapon never landed a hit').toBeGreaterThan(0);
    // The rotor cannot have paid out less than it delivered. It can legitimately
    // have paid out more — bearing drag and the freewheel are not free.
    expect(spent).toBeGreaterThanOrEqual(delivered * 0.98);
    world.free();
  });
});

// ---------------------------------------------------------------------------
// Fabricated hardware
// ---------------------------------------------------------------------------

describe('bodywork', () => {
  it('cuts the wheel arches out of the side armour instead of burying the tyres', () => {
    const registry = new GeometryRegistry();
    const width = 0.84;
    const arches: [number, number][] = [
      [-0.24, 0.09],
      [0.24, 0.09],
    ];

    const solid = panelGeometry(registry, width, 0.26, 0.008);
    const cut = panelGeometry(registry, width, 0.26, 0.008, arches);

    solid.computeBoundingBox();
    cut.computeBoundingBox();
    // Both still span the full length of the machine — the arches are holes in
    // the middle of the plate, not a shortened plate.
    expect(solid.boundingBox!.max.x).toBeCloseTo(width / 2, 2);
    expect(cut.boundingBox!.max.x).toBeCloseTo(width / 2, 2);

    // ...and no geometry survives inside either arch.
    const position = cut.getAttribute('position');
    for (const [centre, radius] of arches) {
      let inside = 0;
      for (let i = 0; i < position.count; i++) {
        const x = position.getX(i);
        if (Math.abs(x - centre) < radius * 0.6) inside += 1;
      }
      expect(inside, `armour still passes through the wheel at x=${centre}`).toBe(0);
    }

    // A frame with no room between its wheels keeps a solid plate rather than
    // ending up with no armour at all.
    const crowded = panelGeometry(registry, width, 0.26, 0.008, [[0, width]]);
    crowded.computeBoundingBox();
    expect(crowded.boundingBox!.max.x).toBeCloseTo(width / 2, 2);
    registry.dispose();
  });
});
