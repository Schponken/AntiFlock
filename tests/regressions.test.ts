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
import { clamp, kgToLb, mpsToMph } from '../src/core/mathx.ts';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { ARENA_HALF, Arena, WALL_HEIGHT } from '../src/game/arena.ts';
import { BotAI, type Difficulty } from '../src/game/ai.ts';
import {
  PRESETS,
  computeStats,
  makeDefaultDesign,
  DRIVETRAIN_EFFICIENCY,
  GEAR_RATIO_RANGE,
  MIN_THERMAL_DERATE,
  MOTOR_DERATE_FROM,
  presetById,
  validateDesign,
  type BotDesign,
} from '../src/game/design.ts';
import {
  ACCESSORIES,
  CHASSIS,
  DRIVE_MOTORS,
  chassisById,
  MATERIALS,
  WEAPONS,
  WHEELS,
  driveLayout,
  materialById,
  rotorInertiaTensor,
  weaponById,
  weaponMountFor,
  type AccessoryEffect,
} from '../src/game/parts.ts';
import {
  BotDamage,
  NOMINAL_PLATE_MM,
  SHOCK_COUPLING,
  plateStiffness,
  resolveHit,
  scoreJudges,
  transferFraction,
} from '../src/game/damage.ts';
import { DEBRIS_GROUPS, Layer, filterOf } from '../src/physics/groups.ts';
import { HIT_COOLDOWN } from '../src/game/combat.ts';
import type { Bot } from '../src/game/bot.ts';
import { StartSequence } from '../src/game/startSequence.ts';
import { panelGeometry, wedgeDimensions } from '../src/render/botMesh.ts';
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
          plateThicknessMm: NOMINAL_PLATE_MM,
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
        plateThicknessMm: NOMINAL_PLATE_MM,
        part: part(),
      });
      expect(result.energyTransferred + result.shock).toBeLessThanOrEqual(10_000);
      expect(result.shock).toBeGreaterThan(0);
    }
  });

  it('has no strictly dominant armour material', () => {
    /*
     * For each material: how much strike energy the machine survives, how fast it
     * wears the attacker's weapon down, what it weighs, and how well it holds the
     * floor. A material that beats every other on all four would make the armour
     * choice meaningless.
     *
     * `costPerKg` used to be one of the axes, and it should not have been: nothing
     * in the game spends money — there is no budget, the build cost is a readout —
     * so a material could be dead on every axis the simulation reads and the test
     * would still pass on the strength of a price tag. Dropping it exposed two
     * entries that were strictly worse than another plate in every way that
     * reaches the solver. Floor friction replaces it: that one really does decide
     * push matches, and it is why UHMW is worth its slipperiness.
     *
     * The comparison is at equal plate thickness, which is the one the builder's
     * own controls present: you pick a material and a thickness and the weight
     * follows. Comparing at equal armour *mass* instead pins the mass axis to the
     * budget by construction, so it degenerates to a three-axis test that a
     * premium material is entitled to win — titanium beats carbon on everything
     * once you have already agreed to spend the same 14 kg on both, which says
     * nothing about whether carbon is worth building.
     */
    const table = (thickness: number) =>
      MATERIALS.map((material) => {
        const design = makeDefaultDesign();
        design.armorMaterialId = material.id;
        design.armorCoverage = 1;
        design.armorThicknessMm = thickness;
        const stats = computeStats(design);
        const damage = new BotDamage(stats);
        const fraction = transferFraction(0.7, material, 1);
        const panel = damage.get('armor-front')!.maxHp / fraction;
        const frame =
          stats.frameHp /
          ((1 - fraction) *
            SHOCK_COUPLING *
            material.ductility ** 2 *
            plateStiffness(thickness));
        return {
          id: material.id,
          mass: stats.armorMass,
          grip: material.friction,
          survives: Math.min(panel, frame),
          wearsWeapon: (1 - fraction) * material.hardness,
        };
      });

    const rows = table(10);
    for (const a of rows) {
      const dominated = rows.filter(
        (b) =>
          b.id !== a.id &&
          a.survives >= b.survives &&
          a.wearsWeapon >= b.wearsWeapon &&
          a.mass <= b.mass &&
          a.grip >= b.grip,
      );
      expect(
        dominated.map((b) => b.id),
        `${a.id} is strictly better than ${dominated.map((b) => b.id).join(', ')}`,
      ).toEqual([]);
    }

    // And the weight spread across the catalogue has to be big enough that the
    // choice is a real one: the heaviest plate is several times the lightest.
    const masses = rows.map((r) => r.mass);
    expect(Math.max(...masses) / Math.min(...masses)).toBeGreaterThan(4);
  });

  it('has no strictly dominant drive motor', () => {
    /*
     * The first version of this test scored motors on `stallTorque * 40` — peak
     * wheel torque across the gear slider — and that is an axis the drivetrain
     * throws away. `updateDrive` caps every wheel at `mu*m*g / wheelsDown`, and at
     * any usable gear ratio every motor in the catalogue is already far past that
     * cap: an Ironhide at 20:1 asks for 2218 N against a 319 N budget. So the test
     * certified a difference the solver could not express, and the catalogue
     * change made to satisfy it changed nothing about how a machine drives.
     *
     * What the solver actually reads is the motor *curve*: available force is
     * `F0 * (1 - v/v_free)`, so two things separate motors — the speed they still
     * pull at, and what they cost in amps and in heat to get it. Matching top
     * speed by gearing (`g_H/g_I = 12800/3100`) leaves the Hyperion making 1.43x
     * the Ironhide's force at lower mass, which is why torque and speed alone can
     * never make the Ironhide a live choice. Power draw and heat can.
     */
    const rows = DRIVE_MOTORS.map((motor) => {
      const design = { ...makeDefaultDesign(), motorId: motor.id };
      const stats = computeStats(design);
      const wheelRadius = stats.parts.wheel.radius;
      return {
        id: motor.id,
        mass: motor.mass,
        // Fastest the machine can be geared to go, and the force it still makes
        // at half that speed — the two ends of the curve the solver integrates.
        topSpeed: ((motor.freeRpm / GEAR_RATIO_RANGE.min / 60) * 2 * Math.PI * wheelRadius),
        forceAtCruise:
          ((motor.stallTorque * GEAR_RATIO_RANGE.min * DRIVETRAIN_EFFICIENCY) / wheelRadius) * 0.5,
        // Amps are a budget: what is left of the pack for the weapon.
        packHeadroom: -stats.driveDrawWatts,
        // And heat is the other one: how long it can sit in a shove at full stall
        // before it starts derating, in seconds.
        shoveSeconds: stats.driveThermalJoules / stats.driveDrawWatts,
      };
    });

    for (const a of rows) {
      const dominated = rows.filter(
        (b) =>
          b.id !== a.id &&
          a.topSpeed >= b.topSpeed &&
          a.forceAtCruise >= b.forceAtCruise &&
          a.packHeadroom >= b.packHeadroom &&
          a.shoveSeconds >= b.shoveSeconds &&
          a.mass <= b.mass,
      );
      expect(
        dominated.map((b) => b.id),
        `${a.id} is strictly better than ${dominated.map((b) => b.id).join(', ')}`,
      ).toEqual([]);
    }

    // And the axis that saves the slow motor has to be a real spread, not a
    // rounding difference: the Ironhide has to out-shove the Hyperion clearly.
    const shove = (id: string): number => rows.find((r) => r.id === id)!.shoveSeconds;
    expect(
      shove('ironhide') / shove('hyperion'),
      'the torque motor does not last meaningfully longer in a shove',
    ).toBeGreaterThan(1.5);
  });

  it('makes the pack a budget the weapon and the drive have to share', () => {
    /*
     * `MotorSpec.drawWatts` and `rotor.motorWatts` were both documented as the
     * load a part puts on the battery, and nothing read either — so the thirstiest
     * drive motor in the catalogue was free to fit, and the Extended Battery
     * bought a flat 28% on spin-up whatever else was drawing.
     */
    const withMotor = (motorId: string, weaponId: string, accessories: AccessoryEffect[] = []) =>
      computeStats({ ...makeDefaultDesign(), motorId, weaponId, accessories });

    const thirsty = withMotor('hyperion', 'vert-disc');
    const frugal = withMotor('ironhide', 'vert-disc');
    expect(thirsty.driveDrawWatts, 'the fast motor costs no more amps').toBeGreaterThan(
      frugal.driveDrawWatts,
    );
    expect(thirsty.weaponDrawWatts, 'a spinner draws nothing from the pack').toBeGreaterThan(0);

    // Spinning up while driving flat out has to be over budget for the thirsty
    // build and inside it for the frugal one, or the choice is not a choice.
    expect(
      thirsty.driveDrawWatts + thirsty.weaponDrawWatts,
      'the thirstiest build never troubles the pack',
    ).toBeGreaterThan(thirsty.packWatts);

    // And the Extended Battery has to buy real headroom, not a magic number.
    const bigger = withMotor('hyperion', 'vert-disc', ['bigbattery']);
    expect(bigger.packWatts, 'the Extended Battery adds no watts').toBeGreaterThan(
      thirsty.packWatts,
    );

    // A wedge draws nothing; a crusher runs a pump and does. `closeTime` was
    // otherwise a dead field on the clamp spec.
    expect(computeStats({ ...makeDefaultDesign(), weaponId: 'wedge' }).weaponDrawWatts).toBe(0);
    expect(
      computeStats({ ...makeDefaultDesign(), weaponId: 'crusher' }).weaponDrawWatts,
      'a hydraulic crusher draws nothing from the pack',
    ).toBeGreaterThan(500);
  });

  it('heats the drive motors on load and cools them again', () => {
    /*
     * The AF-550's blurb has always said it "cooks itself in a long push match"
     * and nothing in the game could make that true. Heat goes as current squared,
     * and current is set by back-EMF — so a wheel held near zero speed at full
     * throttle is the case that burns a motor, whatever the tyre can transmit.
     *
     * What is asserted here is the wiring and the direction, not a particular
     * temperature: pinning a chassis still enough to hold a clean stall means
     * fighting the vehicle controller every step, and a number measured against
     * that fight would be pinning the harness rather than the model. The size of
     * the effect is pinned from the catalogue in the motor-dominance test above,
     * where it is exact.
     */
    const { world, bot } = solo({ ...presetById('doorstop').design, motorId: 'hyperion' });
    run(world, 0.5);
    expect(bot.motorTemp, 'the machine started the fight already hot').toBe(0);

    drive(bot, 1);
    run(world, 12);
    const hot = bot.motorTemp;
    expect(hot, 'driving did not warm the motors at all').toBeGreaterThan(0.01);

    drive(bot, 0);
    run(world, 40);
    expect(bot.motorTemp, 'the motors never cooled off').toBeLessThan(hot);
    world.free();
  });

  it('makes a cooked motor and a sagging pack actually slow the machine down', () => {
    /*
     * Heat and amps are only worth modelling if they reach the wheels. Deleting
     * `* this.packSag * this.thermalDerate()` from the commanded force left every
     * other test in this file green — the temperature still rose, the derate curve
     * still returned the right number, and the machine drove exactly as fast as
     * before. This is the test that fails when the multiplication goes away.
     */
    const distance = (bake: boolean): number => {
      const { world, bot } = solo({ ...presetById('doorstop').design, motorId: 'hyperion' });
      run(world, 1);
      const inner = bot as unknown as { motorHeat: number };
      const start = bot.position(new THREE.Vector3());
      drive(bot, 1);
      for (let i = 0; i < Math.round(2.5 / FIXED_DT); i++) {
        // Hold it cooked: the thermal integrator would otherwise pull it back
        // toward whatever this run's own duty cycle produces.
        if (bake) inner.motorHeat = 1;
        world.step();
      }
      const travelled = bot.position(new THREE.Vector3()).sub(start).length();
      world.free();
      return travelled;
    };

    const cold = distance(false);
    const cooked = distance(true);
    expect(cold, 'the cold machine never moved').toBeGreaterThan(0.5);
    expect(cooked, 'a fully cooked motor drove just as far as a cold one').toBeLessThan(
      cold * 0.92,
    );

    /*
     * And the pack: the same machine, spinning up a big disc while driving flat
     * out, against the same machine carrying the Extended Battery. The only
     * difference between the two builds is watts.
     */
    const sprint = (accessories: AccessoryEffect[]): number => {
      const design = {
        ...presetById('doorstop').design,
        motorId: 'hyperion',
        weaponId: 'vert-disc',
        accessories,
      };
      const { world, bot } = solo(design);
      run(world, 1);
      const start = bot.position(new THREE.Vector3());
      // Weapon on *and* full throttle: the case the pack cannot cover.
      bot.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 2.5);
      const travelled = bot.position(new THREE.Vector3()).sub(start).length();
      world.free();
      return travelled;
    };

    const stock = sprint([]);
    const bigPack = sprint(['bigbattery']);
    expect(stock, 'the machine never moved').toBeGreaterThan(0.3);
    expect(
      bigPack,
      'the Extended Battery bought nothing while the weapon was spinning up',
    ).toBeGreaterThan(stock * 1.02);
  });

  it('derates a drive motor that has cooked, and never past the floor', () => {
    // The derate curve itself, which is what the heat is *for*.
    const { world, bot } = solo(presetById('doorstop').design);
    run(world, 0.5);
    const inner = bot as unknown as { motorHeat: number; thermalDerate(): number };

    inner.motorHeat = 0;
    expect(inner.thermalDerate(), 'a cold motor was already derated').toBe(1);
    inner.motorHeat = MOTOR_DERATE_FROM;
    expect(inner.thermalDerate(), 'derating started before the threshold').toBe(1);
    inner.motorHeat = (MOTOR_DERATE_FROM + 1) / 2;
    const half = inner.thermalDerate();
    expect(half, 'a half-cooked motor was not derated').toBeLessThan(1);
    expect(half).toBeGreaterThan(MIN_THERMAL_DERATE);
    inner.motorHeat = 1;
    expect(inner.thermalDerate(), 'a cooked motor did not reach the floor').toBeCloseTo(
      MIN_THERMAL_DERATE,
      6,
    );
    // A cooked motor is a slow machine, not a dead one.
    expect(MIN_THERMAL_DERATE).toBeGreaterThan(0.2);
    world.free();
  });

  it('has no strictly dominant wheel', () => {
    /*
     * Radius is not an axis on its own: the gear slider buys speed on any wheel, so
     * a taller tyre only earns its weight through grip, through surviving hits, or
     * through the one thing gearing cannot do — clearing the shell so the machine
     * can drive upside down. The Big Roller failed on all three at once (lower grip
     * *and* lower toughness *and* 0.7 kg more than the Solid Rubber Lug), leaving
     * it a strictly worse tyre on every frame that was already invertible.
     */
    const rows = WHEELS.map((wheel) => ({
      id: wheel.id,
      mass: wheel.mass,
      grip: wheel.grip,
      toughness: wheel.toughness,
      // Frames this wheel makes drivable upside down that a shorter one does not.
      inverts: CHASSIS.filter(
        (c) => !c.invertible && wheel.radius * 2 > c.height + c.groundClearance,
      ).length,
    }));
    for (const a of rows) {
      const dominated = rows.filter(
        (b) =>
          b.id !== a.id &&
          a.grip >= b.grip &&
          a.toughness >= b.toughness &&
          a.inverts >= b.inverts &&
          a.mass <= b.mass,
      );
      expect(
        dominated.map((b) => b.id),
        `${a.id} is strictly better than ${dominated.map((b) => b.id).join(', ')}`,
      ).toEqual([]);
    }
    // And the one thing that justifies the Big Roller has to actually be there.
    expect(
      rows.find((r) => r.id === 'bigroller')!.inverts,
      'the tallest wheel makes no frame invertible, so its weight buys nothing',
    ).toBeGreaterThan(0);
  });

  it('leaves the armour thickness slider with more than one right answer', () => {
    /*
     * `armorHp` goes as `t^1.15` while armour mass goes as `t`, so at a fixed
     * armour weight the plated area falls as `1/t` and the panel still gains as
     * `t^0.15` — thicker plate was free HP and the slider had exactly one setting
     * worth using. `plateStiffness` is the other side of it: a thick rigid panel
     * hands more of the hit to the frame behind it. Panel life and frame life have
     * to move in opposite directions across the slider, or the control is a lie.
     */
    const material = materialById('hardox');
    const design = makeDefaultDesign();
    design.armorMaterialId = material.id;
    design.armorCoverage = 1;

    const sample = (mm: number) => {
      design.armorThicknessMm = mm;
      const stats = computeStats(design);
      const damage = new BotDamage(stats);
      const fraction = transferFraction(0.7, material, 1);
      return {
        armorMass: stats.armorMass,
        panel: damage.get('armor-front')!.maxHp / fraction,
        frame:
          stats.frameHp /
          ((1 - fraction) * SHOCK_COUPLING * material.ductility ** 2 * plateStiffness(mm)),
      };
    };

    const thin = sample(4);
    const thick = sample(16);
    expect(thick.panel, 'thicker plate did not make the panels last longer').toBeGreaterThan(
      thin.panel,
    );
    expect(thick.frame, 'thicker plate did not push more shock into the frame').toBeLessThan(
      thin.frame,
    );
    expect(thick.armorMass, 'thicker plate cost no weight').toBeGreaterThan(thin.armorMass * 1.5);
    // And the trade has to be worth something: a token difference is still one
    // right answer with rounding on top.
    expect(thin.frame / thick.frame, 'the frame barely notices the plate spec').toBeGreaterThan(
      1.4,
    );
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

  it('keeps a launched machine inside the box', () => {
    /*
     * The walls were 1.3 m and the box had no lid, so a spinner exchange routinely
     * threw a machine clean out of the arena and ended the fight in seconds. The
     * real thing is roughly twice that and screened over the top.
     */
    expect(WALL_HEIGHT).toBeGreaterThan(2);

    const { world, combat, red } = fight(
      presetById('sparkplug').design,
      presetById('anvilhead').design,
    );
    // Fire it at the ceiling hard enough to leave an open-topped box.
    const chassis = (red as unknown as { chassis: any }).chassis;
    chassis.setLinvel({ x: 0, y: 14, z: 0 }, true);

    let escaped = false;
    for (let i = 0; i < Math.round(6 / FIXED_DT); i++) {
      world.step();
      if (combat.arena.isOutOfBounds(red.position())) escaped = true;
    }
    expect(escaped, 'a machine thrown upwards left the arena').toBe(false);
    expect(red.position().y, 'it never came back down').toBeLessThan(1);
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
  it('drives better on a higher difficulty', () => {
    /*
     * The three profiles were interchangeable as far as the suite was concerned:
     * every field of `PROFILES` could be flattened to one value with everything
     * green. Same seed, same fight, same duration — only the driver changes.
     */
    const closest = (difficulty: Difficulty): number => {
      const { world, combat, red, blue } = fight(
        presetById('sparkplug').design,
        presetById('anvilhead').design,
      );
      const ai = new BotAI(blue, combat.arena, difficulty, 4242);
      let nearest = Infinity;
      for (let i = 0; i < Math.round(20 / FIXED_DT); i++) {
        if (i % 8 === 0) blue.setInput(ai.update(FIXED_DT * 8, red));
        world.step();
        nearest = Math.min(nearest, blue.position().distanceTo(red.position()));
      }
      world.free();
      return nearest;
    };

    const rookie = closest('rookie');
    const champion = closest('champion');
    expect(champion, 'a champion driver closed no better than a rookie').toBeLessThan(rookie);
  });

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

    /*
     * Skirts exist to keep a weapon out of the wheels, so that is what to measure.
     * Asserting that they add mass passes just as well when they do nothing at
     * all — which is what they used to do.
     */
    const wheelHits = (accessories: BotDesign['accessories']): number => {
      const { world, combat, bot } = solo({ ...base, accessories });
      const target = combat as unknown as {
        pickTargetPart(bot: Bot, face: string, at: THREE.Vector3): { kind: string };
      };
      const at = bot.position().clone();
      // Low, and down the side: the contact a skirt is fitted to intercept.
      at.y -= computeStats({ ...base, accessories }).parts.chassis.height * 0.4;
      at.x += 0.3;

      let wheels = 0;
      for (let i = 0; i < 400; i++) {
        if (target.pickTargetPart(bot, 'left', at).kind === 'wheel') wheels += 1;
      }
      world.free();
      return wheels;
    };

    const bare = wheelHits([]);
    const skirted = wheelHits(['skirts']);
    expect(bare, 'low side hits never reached a wheel to begin with').toBeGreaterThan(50);
    expect(skirted, 'the skirts kept nothing out of the wheels').toBeLessThan(bare * 0.6);
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
      plateThicknessMm: NOMINAL_PLATE_MM,
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

  it('records more energy for a harder impact, not less', () => {
    /*
     * Contacts are drained after the solver has run, so reading the chassis
     * velocity inside a contact handler gives what the collision left behind, not
     * the approach. `0.5 * impulse * v` is the collision's kinetic energy only for
     * the approach speed — with the residual the relationship inverts, and the
     * harder a machine is stopped the *less* damage it records. Measured, a 3.3 kJ
     * head-on ram registered zero while a 37 kJ one registered 3.9 kJ.
     */
    const recorded = (speed: number): number => {
      const { world, combat, red } = fight(
        presetById('doorstop').design,
        presetById('anvilhead').design,
      );
      run(world, 1);
      let energy = 0;
      combat.events.on('impact', (impact) => {
        if (impact.kind === 'wall') energy += impact.energy;
      });
      const chassis = (red as unknown as { chassis: any }).chassis;
      chassis.setTranslation({ x: 0, y: 0.2, z: -4 }, true);
      chassis.setLinvel({ x: 0, y: 0, z: -speed }, true);
      run(world, 2.5);
      world.free();
      return energy;
    };

    const gentle = recorded(4);
    const hard = recorded(12);
    expect(hard, 'a 12 m/s wall hit recorded nothing').toBeGreaterThan(0);
    expect(hard, 'the harder impact recorded less energy than the gentler one').toBeGreaterThan(
      gentle,
    );
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
    /*
     * The bound has to be what the cooldown actually sets, not a number so loose
     * that removing the cooldown still satisfies it. `HIT_COOLDOWN` is 75 ms per
     * attacker/defender pair, so ten seconds of continuous contact can bill at
     * most 134 strikes — against the 4,800 a per-step billing would produce.
     */
    expect(weaponHits, 'strikes were billed per step, not per tooth').toBeLessThanOrEqual(
      Math.ceil(seconds / HIT_COOLDOWN),
    );
    world.free();
  });
});

describe('weapon mounting', () => {
  it('never hangs a rotor through the floor or through its own wheels', () => {
    /*
     * The catalogue's `weaponMount` is the frame designer's intent, and on its own
     * it did not survive contact with the rotors the builder lets you bolt on. The
     * stock Vertical Disc on a Lowline Wedge was created 88 mm *below the arena
     * floor*: the machine parked nose-up on its own weapon carrying 68% of its
     * weight on the rotor, and the blade ground to a complete stop — 0.0 kJ of a
     * promised 47.8. A horizontal bar, meanwhile, sweeps a disc wider than the
     * machine, straight through where the wheels are.
     */
    for (const chassis of CHASSIS) {
      for (const wheel of WHEELS) {
        for (const weapon of WEAPONS) {
          if (!weapon.rotor || !chassis.accepts.includes(weapon.kind)) continue;
          const label = `${chassis.id}/${wheel.id}/${weapon.id}`;
          const mount = weaponMountFor(chassis, wheel, weapon);
          const rideHeight = chassis.height / 2 + chassis.groundClearance;
          const mountY = rideHeight + mount.y;

          if (weapon.rotor.axis === 'x') {
            expect(mountY - weapon.rotor.radius, `${label}: disc sweeps into the floor`).toBeGreaterThan(
              0.005,
            );
            continue;
          }

          const half =
            (weapon.rotor.shape === 'bar' ? weapon.rotor.thickness : weapon.rotor.span) / 2;
          const tyreTop = rideHeight + driveLayout(chassis, wheel).wheelLocalY + wheel.radius;
          expect(mountY - half, `${label}: blade sweeps through its own tyres`).toBeGreaterThan(
            tyreTop,
          );
          expect(mountY - half, `${label}: blade sweeps into the floor`).toBeGreaterThan(0.005);
        }
      }
    }
  });

  it('leaves a stock build with a weapon that actually spins up', () => {
    // The default weapon on the Lowline Wedge reached 0.0 rad/s and stayed there.
    for (const chassisId of ['lowwedge', 'sprinter', 'boxframe']) {
      const design = { ...makeDefaultDesign(), chassisId, weaponId: 'vert-disc' };
      const stats = computeStats(design);
      const { world, bot } = solo(design);
      bot.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 12);
      expect(
        Math.abs(bot.omega),
        `a ${chassisId} could not spin its own weapon up`,
      ).toBeGreaterThan(stats.weaponMaxOmega * 0.6);
      world.free();
    }
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

// ---------------------------------------------------------------------------
// Wiring the sweep found untested: constants nothing pinned, and paths that
// could be deleted outright with both suites green.
// ---------------------------------------------------------------------------

describe('instrumentation', () => {
  it('bills a strike per tooth at a rate the cooldown actually sets', () => {
    /*
     * The existing per-tooth test bounds hits by `seconds / HIT_COOLDOWN` — the
     * constant on both sides of its own assertion, so the cooldown could be
     * lengthened 66x (to five seconds, one strike per engagement) and stay green.
     * The bounds here are absolute.
     *
     * The physical reasoning: at 480 Hz a solver step is 2.08 ms, and a single
     * contact manifold persists for tens of steps, so the debounce has to be well
     * above one step or every manifold bills dozens of times. It also has to stay
     * below the interval between genuinely separate strikes — a two-tooth bar at
     * 250 rad/s presents a tooth every 12.6 ms — or real hits are swallowed.
     */
    expect(HIT_COOLDOWN, 'the debounce is under one solver step').toBeGreaterThan(FIXED_DT * 8);
    expect(HIT_COOLDOWN, 'the debounce swallows separate strikes').toBeLessThan(0.12);

    // And the window has to actually drain on that schedule, not on a step count.
    const { world, red, blue, combat } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    const cooldowns = (combat as unknown as { hitCooldowns: Map<string, number> }).hitCooldowns;
    cooldowns.set('probe', HIT_COOLDOWN);
    run(world, HIT_COOLDOWN * 0.5);
    expect(cooldowns.has('probe'), 'the debounce expired inside its own window').toBe(true);
    run(world, HIT_COOLDOWN * 0.6);
    expect(cooldowns.has('probe'), 'the debounce never expired').toBe(false);

    let weaponHits = 0;
    combat.events.on('impact', (impact) => {
      if (impact.kind === 'weapon') weaponHits += 1;
    });
    red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 6);
    red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
    blue.setInput({ throttle: -1, steer: 0, weapon: false, fire: false, selfRight: false });
    run(world, 10);

    // Sixteen seconds of a driven spinner against a driven wedge. Real strikes are
    // rate-limited by spin-up, not by the debounce — but per-step billing would put
    // this in the thousands, which is the failure the debounce exists to prevent.
    expect(weaponHits, 'the weapon never landed at all').toBeGreaterThan(0);
    expect(weaponHits, 'strikes were billed per step, not per tooth').toBeLessThan(400);
    world.free();
  });

  it('credits the attacker with every joule the defender lost', () => {
    /*
     * `damageDealt = result.damage + result.shockConsumed`. Dropping the shock term
     * left up to 43% of the damage an attacker inflicted uncredited, and both
     * suites stayed green because nothing compared the two ledgers. This does: in a
     * fight with no hazards under either machine, the attacker's credit and the
     * defender's losses are the same joules seen from opposite ends.
     */
    const armored = { ...presetById('doorstop').design, armorMaterialId: 'hdpe' };
    const { world, red, blue } = fight(presetById('sparkplug').design, armored);
    red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 6);
    red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
    run(world, 8);

    const taken = blue.damage.totalDamageTaken;
    expect(taken, 'nothing landed, so the ledgers prove nothing').toBeGreaterThan(50);
    // Hazards and walls also damage, and they credit nobody — so the attacker's
    // credit is a lower bound on the defender's losses, never a smaller number.
    expect(
      red.damageDealt,
      'the attacker was credited with less than half of what it did',
    ).toBeGreaterThan(taken * 0.5);
    // And the shock component specifically has to be in there: on plastic armour
    // the panel refuses most of the hit, so a damage-only ledger is far short.
    const panels = blue.damage.parts.filter((p) => p.kind === 'armor');
    const absorbedByPanels = panels.reduce((sum, p) => sum + p.absorbed, 0);
    expect(taken, 'no shock reached the frame at all').toBeGreaterThan(absorbedByPanels * 1.02);
  });

  it('blunts the weapon on hard armour and barely marks it on soft', () => {
    /*
     * `WEAPON_WEAR` could be set to zero with every gate green: nothing observed a
     * weapon losing condition. It is also the whole reason a heavy hard armour
     * package is worth its mass, so it has to be *differential* — tool steel has to
     * cost the attacker more than plastic does.
     */
    const wear = (material: string): number => {
      const target = { ...presetById('doorstop').design, armorMaterialId: material };
      const { world, red } = fight(presetById('sparkplug').design, target);
      red.setInput({ throttle: 0, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 6);
      red.setInput({ throttle: 1, steer: 0, weapon: true, fire: false, selfRight: false });
      run(world, 8);
      const weapon = red.damage.parts.find((p) => p.id === 'weapon')!;
      world.free();
      return weapon.absorbed;
    };

    const hard = wear('s7');
    const soft = wear('hdpe');
    expect(hard, 'the rotor came off hardened tool steel without a mark').toBeGreaterThan(0);
    expect(hard, 'armour hardness does not reach the attacker at all').toBeGreaterThan(soft * 1.5);
  });

  it('binds the drivetrain when the frame folds, in a real world', () => {
    /*
     * `mobility` scaling on `frameIntegrity` was only ever read in a unit test of
     * the getter, so the line that multiplies engine force by it could be deleted
     * and nothing noticed. Drive the same machine twice in a real world, once with
     * a bent frame.
     */
    const distance = (bend: boolean): number => {
      const { world, bot } = solo(presetById('sparkplug').design);
      run(world, 1);
      if (bend) {
        const frame = bot.damage.parts.find((p) => p.id === 'frame')!;
        frame.hp = frame.maxHp * 0.05;
      }
      const start = bot.position(new THREE.Vector3());
      drive(bot, 1);
      run(world, 2);
      const travelled = bot.position(new THREE.Vector3()).sub(start).length();
      world.free();
      return travelled;
    };

    const healthy = distance(false);
    const bent = distance(true);
    expect(healthy, 'the healthy machine never moved').toBeGreaterThan(1);
    expect(bent, 'a folded frame did not slow the machine at all').toBeLessThan(healthy * 0.85);
  });

  it('scores aggression for closing and control for holding the angle', () => {
    /*
     * `tickJudging` — the entire basis of a decision — was driven by no test. Its
     * body could be emptied and only the two match-level tests that set the tallies
     * by hand would have anything to say.
     */
    const { world, red, blue } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    run(world, 1);
    red.aggression = 0;
    red.control = 0;
    blue.aggression = 0;
    blue.control = 0;

    // Red drives at blue; blue sits still with no throttle.
    drive(red, 1);
    drive(blue, 0);
    run(world, 3);

    expect(red.aggression, 'closing on the opponent scored no aggression').toBeGreaterThan(0);
    // Blue is not pinned at zero: being rammed credits the *aggressor*, but a shove
    // also lands a hit, and a landed hit pays its attacker a sliver of aggression
    // whichever machine it was. What must hold is that the machine doing the
    // driving is the one the card rewards.
    expect(
      blue.aggression,
      'the machine that never moved scored as much aggression as the one closing',
    ).toBeLessThan(red.aggression * 0.5);
    expect(red.control, 'driving at the opponent scored no control').toBeGreaterThan(0);
  });

  it('gives a reversing machine no aggression for running away', () => {
    const { world, red } = fight(
      presetById('sparkplug').design,
      presetById('doorstop').design,
    );
    run(world, 1);
    red.aggression = 0;
    drive(red, -1);
    run(world, 3);
    expect(red.aggression, 'backing away from the opponent scored as aggression').toBe(0);
  });

  it('fires the srimech only when it is inverted, working, and off cooldown', () => {
    /*
     * The whole self-righting path — the inverted guard, the destroyed-srimech
     * guard, and the 2.4 s cooldown — was reachable from no test: the method could
     * `return` on its first line and both suites stayed green.
     */
    const { world, bot } = solo(presetById('sparkplug').design);
    run(world, 1);
    const inner = bot as unknown as {
      srimechCooldown: number;
      chassis: { rotation(): { x: number; y: number; z: number; w: number }; setRotation(q: unknown, wake: boolean): void };
    };
    const press = (down: boolean): void =>
      bot.setInput({ throttle: 0, steer: 0, weapon: false, fire: false, selfRight: down });

    // Upright: pressing the button must do nothing at all.
    press(true);
    world.step();
    expect(bot.inverted, 'the machine started the test on its back').toBe(false);
    expect(inner.srimechCooldown, 'the srimech fired while the machine was upright').toBe(0);

    // Roll it onto its back and hold it there, so the guard sees a real pose
    // rather than a poked flag.
    const onBack = { x: 1, y: 0, z: 0, w: 0 };
    const flip = (): void => inner.chassis.setRotation(onBack, true);

    press(false);
    flip();
    world.step();
    expect(bot.inverted, 'the machine did not read as inverted').toBe(true);
    press(true);
    flip();
    world.step();
    const armed = inner.srimechCooldown;
    expect(armed, 'an inverted machine could not self-right').toBeGreaterThan(1);

    // A second press inside the cooldown must not re-arm it.
    press(false);
    flip();
    world.step();
    press(true);
    flip();
    world.step();
    expect(inner.srimechCooldown, 'the srimech re-armed inside its own cooldown').toBeLessThan(
      armed,
    );

    // A destroyed srimech is a machine that stays on its back.
    inner.srimechCooldown = 0;
    bot.damage.parts.find((p) => p.id === 'srimech')!.destroyed = true;
    press(false);
    flip();
    world.step();
    press(true);
    flip();
    world.step();
    expect(inner.srimechCooldown, 'a destroyed srimech still worked').toBe(0);
    world.free();
  });

  it('makes ground-scraping forks change the machine even on a wedge bot', () => {
    /*
     * `hasWedge = weapon.kind === 'wedge' || accessories.includes('forks')`, and
     * both branches built the identical hull — so bolting 3.1 kg of forks onto a
     * Fixed Wedge bot, which is exactly what the Doorstop preset does, bought
     * nothing at all. The tines now run further forward on a shallower angle, and
     * the collider and the mesh are built from the same numbers.
     */
    const plain = wedgeDimensions(chassisById('lowwedge'), false);
    const forked = wedgeDimensions(chassisById('lowwedge'), true);
    expect(forked.depth, 'forks do not reach any further than a plough face').toBeGreaterThan(
      plain.depth,
    );
    const angle = (d: { rise: number; depth: number }): number => Math.atan2(d.rise, d.depth);
    expect(
      angle(forked),
      'forks do not meet the floor any shallower than a plough face',
    ).toBeLessThan(angle(plain) * 0.9);

    /*
     * And it has to reach the machine the solver runs, not just the geometry
     * helper. The wedge collider a forked machine is built with is longer and
     * slipperier than the one a plough face gets — polished titanium tines against
     * a welded steel face — so both numbers are read straight off the rig.
     */
    const rig = (accessories: AccessoryEffect[]) => {
      const design = { ...presetById('doorstop').design, accessories };
      const { world, bot } = solo(design);
      run(world, 1);
      const body = bot as unknown as {
        chassis: {
          numColliders(): number;
          collider(i: number): { friction(): number };
        };
      };
      let slipperiest = Infinity;
      for (let i = 0; i < body.chassis.numColliders(); i++) {
        const collider = body.chassis.collider(i);
        slipperiest = Math.min(slipperiest, collider.friction());
      }
      world.free();
      return { slipperiest };
    };

    const forkedRig = rig(['srimech', 'forks']);
    const ploughRig = rig(['srimech']);
    expect(
      forkedRig.slipperiest,
      'a forked machine is no slipperier at the nose than a plough face',
    ).toBeLessThan(ploughRig.slipperiest);

    // And the builder has to say so, rather than quietly charging 3.1 kg for an
    // extension of a wedge the machine already has.
    const doubled = validateDesign({
      ...presetById('doorstop').design,
      accessories: ['srimech', 'forks'],
    });
    expect(
      doubled.some((issue) => /wedge/i.test(issue.message) && /fork/i.test(issue.message)),
      'nothing warns that forks on a wedge bot only extend the wedge',
    ).toBe(true);
  });

  it('converts to the units the HUD and the builder print', () => {
    /*
     * Every speed the player reads is `mpsToMph`, and every weight is `kgToLb`, and
     * neither factor was pinned anywhere: both were free to be off by any amount
     * with the suites green, and the numbers would still look plausible.
     */
    expect(mpsToMph(1), 'a metre per second is not 2.2369 mph').toBeCloseTo(2.2369362921, 9);
    expect(mpsToMph(0)).toBe(0);
    expect(mpsToMph(-3), 'the conversion is not signed').toBeCloseTo(-6.7108, 3);
    // 26.8 m/s is 60 mph; a 250 lb machine is 113.4 kg.
    expect(mpsToMph(26.8224), 'sixty miles an hour came out wrong').toBeCloseTo(60, 3);
    expect(kgToLb(1), 'a kilogram is not 2.2046 lb').toBeCloseTo(2.2046226218, 9);
    expect(kgToLb(113.398), 'the weight limit came out wrong').toBeCloseTo(250, 2);
  });
});
