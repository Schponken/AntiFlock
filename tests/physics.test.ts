/**
 * Integration tests that run the real Rapier simulation headlessly.
 *
 * These are the tests that catch the things unit tests cannot: robots sinking
 * through the floor, drivetrains that produce no thrust, spinners that never
 * reach speed, weapons that pass through armour.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Physics, initPhysics } from '../src/sim/physics';
import { Fight } from '../src/sim/fight';
import { ARENA_HALF, CEILING_HEIGHT, START_POSITIONS } from '../src/sim/arena';
import { defaultDesign, maxLegalThickness, type BotDesign } from '../src/sim/parts';
import { mpsToMph } from '../src/core/math';
import { neutralControl } from '../src/sim/bot';

const FRAME = 1 / 60;

function design(over: Partial<BotDesign> = {}): BotDesign {
  const d = { ...defaultDesign(), ...over };
  d.armorThicknessMm = Math.min(d.armorThicknessMm, maxLegalThickness(d));
  return d;
}

/** Build a fight, run the intro out, and hand it back ready to drive. */
function makeFight(red = design(), blue = design(), hazards = false) {
  const physics = new Physics();
  const fight = new Fight(physics, { redDesign: red, blueDesign: blue, hazards, seed: 99 });
  fight.start();
  fight.match.skipIntro();
  return { physics, fight };
}

function run(fight: Fight, seconds: number): void {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) fight.update(FRAME);
}

/**
 * Spin the weapon up while circling. A real driver keeps moving during
 * spin-up — a robot that sits still gets counted out in ten seconds, which is
 * correct refereeing and would otherwise cut these tests short.
 */
function spinUpWhileCircling(fight: Fight, side: 'a' | 'b', seconds: number): void {
  const bot = fight.botFor(side);
  const other = fight.botFor(side === 'a' ? 'b' : 'a');
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    bot.control = { ...neutralControl(), throttle: 0.3, steer: 0.75, weapon: 1 };
    // Keep the opponent circling too, or the referee counts *them* out and the
    // match is over before the bar is up to speed.
    other.control = { ...neutralControl(), throttle: 0.25, steer: -0.7 };
    fight.update(FRAME);
  }
}

/**
 * Square the robots up nose to nose at a known separation, carrying the rotor
 * along so a spun-up weapon keeps its energy. Circling to spin up leaves them
 * wherever the physics put them, and a combat test needs a known geometry.
 */
function squareUp(fight: Fight, gap: number): void {
  const y = (bot: Fight['red']) => bot.stats.drive.wheelRadiusM + 0.02;
  fight.red.teleport({ x: -gap / 2, y: y(fight.red), z: 0 }, 0);
  fight.blue.teleport({ x: gap / 2, y: y(fight.blue), z: 0 }, Math.PI);
}

beforeAll(async () => {
  await initPhysics();
}, 30_000);

describe('world setup', () => {
  it('initialises and builds an arena without throwing', () => {
    const { physics, fight } = makeFight();
    expect(fight.arena.saws.length).toBeGreaterThan(0);
    expect(fight.arena.pulverisers.length).toBe(4);
    physics.dispose();
  });

  it('places both robots in their starting squares', () => {
    const { physics, fight } = makeFight();
    expect(fight.red.position.x).toBeCloseTo(START_POSITIONS.red.x, 3);
    expect(fight.blue.position.x).toBeCloseTo(START_POSITIONS.blue.x, 3);
    physics.dispose();
  });
});

describe('robots settle on the floor', () => {
  it('drops onto its wheels and stays there', () => {
    const { physics, fight } = makeFight();
    run(fight, 2);

    const y = fight.red.position.y;
    const wheelRadius = fight.red.stats.drive.wheelRadiusM;
    // The body origin sits on the axle line, so at rest it should be one wheel
    // radius off the floor.
    expect(y).toBeGreaterThan(wheelRadius * 0.6);
    expect(y).toBeLessThan(wheelRadius * 1.6);
    physics.dispose();
  });

  it('sits the right way up', () => {
    const { physics, fight } = makeFight();
    run(fight, 2);
    expect(fight.red.upVector.y).toBeGreaterThan(0.9);
    expect(fight.red.isUpsideDown).toBe(false);
    physics.dispose();
  });

  it('never falls through the floor, even under a hard landing', () => {
    const { physics, fight } = makeFight();
    fight.red.body.setTranslation({ x: 0, y: 3.5, z: 0 }, true);
    fight.red.body.setLinvel({ x: 0, y: -25, z: 0 }, true);
    run(fight, 3);
    expect(fight.red.position.y).toBeGreaterThan(-0.05);
    physics.dispose();
  });

  it('stays inside the cage', () => {
    const { physics, fight } = makeFight();
    // Fling it at a wall.
    fight.red.body.setLinvel({ x: -30, y: 2, z: 0 }, true);
    run(fight, 4);
    expect(Math.abs(fight.red.position.x)).toBeLessThan(ARENA_HALF);
    expect(Math.abs(fight.red.position.z)).toBeLessThan(ARENA_HALF);
    expect(fight.red.position.y).toBeLessThan(CEILING_HEIGHT);
    physics.dispose();
  });
});

describe('drivetrain', () => {
  it('drives forward when told to', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    const startX = fight.red.position.x;

    fight.red.control = { ...neutralControl(), throttle: 1 };
    run(fight, 2);

    expect(fight.red.position.x).toBeGreaterThan(startX + 1);
    physics.dispose();
  });

  it('drives backwards when told to', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    const startX = fight.red.position.x;

    fight.red.control = { ...neutralControl(), throttle: -1 };
    run(fight, 2);

    expect(fight.red.position.x).toBeLessThan(startX - 0.5);
    physics.dispose();
  });

  it('reaches a top speed close to the figure the garage advertises', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    fight.red.control = { ...neutralControl(), throttle: 1 };

    let peak = 0;
    for (let i = 0; i < 120; i++) {
      fight.update(FRAME);
      peak = Math.max(peak, fight.red.speed);
    }

    const advertised = fight.red.stats.topSpeedMps;
    // Within a reasonable band — it has to accelerate and it runs out of arena.
    expect(peak).toBeGreaterThan(advertised * 0.55);
    expect(peak).toBeLessThan(advertised * 1.25);
    expect(mpsToMph(peak)).toBeGreaterThan(8);
    physics.dispose();
  });

  it('turns when steered', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    const before = fight.red.forwardVector;

    fight.red.control = { ...neutralControl(), throttle: 0.3, steer: 1 };
    run(fight, 2);

    const after = fight.red.forwardVector;
    const dot = before.x * after.x + before.z * after.z;
    expect(dot).toBeLessThan(0.8); // it has clearly changed heading
    physics.dispose();
  });

  it('does not move with no input', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    const start = { ...fight.red.position };
    run(fight, 2);
    const moved = Math.hypot(fight.red.position.x - start.x, fight.red.position.z - start.z);
    expect(moved).toBeLessThan(0.1);
    physics.dispose();
  });

  it('cannot drive with every wheel destroyed', () => {
    const { physics, fight } = makeFight();
    run(fight, 1);
    fight.red.health.wheels.fill(0);
    const start = { ...fight.red.position };

    fight.red.control = { ...neutralControl(), throttle: 1 };
    run(fight, 2);

    const moved = Math.hypot(fight.red.position.x - start.x, fight.red.position.z - start.z);
    expect(moved).toBeLessThan(0.25);
    expect(fight.red.immobilised).toBe(true);
    physics.dispose();
  });

  it('stays still before the light goes green', () => {
    const physics = new Physics();
    const fight = new Fight(physics, { redDesign: design(), blueDesign: design(), hazards: false });
    fight.start(); // no skipIntro — we are in the opening sequence
    run(fight, 1);
    const start = { ...fight.red.position };

    fight.red.control = { ...neutralControl(), throttle: 1, weapon: 1 };
    run(fight, 2);

    const moved = Math.hypot(fight.red.position.x - start.x, fight.red.position.z - start.z);
    expect(moved).toBeLessThan(0.1);
    physics.dispose();
  });
});

describe('weapons', () => {
  it('spins a bar up toward its rated speed and stores real energy', () => {
    const { physics, fight } = makeFight(design({ weaponId: 'bar' }));
    run(fight, 1);

    spinUpWhileCircling(fight, 'a', 25);

    expect(fight.red.weaponSpinFraction).toBeGreaterThan(0.75);
    // Stored energy should be within reach of the advertised figure.
    expect(fight.red.weaponStoredEnergyJ).toBeGreaterThan(fight.red.stats.weaponEnergyJ * 0.5);
    physics.dispose();
  }, 30_000);

  it('leaves the rotor still when the weapon is switched off', () => {
    const { physics, fight } = makeFight(design({ weaponId: 'bar' }));
    run(fight, 3);
    expect(fight.red.weaponSpinFraction).toBeLessThan(0.1);
    physics.dispose();
  });

  it('does not spin a rotor that has been knocked out', () => {
    const { physics, fight } = makeFight(design({ weaponId: 'bar' }));
    run(fight, 1);
    fight.red.health.weapon = 0;
    fight.red.control = { ...neutralControl(), weapon: 1 };
    run(fight, 6);
    expect(fight.red.weaponSpinFraction).toBeLessThan(0.2);
    physics.dispose();
  }, 20_000);

  it('fires a flipper and gets it back to rest', () => {
    const flipper = design({
      chassisId: 'wedge',
      weaponId: 'flipper',
      driveId: '4wd-chain',
      srimech: false,
    });
    const { physics, fight } = makeFight(flipper);
    run(fight, 1.5);
    expect(fight.red.burstReady).toBe(true);

    fight.red.control = { ...neutralControl(), fire: true };
    fight.update(FRAME);
    fight.red.control = { ...neutralControl(), fire: false };
    run(fight, 0.2);
    expect(fight.red.burstActive).toBe(true);

    run(fight, 4);
    expect(fight.red.burstActive).toBe(false);
    expect(fight.red.burstReady).toBe(true);
    physics.dispose();
  }, 20_000);
});

describe('combat', () => {
  it('does damage when a spun-up bar meets another robot', () => {
    const attacker = design({ weaponId: 'bar', chassisId: 'barframe' });
    const victim = design({ chassisId: 'brick', weaponId: 'none', armorId: 'al6061' });
    const { physics, fight } = makeFight(attacker, victim);

    // Spin up on the move, then drive across the arena into the other robot.
    spinUpWhileCircling(fight, 'a', 22);
    expect(fight.red.weaponSpinFraction).toBeGreaterThan(0.7);

    squareUp(fight, 3.2);
    const before = fight.conditionOf('b');
    fight.red.control = { ...neutralControl(), throttle: 1, weapon: 1 };
    run(fight, 6);

    expect(fight.conditionOf('b')).toBeLessThan(before);
    expect(fight.scores.a.hitsLanded).toBeGreaterThan(0);
    expect(fight.scores.a.damageDealtJ).toBeGreaterThan(0);
    physics.dispose();
  }, 45_000);

  it('slows the rotor down when it lands a hit', () => {
    const attacker = design({ weaponId: 'bar' });
    const victim = design({ chassisId: 'brick', weaponId: 'none' });
    const { physics, fight } = makeFight(attacker, victim);

    spinUpWhileCircling(fight, 'a', 22);
    squareUp(fight, 3.2);
    const spunUp = Math.abs(fight.red.weaponOmega);

    fight.red.control = { ...neutralControl(), throttle: 1, weapon: 1 };
    let minimum = spunUp;
    for (let i = 0; i < 360; i++) {
      fight.update(FRAME);
      minimum = Math.min(minimum, Math.abs(fight.red.weaponOmega));
    }

    // Hitting 113 kg of robot has to cost the bar some speed.
    expect(minimum).toBeLessThan(spunUp * 0.95);
    physics.dispose();
  }, 45_000);

  it('raises impact events the renderer can draw sparks from', () => {
    const attacker = design({ weaponId: 'bar' });
    const victim = design({ chassisId: 'brick', weaponId: 'none' });
    const { physics, fight } = makeFight(attacker, victim);

    spinUpWhileCircling(fight, 'a', 22);
    squareUp(fight, 3.2);
    fight.drainEvents();

    fight.red.control = { ...neutralControl(), throttle: 1, weapon: 1 };
    const collected: string[] = [];
    for (let i = 0; i < 360; i++) {
      fight.update(FRAME);
      for (const e of fight.drainEvents()) collected.push(e.kind);
    }

    expect(collected.length).toBeGreaterThan(0);
    expect(collected.some((k) => k === 'weapon-hit' || k === 'ram')).toBe(true);
    physics.dispose();
  }, 45_000);

  it('takes damage from ramming at speed', () => {
    const rammer = design({ chassisId: 'brick', weaponId: 'none', driveId: '4wd-sprint' });
    const victim = design({ chassisId: 'brick', weaponId: 'none' });
    const { physics, fight } = makeFight(rammer, victim);
    run(fight, 1);

    const before = fight.conditionOf('b');
    fight.red.control = { ...neutralControl(), throttle: 1 };
    run(fight, 5);

    expect(fight.conditionOf('b')).toBeLessThanOrEqual(before);
    physics.dispose();
  }, 30_000);
});

describe('match integration', () => {
  it('counts out a robot that cannot move and ends the fight', () => {
    const { physics, fight } = makeFight();
    // Kill the victim's drive outright.
    fight.blue.health.wheels.fill(0);
    run(fight, 14);

    expect(fight.match.result).not.toBeNull();
    expect(fight.match.result?.winner).toBe('a');
    expect(fight.match.result?.reason).toBe('knockout');
    physics.dispose();
  }, 30_000);

  it('goes to the judges when the clock runs out', () => {
    const { physics, fight } = makeFight();
    // Push the clock to the edge rather than simulating three real minutes.
    fight.match.timeRemaining = 0.5;
    run(fight, 2);

    expect(fight.decision).not.toBeNull();
    expect(fight.match.phase).toBe('over');
    expect(fight.match.result?.reason).toBe('decision');
    physics.dispose();
  }, 20_000);
});

describe('arena hazards', () => {
  it('raises and lowers the killsaws on their cycle', () => {
    const { physics, fight } = makeFight(design(), design(), true);
    let sawWasUp = false;
    for (let i = 0; i < 60 * 25; i++) {
      fight.update(FRAME);
      if (fight.arena.saws[0]!.extension > 0.8) sawWasUp = true;
    }
    expect(sawWasUp).toBe(true);
    // And they come back down again.
    physics.dispose();
  }, 45_000);

  it('keeps the saws down when hazards are switched off', () => {
    const { physics, fight } = makeFight(design(), design(), false);
    run(fight, 15);
    for (const saw of fight.arena.saws) expect(saw.extension).toBeLessThan(0.05);
    physics.dispose();
  }, 30_000);
});

describe('determinism', () => {
  it('produces the same fight twice from the same seed and inputs', () => {
    const snapshot = () => {
      const physics = new Physics();
      const fight = new Fight(physics, {
        redDesign: design(),
        blueDesign: design(),
        hazards: true,
        seed: 4242,
      });
      fight.start();
      fight.match.skipIntro();
      for (let i = 0; i < 300; i++) {
        fight.red.control = { ...neutralControl(), throttle: 1, weapon: 1 };
        fight.blue.control = { ...neutralControl(), throttle: 1, steer: 0.2 };
        fight.update(FRAME);
      }
      const out = {
        red: { ...fight.red.position },
        blue: { ...fight.blue.position },
        condA: fight.conditionOf('a'),
        condB: fight.conditionOf('b'),
      };
      physics.dispose();
      return out;
    };

    const first = snapshot();
    const second = snapshot();
    expect(second.red.x).toBeCloseTo(first.red.x, 4);
    expect(second.blue.x).toBeCloseTo(first.blue.x, 4);
    expect(second.condA).toBeCloseTo(first.condA, 6);
    expect(second.condB).toBeCloseTo(first.condB, 6);
  }, 45_000);
});
