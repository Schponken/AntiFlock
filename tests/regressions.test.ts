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
import { clamp } from '../src/core/mathx.ts';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { ARENA_HALF, Arena } from '../src/game/arena.ts';
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
  ACCESSORIES,
  CHASSIS,
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

/**
 * Signed heading change over `seconds`, accumulated step by step.
 *
 * Comparing a start and end heading with a cross product reads `sin(theta)`,
 * which wraps: a machine that pivots 207 degrees to its right reports a positive
 * number and looks like a left turn. Combat robots pivot at 4-8 rad/s, so any
 * end-to-end steering measurement over more than a fraction of a second lands in
 * that trap — and it is exactly the trap that produced a wrong conclusion about
 * the drivetrain once already. Accumulate per step and the metric cannot wrap.
 */
function accumulateTurn(world: PhysicsWorld, bot: Bot, seconds: number): number {
  const heading = (): number => {
    const forward = bot.forward();
    return Math.atan2(forward.x, forward.z);
  };
  let previous = heading();
  let total = 0;
  for (let i = 0; i < Math.round(seconds / FIXED_DT); i++) {
    world.step();
    const current = heading();
    let delta = current - previous;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    total += delta;
    previous = current;
  }
  return total;
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

  it('steers the way the key says, on every frame in the catalogue', () => {
    // The machine's own right-hand side is body -X, so a right turn takes the
    // forward vector from +Z towards -X: a negative accumulated heading change.
    for (const preset of PRESETS) {
      for (const steer of [1, -1]) {
        const { world, bot } = solo(preset.design);
        run(world, 1);
        drive(bot, 0, steer);
        const turned = accumulateTurn(world, bot, 1.5);
        if (steer > 0) {
          expect(turned, `${preset.design.name} turned left on a right input`).toBeLessThan(-0.5);
        } else {
          expect(turned, `${preset.design.name} turned right on a left input`).toBeGreaterThan(0.5);
        }
        // A 250 lb machine pivoting faster than about two turns a second is not
        // skid steer, it is a bug. This is what caught the doubled yaw couple.
        expect(Math.abs(turned) / 1.5, `${preset.design.name} pivots implausibly fast`).toBeLessThan(
          13,
        );
        world.free();
      }
    }
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

  it('never accelerates harder than the tyres could hold', () => {
    /*
     * Rapier's raycast vehicle weights the forward impulse by 0.5 in its own
     * friction check, so the effective longitudinal mu is about twice
     * `frictionSlip` and every machine launched at roughly double the Coulomb
     * limit the builder panel quotes — up to 2.8 g on a 250 lb robot.
     */
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const { world, bot } = solo(preset.design);
      run(world, 1.2);
      const start = bot.position().clone();
      drive(bot, 1);

      let travelled = 0;
      let speed = 0;
      for (let i = 0; i < Math.round(3 / FIXED_DT) && speed < 1; i++) {
        world.step();
        speed = bot.speed;
        travelled = bot.position().distanceTo(start);
      }
      expect(speed, `${preset.design.name} never got going`).toBeGreaterThanOrEqual(1);

      // Distance-based, so a single velocity spike cannot flatter it: a = v^2/2s.
      const measured = (speed * speed) / (2 * Math.max(1e-6, travelled));
      const coulomb = stats.parts.wheel.grip * 9.81;
      expect(
        measured,
        `${preset.design.name} out-accelerated its own tyres`,
      ).toBeLessThanOrEqual(Math.min(stats.acceleration, coulomb) * 1.1);
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
    const facing = bot.forward().clone().setY(0).normalize();
    drive(bot, 1);
    run(world, 3);
    const travelled = bot.position().clone().sub(start).setY(0);
    expect(travelled.length(), 'invertible frame is stranded on its back').toBeGreaterThan(0.5);
    // Forward has to mean forward. Asserting distance alone passed just as well
    // with the inverted throttle fully reversed.
    expect(
      travelled.dot(facing),
      'upside-down, the throttle drove it backwards',
    ).toBeGreaterThan(travelled.length() * 0.5);
    expect(bot.inverted, 'it should still be running upside-down, not have flopped over').toBe(
      true,
    );
    world.free();
  });

  it('holds an invertible frame to its advertised top speed upside-down', () => {
    // Back-EMF is measured at the wheel, and the wheel's forward reverses with the
    // suspension ray. Miss that and the motor sits on its current limit at every
    // speed: measured, 1.7x the quoted top speed with no fade at all.
    const design = presetById('anvilhead').design;
    const stats = computeStats(design);
    const { world, bot } = solo(design);
    run(world, 1);
    flip(bot, world, stats.parts.chassis.height);
    expect(bot.inverted).toBe(true);

    drive(bot, 1);
    let peak = 0;
    for (let i = 0; i < Math.round(4 / FIXED_DT); i++) {
      world.step();
      peak = Math.max(peak, bot.speed);
    }
    expect(peak, 'inverted machine ran past its own spec sheet').toBeLessThanOrEqual(
      stats.topSpeed * 1.08,
    );
    world.free();
  });

  it('drives after the chassis has been asleep', () => {
    // Rapier's vehicle controller writes velocity onto a sleeping body without
    // waking it, so the machine accumulates speed it never acts on. Two seconds
    // of stillness was enough: 0.00 m travelled while the readout claimed 64 mph.
    // Doorstop is a fixed wedge: no weapon body on a joint to keep it awake, so it
    // genuinely settles, which is the state this is about.
    const { world, bot } = solo(presetById('doorstop').design);
    run(world, 4);
    expect(
      (bot as unknown as { chassis: { isSleeping(): boolean } }).chassis.isSleeping(),
      'the chassis never went to sleep, so this test proves nothing',
    ).toBe(true);

    const start = bot.position().clone();
    drive(bot, 1);
    run(world, 2.5);
    const moved = bot.position().distanceTo(start);
    expect(moved, 'a sleeping machine ignored the throttle').toBeGreaterThan(1);
    // ...and the reported speed has to match the ground it actually covered.
    expect(bot.speed).toBeLessThan((moved / 2.5) * 3);
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

      drive(bot, 0, steer);
      const turned = accumulateTurn(world, bot, 1.5);

      // Same sign convention as the right-way-up test: right is negative.
      if (steer > 0) expect(turned, 'inverted right turn went left').toBeLessThan(-0.1);
      else expect(turned, 'inverted left turn went right').toBeGreaterThan(0.1);
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

  it('lands a pulveriser on a machine parked under it', () => {
    /*
     * The arm used to hang straight down and *lift* when fired, so its lowest
     * point over the whole arc was 694 mm — while the tallest frame in the
     * catalogue tops out at 400 mm. It could not touch anything in the game. A
     * pulveriser parks cocked against its own wall and slams down.
     */
    for (const side of [-1, 1] as const) {
      /*
       * One machine, and a fixed wedge at that: no weapon body on a joint, so
       * parking it by moving the chassis does not leave a stretched joint that
       * flings it back across the arena before the arm ever comes down.
       */
      const { world, combat, bot } = solo(presetById('doorstop').design);
      // Park it under the arm's actual pivot rather than a copy of the constant.
      const pivot = (
        combat.arena as unknown as { hazards: { kind: string; home: THREE.Vector3 }[] }
      ).hazards.find((h) => h.kind === 'pulverizer' && Math.sign(h.home.z) === side)!.home;
      const chassis = (bot as unknown as { chassis: any }).chassis;
      chassis.setTranslation({ x: pivot.x, y: 0.2, z: pivot.z }, true);
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      run(world, 1);
      expect(
        Math.hypot(bot.position().x - pivot.x, bot.position().z - pivot.z),
        'the machine did not stay parked under the arm',
      ).toBeLessThan(0.5);

      const before = bot.damage.integrity;
      combat.arena.triggerPulverizer(side);
      run(world, 4);
      expect(
        bot.damage.integrity,
        `the ${side < 0 ? 'near' : 'far'} pulveriser could not reach the floor`,
      ).toBeLessThan(before);
      world.free();
    }
  });

  it('never swings a pulveriser out through the arena wall', () => {
    const world = new PhysicsWorld();
    const arena = new Arena(world, { headless: true });
    const hazards = (arena as unknown as { hazards: { kind: string; body: any; home: any }[] })
      .hazards;

    for (const side of [-1, 1] as const) {
      arena.triggerPulverizer(side);
      let worst = 0;
      for (let i = 0; i < Math.round(3 / FIXED_DT); i++) {
        arena.update(FIXED_DT);
        world.step();
        for (const hazard of hazards) {
          if (hazard.kind !== 'pulverizer') continue;
          // Furthest the arm's tip reaches, in the direction of its own wall.
          const rotation = hazard.body.rotation();
          const q = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w);
          const tip = new THREE.Vector3(0, -1.22, 0).applyQuaternion(q);
          const z = hazard.body.translation().z + tip.z;
          worst = Math.max(worst, Math.abs(z));
        }
      }
      expect(worst, 'a pulveriser arm reached past the inner wall face').toBeLessThan(ARENA_HALF);
      run(world, 4);
    }
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
// Accessories that the simulation can actually see
// ---------------------------------------------------------------------------

describe('accessories', () => {
  it('gives the gyro compensator a real effect on the machine', () => {
    /*
     * `gyroPenalty` was written into the stats and read by nothing but its own
     * validation warning — the lean comes out of the rotor's inertia tensor, which
     * knows nothing about accessories — so 3.8 kg bought a number on a panel.
     */
    const base = {
      ...makeDefaultDesign(),
      chassisId: 'lowwedge',
      weaponId: 'undercutter',
      weaponMaterialId: 'ar500',
      armorThicknessMm: 5,
    };

    const lean = (accessories: BotDesign['accessories']): number => {
      const { world, bot } = solo({ ...base, accessories });
      bot.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 8);
      bot.setInput({ throttle: 1, steer: 1, weapon: true, fire: false, selfRight: false });
      let worst = 0;
      for (let i = 0; i < Math.round(5 / FIXED_DT); i++) {
        world.step();
        worst = Math.max(worst, Math.acos(clamp(bot.up().y, -1, 1)));
      }
      world.free();
      return (worst * 180) / Math.PI;
    };

    const without = lean([]);
    const withIt = lean(['antispin']);
    expect(without, 'a big horizontal rotor should lean the machine in a turn').toBeGreaterThan(5);
    // A counter-rotating mass cancels most of the reaction, not all of it, and the
    // rest of the lean is ordinary weight transfer that no compensator can touch.
    expect(withIt, 'the compensator did not reduce the lean').toBeLessThan(without * 0.85);
    expect(without - withIt, 'the reduction is inside the noise').toBeGreaterThan(1);
  });

  it('gives armoured skirts and hinged wedgelets something the solver can see', () => {
    const base = { ...makeDefaultDesign(), chassisId: 'boxframe', weaponId: 'wedge' };

    const colliders = (accessories: BotDesign['accessories']): number => {
      const { world, bot } = solo({ ...base, accessories });
      const count = (bot as unknown as { chassis: { numColliders(): number } }).chassis.numColliders();
      world.free();
      return count;
    };

    // Wedgelets are two real ramps, not two meshes.
    expect(colliders(['wedgelets'])).toBeGreaterThan(colliders([]));

    // Skirts change where a low side hit lands: they exist to keep weapons out of
    // the wheels, and the damage model now knows it.
    const stats = computeStats({ ...base, accessories: ['skirts'] });
    expect(stats.parts.accessories).toContain('skirts');
    expect(stats.totalMass).toBeGreaterThan(computeStats({ ...base, accessories: [] }).totalMass);
  });

  it('offers no meaningless rotor-material choice', () => {
    // For a weapon with no rotor, every material used to produce a byte-identical
    // build. The builder now hides the picker; this pins the fact behind it.
    for (const weapon of WEAPONS) {
      if (weapon.rotor) continue;
      const first = computeStats({
        ...makeDefaultDesign(),
        chassisId: 'boxframe',
        weaponId: weapon.id,
        weaponMaterialId: MATERIALS[0]!.id,
      });
      for (const material of MATERIALS.slice(1)) {
        const other = computeStats({
          ...makeDefaultDesign(),
          chassisId: 'boxframe',
          weaponId: weapon.id,
          weaponMaterialId: material.id,
        });
        expect(other.totalMass).toBeCloseTo(first.totalMass, 9);
      }
    }
  });
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
  it('charges the rotor per strike, above and beyond bearing drag', () => {
    /*
     * The whole-fight version below is satisfied by drag alone: a freewheeling
     * rotor loses energy anyway, so "paid out at least what it delivered" stays
     * true with the bleed deleted entirely. Sample the rotor either side of each
     * individual impact instead, and the drag over a couple of milliseconds is
     * negligible against the strike.
     */
    const { world, combat, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );

    let sampled = 0;
    let delivered = 0;
    let paid = 0;
    let before = 0;
    combat.events.on('impact', (impact) => {
      if (impact.kind !== 'weapon' || impact.attacker !== red) return;
      // `impact` is emitted after the bleed, so `before` is last frame's reading.
      sampled += 1;
      delivered += impact.energy;
      paid += Math.max(0, before - red.weaponEnergy);
    });

    red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 6);
    red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
    blue.setInput({ throttle: -1, steer: 0, weapon: false, fire: false, selfRight: false });
    for (let i = 0; i < Math.round(12 / FIXED_DT); i++) {
      before = red.weaponEnergy;
      world.step();
    }

    expect(sampled, 'the weapon never landed a hit').toBeGreaterThan(0);
    // Per strike, the rotor pays for what it delivered. Drag over one 2 ms step is
    // worth a few joules against strikes worth thousands.
    expect(paid).toBeGreaterThan(delivered * 0.9);
    world.free();
  });

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

  it('charges the rotor for the shock it drove through the armour, not just the panel', () => {
    /*
     * Directly on the damage model, because the fight version above cannot see
     * this: bearing drag alone satisfies "paid out at least what it delivered",
     * so removing the shock term entirely would leave that test green. Plastic is
     * the case that matters — a ductile panel refuses most of the strike and hands
     * it to the frame, and it was that share nobody was ever charged for.
     */
    const design = makeDefaultDesign();
    design.armorMaterialId = 'uhmw';
    const stats = computeStats(design);
    const damage = new BotDamage(stats);
    const panel = damage.get('armor-front')!;
    const frameBefore = damage.get('frame')!.hp;

    const result = damage.hit({
      energy: 20_000,
      bite: 1,
      squareness: 0.85,
      targetMaterial: stats.parts.armor,
      part: panel,
    });

    expect(result.shockConsumed, 'no shock reached the frame').toBeGreaterThan(0);
    expect(result.shockConsumed).toBeCloseTo(frameBefore - damage.get('frame')!.hp, 6);
    // Everything the strike did to the machine, and nothing it did not do.
    const inflicted = result.damage + result.shockConsumed;
    expect(inflicted).toBeGreaterThan(result.damage);
    expect(inflicted).toBeLessThanOrEqual(20_000);
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

// ---------------------------------------------------------------------------
// Coverage the mutation sweep proved was missing
// ---------------------------------------------------------------------------

describe('every accessory changes something', () => {
  /*
   * Each of these could be turned into a no-op with the whole suite green. One
   * assertion per accessory, on the specific quantity it is sold on.
   */
  const base = (): BotDesign => ({
    ...makeDefaultDesign(),
    chassisId: 'lowwedge',
    weaponId: 'undercutter',
    weaponMaterialId: 'ar500',
  });
  const withAccessory = (id: BotDesign['accessories'][number]) =>
    computeStats({ ...base(), accessories: [id] });
  const plain = () => computeStats({ ...base(), accessories: [] });

  it('ablative plating buys armour hit points', () => {
    expect(withAccessory('ablative').armorHp).toBeGreaterThan(plain().armorHp * 1.1);
  });

  it('the big battery spins the weapon up faster and charges an actuator harder', () => {
    expect(withAccessory('bigbattery').weaponSpinupTime).toBeLessThan(plain().weaponSpinupTime);
    const flipper = { ...base(), chassisId: 'boxframe', weaponId: 'flipper' };
    expect(computeStats({ ...flipper, accessories: ['bigbattery'] }).actuatorEnergy).toBeGreaterThan(
      computeStats({ ...flipper, accessories: [] }).actuatorEnergy,
    );
  });

  it('the gyro compensator cuts the gyroscopic penalty', () => {
    expect(withAccessory('antispin').gyroPenalty).toBeLessThan(plain().gyroPenalty * 0.5);
    expect(withAccessory('antispin').gyroCompensation).toBeGreaterThan(0);
  });

  it('every accessory costs weight, so none of them is free', () => {
    for (const accessory of ACCESSORIES) {
      expect(
        withAccessory(accessory.id).totalMass,
        `${accessory.name} weighs nothing`,
      ).toBeGreaterThan(plain().totalMass);
    }
  });
});

describe('damage bookkeeping', () => {
  it('binds the drivetrain as the frame folds', () => {
    const stats = computeStats(makeDefaultDesign());
    const damage = new BotDamage(stats);
    const healthy = damage.mobility;
    expect(healthy).toBeCloseTo(1, 6);

    const frame = damage.get('frame')!;
    frame.hp = frame.maxHp * 0.5;
    expect(damage.mobility, 'a half-folded frame drove exactly as well').toBeLessThan(healthy);
    // ...but never to zero on frame damage alone: a bent frame is not a knockout.
    frame.hp = 1;
    expect(damage.mobility).toBeGreaterThan(0);
  });

  it('blunts a weapon on a hard target and eventually kills it', () => {
    const stats = computeStats(makeDefaultDesign());
    const damage = new BotDamage(stats);
    const weapon = damage.get('weapon')!;
    const full = damage.weaponCondition;
    expect(full).toBeCloseTo(1, 6);

    damage.wearWeapon(weapon.maxHp * 0.4);
    expect(damage.weaponCondition).toBeCloseTo(0.6, 3);

    damage.wearWeapon(weapon.maxHp);
    expect(damage.weaponCondition).toBe(0);
    expect(weapon.destroyed).toBe(true);

    // A dead weapon cannot be worn any further.
    damage.wearWeapon(1000);
    expect(weapon.hp).toBe(0);
  });
});

describe('shoving and hazards', () => {
  it('counts a hard ram as damage and credits the machine that did it', () => {
    const { world, combat, red, blue } = fight(
      presetById('doorstop').design,
      presetById('doorstop').design,
    );

    const kinds: string[] = [];
    combat.events.on('impact', (impact) => kinds.push(impact.kind));

    // Nose to nose, then drive them into each other.
    const put = (bot: Bot, z: number, facing: number): void => {
      const chassis = (bot as unknown as { chassis: any }).chassis;
      chassis.setTranslation({ x: 0, y: 0.2, z }, true);
      chassis.setRotation({ x: 0, y: Math.sin(facing / 2), z: 0, w: Math.cos(facing / 2) }, true);
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    };
    put(red, -3, 0);
    put(blue, 3, Math.PI);
    run(world, 0.5);

    red.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
    blue.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
    run(world, 6);

    expect(kinds, 'two machines met head-on and nothing registered').toContain('ram');
    expect(red.damageDealt + blue.damageDealt, 'ramming was worth nothing').toBeGreaterThan(0);
    world.free();
  });

  it('rate-limits repeated strikes on the same pair', () => {
    // Without the cooldown a sustained contact bills a hit every physics step —
    // 480 a second — instead of one per tooth pass.
    const { world, combat, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    let weaponHits = 0;
    combat.events.on('impact', (impact) => {
      if (impact.kind === 'weapon') weaponHits += 1;
    });

    red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 6);
    red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
    blue.setInput({ throttle: -1, steer: 0, weapon: false, fire: false, selfRight: false });
    const seconds = 10;
    run(world, seconds);

    expect(weaponHits, 'the weapon never landed').toBeGreaterThan(0);
    expect(weaponHits, 'strikes were billed per step, not per tooth').toBeLessThan(seconds / 0.075);
    world.free();
  });
});

describe('horizontal spinners', () => {
  it('sweeps at a height that reaches every frame in the catalogue', () => {
    /*
     * `discshell` is the only chassis that mounts a horizontal spinner or an
     * undercutter, and its weapon mount put the blade in a 30 mm band at 0.295 to
     * 0.325 m — above the top of three of the six hulls it has to reach. The only
     * frame that carries these two weapons could not touch anything with them.
     *
     * Checked geometrically because it is a geometric contract, and because a
     * driving encounter between two spinners is a standoff rather than a hit.
     */
    const discshell = CHASSIS.find((c) => c.id === 'discshell')!;
    const rideHeight = discshell.height / 2 + discshell.groundClearance;

    for (const weaponId of ['horiz-bar', 'undercutter']) {
      const rotor = weaponById(weaponId).rotor!;
      expect(rotor.axis).toBe('y');
      const bladeLow = rideHeight + discshell.weaponMount.y - rotor.thickness / 2;
      const bladeHigh = rideHeight + discshell.weaponMount.y + rotor.thickness / 2;

      // Clear of the floor, or it grounds out the moment the machine pitches.
      expect(bladeLow, `${weaponId} sweeps into the floor`).toBeGreaterThan(0.05);

      for (const target of CHASSIS) {
        const hullLow = target.groundClearance;
        const hullHigh = target.groundClearance + target.height;
        expect(
          bladeHigh > hullLow && bladeLow < hullHigh,
          `${weaponId} sweeps clean past a ${target.name} without touching it`,
        ).toBe(true);
      }
    }
  });

  it('actually damages the frames it is swept at', () => {
    /*
     * The geometric check above is the general contract, and it covers all six
     * frames. This one is the live confirmation on the four where a straight
     * head-on run reliably lines the blade up: `sprinter` closes fast enough that
     * the two hulls meet before the blade sweeps through, and `discshell` against
     * itself is two spinners holding each other off, which is what should happen.
     */
    for (const chassisId of ['boxframe', 'lowwedge', 'brick', 'longbed']) {
      const { world, combat, red, blue } = fight(
        {
          ...makeDefaultDesign(),
          chassisId: 'discshell',
          weaponId: 'undercutter',
          weaponMaterialId: 'ar500',
          armorThicknessMm: 4,
        },
        { ...makeDefaultDesign(), chassisId, weaponId: 'wedge', armorThicknessMm: 4 },
      );

      // Count the blade's own strikes: integrity alone cannot tell a tooth landing
      // from the pair of them scraping down a wall on the way past.
      let strikes = 0;
      combat.events.on('impact', (impact) => {
        if (impact.kind === 'weapon' && impact.attacker === red) strikes += 1;
      });

      red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 6);

      // Park the target a metre in front, rather than driving the length of the
      // arena and hoping the two happen to line up.
      red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
      blue.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
      run(world, 16);

      expect(strikes, `an undercutter never landed on a ${chassisId}`).toBeGreaterThan(0);
      world.free();
    }
  });
});

describe('judging', () => {
  it('does not pay a machine for running away', () => {
    /*
     * Aggression used to be `throttle * speed` with no opponent anywhere in the
     * expression, so fleeing at full throttle scored for fleeing, and control was
     * a constant `dt * 0.05` for any machine that stayed upright — a guaranteed
     * dead heat in a category worth three of the eleven points.
     */
    const { world, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
    blue.setInput({ throttle: -1, steer: 0, weapon: false, fire: false, selfRight: false });
    run(world, 25);

    expect(red.aggression, 'the machine that closed scored nothing').toBeGreaterThan(0.5);
    expect(blue.aggression, 'the machine that fled was paid for fleeing').toBeLessThan(
      red.aggression * 0.2,
    );
    world.free();
  });

  it('pays nobody for sitting in a corner on their own', () => {
    const { world, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    // Neither machine does anything at all.
    run(world, 20);
    expect(red.aggression).toBe(0);
    expect(red.control, 'control accrued without ever meeting the opponent').toBe(0);
    expect(blue.aggression).toBe(0);
    expect(blue.control).toBe(0);
    world.free();
  });
});

describe('opponent AI behaviour', () => {
  it('deploys the srimech when it is upside-down', () => {
    const design = makeDefaultDesign();
    design.chassisId = 'boxframe';
    design.weaponId = 'wedge';
    design.accessories = ['srimech'];
    const stats = computeStats(design);
    const { world, combat, bot } = solo(design);
    const ai = new BotAI(bot, combat.arena, 'veteran', 99);
    run(world, 1);

    const chassis = (bot as unknown as { chassis: any }).chassis;
    chassis.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
    chassis.setTranslation({ x: 0, y: stats.parts.chassis.height / 2 + 0.02, z: 0 }, true);
    chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    run(world, 1.2);
    expect(bot.inverted).toBe(true);

    let askedToSelfRight = false;
    for (let i = 0; i < 120 && !askedToSelfRight; i++) {
      const input = ai.update(1 / 60, null);
      askedToSelfRight = input.selfRight;
      for (let s = 0; s < 8; s++) world.step();
    }
    expect(askedToSelfRight, 'the AI never tried to right itself').toBe(true);
    expect(ai.currentState).toBe('recover');
    world.free();
  });

  it('backs out when it has been shoved into a wall and is going nowhere', () => {
    const { world, combat, red, blue } = fight(
      presetById('doorstop').design,
      presetById('doorstop').design,
    );
    const ai = new BotAI(blue, combat.arena, 'champion', 7);

    // Nose into the wall, then hold the throttle down against it.
    const chassis = (blue as unknown as { chassis: any }).chassis;
    chassis.setTranslation({ x: 0, y: 0.2, z: ARENA_HALF - 0.6 }, true);
    chassis.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    run(world, 0.5);

    let reversed = false;
    for (let i = 0; i < 400 && !reversed; i++) {
      const input = ai.update(1 / 60, red);
      blue.setInput(input);
      if (input.throttle < -0.1) reversed = true;
      for (let s = 0; s < 8; s++) world.step();
    }
    expect(reversed, 'the AI pushed at a wall forever').toBe(true);
    world.free();
  });
});
