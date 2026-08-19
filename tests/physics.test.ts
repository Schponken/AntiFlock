import { beforeAll, describe, expect, it } from 'vitest';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { ARENA_HALF } from '../src/game/arena.ts';
import { PRESETS, cloneDesign, makeDefaultDesign, presetById } from '../src/game/design.ts';
import { WEAPONS, rotorInertia, rotorMass } from '../src/game/parts.ts';
import type { Bot } from '../src/game/bot.ts';
import { mpsToMph, wrapAngle } from '../src/core/mathx.ts';

beforeAll(async () => {
  await initRapier();
});

/** Spin up a headless fight, run it for `seconds`, and hand back the pieces. */
function makeFight(designA = makeDefaultDesign(), designB = presetById('doorstop').design) {
  const world = new PhysicsWorld();
  const combat = new Combat(world, { headless: true });
  const a = combat.addBot(designA, 0);
  const b = combat.addBot(designB, 1);
  combat.start();
  return { world, combat, a, b };
}

/** One machine, empty box — for drivetrain tests where an opponent would get in the way. */
function makeSolo(design = makeDefaultDesign()) {
  const world = new PhysicsWorld();
  const combat = new Combat(world, { headless: true });
  const a = combat.addBot(design, 0);
  combat.start();
  return { world, combat, a };
}

const run = (world: PhysicsWorld, seconds: number): void => {
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i++) world.step();
};

/**
 * Total heading change over `seconds`, in radians, accumulated step by step.
 *
 * Comparing start and end headings with `acos(dot)` cannot see past half a turn,
 * and a combat robot pivots at four or five radians a second — so that metric
 * reports a bot spinning like a top as "barely rotated".
 */
function accumulateTurn(world: PhysicsWorld, bot: Bot, seconds: number): number {
  const steps = Math.round(seconds / FIXED_DT);
  const heading = () => {
    const f = bot.forward();
    return Math.atan2(f.x, f.z);
  };
  let previous = heading();
  let total = 0;
  for (let i = 0; i < steps; i++) {
    world.step();
    const current = heading();
    total += Math.abs(wrapAngle(current - previous));
    previous = current;
  }
  return total;
}

describe('rig stability', () => {
  it('settles both machines on the floor without exploding', () => {
    const { world, a, b } = makeFight();
    run(world, 2);

    for (const bot of [a, b]) {
      const p = bot.position();
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)).toBe(true);
      // Sitting on the floor, not sunk through it and not launched.
      expect(p.y, `${bot.name} height`).toBeGreaterThan(0);
      expect(p.y, `${bot.name} height`).toBeLessThan(0.6);
      // Still in its own corner.
      expect(Math.abs(p.z)).toBeGreaterThan(3);
      expect(bot.speed).toBeLessThan(0.4);
      // Wheels down.
      expect(bot.up().y, `${bot.name} upright`).toBeGreaterThan(0.9);
    }
  });

  it('keeps every stock preset stable for five seconds', () => {
    for (const preset of PRESETS) {
      const { world, a } = makeFight(preset.design, presetById('doorstop').design);
      run(world, 5);
      const p = a.position();
      expect(Number.isFinite(p.y), `${preset.label} produced NaN`).toBe(true);
      expect(p.y, `${preset.label} fell through the floor`).toBeGreaterThan(-0.5);
      expect(p.y, `${preset.label} was launched`).toBeLessThan(2);
      world.free();
    }
  });
});

describe('drivetrain', () => {
  it('drives forward and approaches its designed top speed', () => {
    const { world, a } = makeSolo();
    run(world, 1);
    const start = a.position().clone();

    a.setInput({ throttle: 1 });
    // Track the peak: the box is only fifteen metres across, so a fast machine
    // reaches the far wall inside the run and its *final* speed is zero.
    let peak = 0;
    for (let i = 0; i < Math.round(2.5 / FIXED_DT); i++) {
      world.step();
      peak = Math.max(peak, a.speed);
    }

    const travelled = a.position().distanceTo(start);
    expect(travelled, 'bot did not move under power').toBeGreaterThan(2);

    // Should land in the right ballpark: fast, but not past what the gearing allows.
    expect(peak, `reached ${mpsToMph(peak).toFixed(1)} mph`).toBeGreaterThan(
      a.stats.topSpeed * 0.5,
    );
    expect(peak).toBeLessThan(a.stats.topSpeed * 1.25);
  });

  it('reverses', () => {
    const { world, a } = makeSolo();
    run(world, 1);
    const start = a.position().clone();
    const facing = a.forward().clone();

    a.setInput({ throttle: -1 });
    run(world, 1.5);

    const travel = a.position().clone().sub(start);
    expect(travel.dot(facing)).toBeLessThan(-0.4);
  });

  it('skid-steers on the spot', () => {
    const { world, a } = makeSolo();
    run(world, 1);
    const start = a.position().clone();

    a.setInput({ throttle: 0, steer: 1 });
    const turned = accumulateTurn(world, a, 1.5);

    // A combat robot pivots fast: well over a radian a second.
    expect(turned, `only turned ${turned.toFixed(2)} rad`).toBeGreaterThan(1.5);
    // Pivoting should not become driving.
    expect(a.position().distanceTo(start), 'the pivot wandered off').toBeLessThan(1.2);
    expect(a.position().length()).toBeLessThan(ARENA_HALF);
  });

  it('loses drive on the side whose wheels are gone', () => {
    const { world, a } = makeSolo();
    run(world, 1);

    // Kill both wheels on one side.
    for (const id of ['wheel-0', 'wheel-2']) {
      const part = a.damage.get(id)!;
      part.hp = 0;
      part.destroyed = true;
      a.onPartDestroyed(id);
    }
    expect(a.damage.mobility).toBeCloseTo(0.5, 5);

    a.setInput({ throttle: 1 });
    const turned = accumulateTurn(world, a, 2);
    // A bot driving on one side veers instead of tracking straight.
    expect(turned, 'a half-dead drivetrain still tracked straight').toBeGreaterThan(0.15);
  });
});

describe('weapon', () => {
  it('spins a rotor up to near its redline within the predicted time', () => {
    const { world, a } = makeSolo();
    expect(a.stats.weaponMaxOmega).toBeGreaterThan(0);

    a.setInput({ weapon: true });
    run(world, a.stats.weaponSpinupTime * 2.2 + 1);

    expect(Math.abs(a.omega), 'rotor never spun up').toBeGreaterThan(
      a.stats.weaponMaxOmega * 0.8,
    );
    expect(Math.abs(a.omega)).toBeLessThanOrEqual(a.stats.weaponMaxOmega * 1.1);
  });

  it('stores energy in the right ballpark for a heavyweight spinner', () => {
    const { world, a } = makeSolo();
    a.setInput({ weapon: true });
    run(world, a.stats.weaponSpinupTime * 2.2 + 1);
    const kj = a.weaponEnergy / 1000;
    expect(kj, `stored ${kj.toFixed(1)} kJ`).toBeGreaterThan(15);
    expect(kj, `stored ${kj.toFixed(1)} kJ`).toBeLessThan(120);
  });

  it('bleeds energy out of the rotor when it deforms something', () => {
    const { world, a } = makeSolo();
    a.setInput({ weapon: true });
    run(world, a.stats.weaponSpinupTime * 2.2 + 1);

    const before = a.weaponEnergy;
    a.bleedWeaponEnergy(before * 0.4);
    expect(a.weaponEnergy).toBeLessThan(before * 0.75);
    expect(a.weaponEnergy).toBeGreaterThan(0);
  });

  it('spins down when the driver lets off', () => {
    const { world, a } = makeSolo();
    a.setInput({ weapon: true });
    run(world, a.stats.weaponSpinupTime * 2.2 + 1);
    const spinning = Math.abs(a.omega);

    a.setInput({ weapon: false });
    run(world, 12);
    expect(Math.abs(a.omega)).toBeLessThan(spinning * 0.85);
  });

  it('fires a flipper a limited number of times', () => {
    const { world, a } = makeSolo(presetById('trebuchet').design);
    run(world, 0.5);
    const shots = a.actuatorShots;
    expect(shots).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) {
      a.setInput({ fire: true });
      run(world, 0.1);
      a.setInput({ fire: false });
      run(world, 3);
    }
    expect(a.actuatorShots).toBe(shots - 3);
  });
});

describe('arena', () => {
  it('holds machines inside the box', () => {
    const { world, combat, a } = makeFight();
    run(world, 0.5);
    // Fling it at the wall hard.
    a.chassis.setLinvel({ x: 0, y: 0, z: -26 }, true);
    run(world, 2.5);
    expect(combat.arena.isOutOfBounds(a.position()), 'bot escaped through the wall').toBe(false);
  });

  it("reports a machine outside the walls as out of bounds", async () => {
    const { combat } = makeFight();
    const { Vector3 } = await import('three').then((m) => ({ Vector3: m.Vector3 }));
    expect(combat.arena.isOutOfBounds(new Vector3(0, 0.2, ARENA_HALF + 2))).toBe(true);
    expect(combat.arena.isOutOfBounds(new Vector3(0, 0.2, 0))).toBe(false);
  });

  it('raises and lowers the killsaws', () => {
    const { world, combat } = makeFight();
    expect(combat.arena.killsawsUp).toBe(false);
    combat.arena.triggerKillsaws(2);
    run(world, 0.5);
    expect(combat.arena.killsawsUp).toBe(true);
    run(world, 2.5);
    expect(combat.arena.killsawsUp).toBe(false);
  });
});

describe('knockouts', () => {
  it('counts out a machine that stops moving', () => {
    const { world, combat, a } = makeFight();
    const seen: Bot[] = [];
    combat.events.on('knockout', ({ bot }) => seen.push(bot));

    // Freeze it in place and let the referee count.
    a.disable();
    a.chassis.setBodyType(1 /* fixed */, true);
    run(world, 11);

    expect(a.damage.countedOut).toBe(true);
    expect(seen).toContain(a);
  });
});

describe('rotor mass properties', () => {
  /*
   * The builder quotes weapon energy from the catalogue; the fight delivers energy
   * from the solver. If those two ever disagree the whole game lies to the player,
   * so every rotor shape is pinned here.
   */
  const rotorWeapons = WEAPONS.filter((w) => w.rotor);

  it('covers every rotor shape in the catalogue', () => {
    const shapes = new Set(rotorWeapons.map((w) => w.rotor!.shape));
    expect(shapes).toEqual(new Set(['disc', 'bar', 'drum', 'ring']));
  });

  for (const weapon of rotorWeapons) {
    it(`gives ${weapon.name} the mass and inertia the catalogue promises`, () => {
      const design = makeDefaultDesign();
      // Anvil Brick accepts the widest set of weapons; the disc shell takes the rest.
      design.chassisId = weapon.kind === 'horizontal-spinner' || weapon.kind === 'undercutter'
        ? 'discshell'
        : 'brick';
      design.weaponId = weapon.id;
      design.armorThicknessMm = 4;
      design.armorCoverage = 0.5;

      const { world, a } = makeSolo(design);
      // Mass properties are computed lazily, so take one step first.
      run(world, 0.05);

      const expectedMass = rotorMass(weapon, a.stats.parts.weaponMaterial);
      const expectedInertia = rotorInertia(weapon, a.stats.parts.weaponMaterial);

      expect(a.weaponBody!.mass(), `${weapon.name} rotor mass`).toBeCloseTo(expectedMass, 1);
      expect(
        a.weaponInertia,
        `${weapon.name}: solver inertia ${a.weaponInertia.toFixed(4)} vs catalogue ${expectedInertia.toFixed(4)}`,
      ).toBeCloseTo(expectedInertia, 3);

      world.free();
    });
  }

  it('spins every rotor up to the energy the builder advertises', () => {
    for (const weapon of rotorWeapons) {
      const design = cloneDesign(makeDefaultDesign());
      design.chassisId = weapon.kind === 'horizontal-spinner' || weapon.kind === 'undercutter'
        ? 'discshell'
        : 'brick';
      design.weaponId = weapon.id;
      design.armorThicknessMm = 4;
      design.armorCoverage = 0.5;

      const { world, a } = makeSolo(design);
      a.setInput({ weapon: true });
      run(world, a.stats.weaponSpinupTime * 2.5 + 1.5);

      const ratio = a.weaponEnergy / a.stats.weaponEnergy;
      expect(
        ratio,
        `${weapon.name}: reached ${(a.weaponEnergy / 1000).toFixed(1)} kJ of a promised ${(a.stats.weaponEnergy / 1000).toFixed(1)} kJ`,
      ).toBeGreaterThan(0.7);
      expect(ratio).toBeLessThan(1.25);
      world.free();
    }
  });
});
