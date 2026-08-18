/**
 * Tests for the opponent driver, run against the real simulation.
 *
 * The AI is judged the way a driver would be: does it close the distance, does
 * it get its weapon up before committing, does it stay in the arena, and does it
 * do something about being upside down.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OpponentDriver, type Difficulty } from '../src/ai/opponent';
import { Fight } from '../src/sim/fight';
import { Physics, initPhysics } from '../src/sim/physics';
import { ARENA_HALF } from '../src/sim/arena';
import { defaultDesign, maxLegalThickness, type BotDesign } from '../src/sim/parts';
import { neutralControl } from '../src/sim/bot';

const FRAME = 1 / 60;

function design(over: Partial<BotDesign> = {}): BotDesign {
  const d = { ...defaultDesign(), ...over };
  d.armorThicknessMm = Math.min(d.armorThicknessMm, maxLegalThickness(d));
  return d;
}

function makeFight(red = design(), blue = design()) {
  const physics = new Physics();
  const fight = new Fight(physics, {
    redDesign: red,
    blueDesign: blue,
    hazards: false,
    seed: 1234,
  });
  fight.start();
  fight.match.skipIntro();
  return { physics, fight };
}

/** Run with the AI driving blue and the player robot inert. */
function runWithAi(fight: Fight, driver: OpponentDriver, seconds: number): void {
  const frames = Math.round(seconds / FRAME);
  for (let i = 0; i < frames; i++) {
    fight.blue.control = driver.drive(fight.blue, fight.red, FRAME, fight.match.live);
    fight.update(FRAME);
  }
}

beforeAll(async () => {
  await initPhysics();
}, 30_000);

describe('opponent driver', () => {
  it('stays still before the light goes green', () => {
    const physics = new Physics();
    const fight = new Fight(physics, { redDesign: design(), blueDesign: design(), hazards: false });
    fight.start(); // still in the intro
    const driver = new OpponentDriver('champion');

    const start = { ...fight.blue.position };
    runWithAi(fight, driver, 2);

    const moved = Math.hypot(
      fight.blue.position.x - start.x,
      fight.blue.position.z - start.z,
    );
    expect(moved).toBeLessThan(0.1);
    physics.dispose();
  }, 20_000);

  it('closes the distance on a stationary opponent', () => {
    const { physics, fight } = makeFight();
    const driver = new OpponentDriver('veteran');

    const before = Math.hypot(
      fight.blue.position.x - fight.red.position.x,
      fight.blue.position.z - fight.red.position.z,
    );
    runWithAi(fight, driver, 8);
    const after = Math.hypot(
      fight.blue.position.x - fight.red.position.x,
      fight.blue.position.z - fight.red.position.z,
    );

    expect(after, 'the AI never closed on its opponent').toBeLessThan(before);
    physics.dispose();
  }, 30_000);

  it('runs its weapon', () => {
    const { physics, fight } = makeFight();
    const driver = new OpponentDriver('veteran');
    runWithAi(fight, driver, 10);
    expect(fight.blue.weaponSpinFraction).toBeGreaterThan(0.05);
    physics.dispose();
  }, 30_000);

  it('keeps itself inside the cage', () => {
    const { physics, fight } = makeFight();
    const driver = new OpponentDriver('champion');
    runWithAi(fight, driver, 25);
    expect(Math.abs(fight.blue.position.x)).toBeLessThan(ARENA_HALF);
    expect(Math.abs(fight.blue.position.z)).toBeLessThan(ARENA_HALF);
    physics.dispose();
  }, 45_000);

  it('never produces a control value outside its range', () => {
    const { physics, fight } = makeFight();
    const driver = new OpponentDriver('rookie');
    for (let i = 0; i < 600; i++) {
      const control = driver.drive(fight.blue, fight.red, FRAME, true);
      expect(Number.isFinite(control.throttle)).toBe(true);
      expect(Number.isFinite(control.steer)).toBe(true);
      expect(control.throttle).toBeGreaterThanOrEqual(-1);
      expect(control.throttle).toBeLessThanOrEqual(1);
      expect(control.steer).toBeGreaterThanOrEqual(-1);
      expect(control.steer).toBeLessThanOrEqual(1);
      expect(control.weapon).toBeGreaterThanOrEqual(0);
      expect(control.weapon).toBeLessThanOrEqual(1);
      fight.blue.control = control;
      fight.update(FRAME);
    }
    physics.dispose();
  }, 30_000);

  it('tries to recover when it has been flipped', () => {
    const flippable = design({ chassisId: 'wedge', weaponId: 'flipper', srimech: true });
    const { physics, fight } = makeFight(design(), flippable);
    const driver = new OpponentDriver('veteran');

    // Put it on its back.
    fight.blue.body.setRotation({ x: 1, y: 0, z: 0, w: 0 }, true);
    fight.blue.body.setTranslation({ x: 3, y: 0.4, z: 0 }, true);
    for (let i = 0; i < 30; i++) fight.update(FRAME);
    expect(fight.blue.isUpsideDown).toBe(true);

    let calledForSelfRight = false;
    for (let i = 0; i < 180; i++) {
      const control = driver.drive(fight.blue, fight.red, FRAME, true);
      if (control.selfRight) calledForSelfRight = true;
      fight.blue.control = control;
      fight.update(FRAME);
    }

    expect(calledForSelfRight, 'the AI did not try to self-right').toBe(true);
    // And the arm should actually work: it gets back on its wheels and returns
    // to fighting rather than sitting there calling for help.
    expect(fight.blue.isUpsideDown, 'it never got back onto its wheels').toBe(false);
    expect(driver.currentTactic).not.toBe('recover');
    physics.dispose();
  }, 30_000);

  it('is deterministic for a given seed', () => {
    const snapshot = () => {
      const { physics, fight } = makeFight();
      const driver = new OpponentDriver('veteran', 4242);
      runWithAi(fight, driver, 6);
      const out = { ...fight.blue.position };
      physics.dispose();
      return out;
    };
    const first = snapshot();
    const second = snapshot();
    expect(second.x).toBeCloseTo(first.x, 5);
    expect(second.z).toBeCloseTo(first.z, 5);
  }, 45_000);

  it('accepts every difficulty and drives on all of them', () => {
    for (const level of ['rookie', 'veteran', 'champion'] as Difficulty[]) {
      const { physics, fight } = makeFight();
      const driver = new OpponentDriver(level);
      const start = { ...fight.blue.position };
      runWithAi(fight, driver, 5);
      const moved = Math.hypot(
        fight.blue.position.x - start.x,
        fight.blue.position.z - start.z,
      );
      expect(moved, `${level} never moved`).toBeGreaterThan(0.3);
      physics.dispose();
    }
  }, 60_000);

  it('can actually win a fight against a robot that does nothing', () => {
    const { physics, fight } = makeFight(
      design({ chassisId: 'brick', weaponId: 'none', armorId: 'al6061' }),
      design({ weaponId: 'bar' }),
    );
    const driver = new OpponentDriver('champion');

    // The player robot sits there. It should get counted out.
    for (let i = 0; i < 60 * 30 && !fight.match.result; i++) {
      fight.blue.control = driver.drive(fight.blue, fight.red, FRAME, fight.match.live);
      fight.red.control = neutralControl();
      fight.update(FRAME);
    }

    expect(fight.match.result).not.toBeNull();
    expect(fight.match.result?.winner).toBe('b');
    physics.dispose();
  }, 60_000);
});
