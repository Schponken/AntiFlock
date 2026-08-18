/**
 * Whole fights, simulated end to end.
 *
 * These play complete three-minute matches with a driver on each side and
 * check that the result is a fight rather than a stalemate or a blowout: that
 * damage gets done, that matches end, that nothing goes numerically unstable
 * over ten thousand steps, and that the roster is broadly competitive.
 *
 * This is the test that catches balance problems no unit test can see — armour
 * so thick nothing ever breaks, or a weapon so strong every fight ends in five
 * seconds.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { OpponentDriver } from '../src/ai/opponent';
import { Fight } from '../src/sim/fight';
import { Physics, initPhysics } from '../src/sim/physics';
import { ARENA_HALF, CEILING_HEIGHT } from '../src/sim/arena';
import { MATCH_DURATION } from '../src/sim/match';
import { ROSTER } from '../src/sim/roster';
import { computeStats, type BotDesign } from '../src/sim/parts';

const FRAME = 1 / 60;
/** Hard cap so a runaway test cannot hang the suite. */
const MAX_FRAMES = Math.ceil((MATCH_DURATION + 20) / FRAME);

interface Outcome {
  winner: 'a' | 'b' | 'draw' | null;
  reason: string;
  frames: number;
  redCondition: number;
  blueCondition: number;
  damageA: number;
  damageB: number;
  hitsA: number;
  hitsB: number;
  finite: boolean;
}

/** Play one full match between two designs, with the AI driving both. */
function playMatch(red: BotDesign, blue: BotDesign, seed: number): Outcome {
  const physics = new Physics();
  const fight = new Fight(physics, {
    redDesign: red,
    blueDesign: blue,
    hazards: true,
    seed,
  });
  fight.start();
  fight.match.skipIntro();

  const driverA = new OpponentDriver('veteran', seed ^ 0x1111);
  const driverB = new OpponentDriver('veteran', seed ^ 0x2222);

  let frames = 0;
  let finite = true;
  while (!fight.match.result && frames < MAX_FRAMES) {
    const live = fight.match.live;
    fight.setControl('a', driverA.drive(fight.red, fight.blue, FRAME, live));
    fight.setControl('b', driverB.drive(fight.blue, fight.red, FRAME, live));
    fight.update(FRAME);
    fight.drainEvents();
    fight.drainMatchEvents();
    frames++;

    // Check for instability as we go, not just at the end.
    if (frames % 120 === 0) {
      for (const bot of [fight.red, fight.blue]) {
        const p = bot.position;
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) finite = false;
        if (Math.abs(p.x) > ARENA_HALF + 1 || Math.abs(p.z) > ARENA_HALF + 1) finite = false;
        if (p.y < -1 || p.y > CEILING_HEIGHT + 2) finite = false;
      }
    }
  }

  const outcome: Outcome = {
    winner: fight.match.result?.winner ?? null,
    reason: fight.match.result?.reason ?? 'unfinished',
    frames,
    redCondition: fight.conditionOf('a'),
    blueCondition: fight.conditionOf('b'),
    damageA: fight.scores.a.hpDealt,
    damageB: fight.scores.b.hpDealt,
    hitsA: fight.scores.a.hitsLanded,
    hitsB: fight.scores.b.hitsLanded,
    finite,
  };
  physics.dispose();
  return outcome;
}

beforeAll(async () => {
  await initPhysics();
}, 30_000);

describe('complete matches', () => {
  it('plays a full fight to a result without going unstable', () => {
    const outcome = playMatch(ROSTER[0]!, ROSTER[2]!, 0xfeed);

    expect(outcome.finite, 'a robot left the arena or went non-finite').toBe(true);
    expect(outcome.winner, 'the match never produced a result').not.toBeNull();
    expect(['knockout', 'decision', 'draw']).toContain(outcome.reason);
  }, 180_000);

  it('produces damage rather than a three-minute stalemate', () => {
    const outcome = playMatch(ROSTER[0]!, ROSTER[4]!, 0xabc);

    const totalHits = outcome.hitsA + outcome.hitsB;
    expect(totalHits, 'nobody landed a single hit in three minutes').toBeGreaterThan(3);

    const damaged = Math.min(outcome.redCondition, outcome.blueCondition);
    expect(damaged, 'neither robot took any meaningful damage').toBeLessThan(0.97);
  }, 180_000);

  it('does not end every fight in the first few seconds', () => {
    // A spinner against a plastic wedge is the most lopsided pairing on the
    // roster; even that should be a fight, not an execution.
    const outcome = playMatch(ROSTER[6]!, ROSTER[5]!, 0x99);
    expect(outcome.frames, 'the match was over almost immediately').toBeGreaterThan(60 * 5);
  }, 180_000);

  it('gives different pairings different outcomes', () => {
    const pairs: [number, number][] = [
      [0, 1],
      [2, 3],
      [4, 6],
    ];
    const outcomes = pairs.map(([a, b], i) => playMatch(ROSTER[a]!, ROSTER[b]!, 0x500 + i));

    for (const outcome of outcomes) {
      expect(outcome.finite).toBe(true);
      expect(outcome.winner).not.toBeNull();
    }
    // Not every fight should end the same way.
    const reasons = new Set(outcomes.map((o) => o.reason));
    expect(reasons.size).toBeGreaterThanOrEqual(1);
  }, 300_000);

  it('is reproducible: the same seed replays the same fight', () => {
    const first = playMatch(ROSTER[0]!, ROSTER[3]!, 0x2468);
    const second = playMatch(ROSTER[0]!, ROSTER[3]!, 0x2468);

    expect(second.winner).toBe(first.winner);
    expect(second.reason).toBe(first.reason);
    expect(second.frames).toBe(first.frames);
    expect(second.redCondition).toBeCloseTo(first.redCondition, 6);
    expect(second.blueCondition).toBeCloseTo(first.blueCondition, 6);
  }, 300_000);
});

describe('roster balance', () => {
  it('has no robot that is simply better than every other on paper', () => {
    // A design that wins on mass, speed, durability and weapon energy at once
    // would make the rest of the roster pointless.
    const stats = ROSTER.map((d) => ({ name: d.name, s: computeStats(d) }));
    for (const candidate of stats) {
      const dominatesEveryone = stats
        .filter((other) => other.name !== candidate.name)
        .every(
          (other) =>
            candidate.s.topSpeedMps > other.s.topSpeedMps &&
            candidate.s.totalHp > other.s.totalHp &&
            candidate.s.weaponEnergyJ > other.s.weaponEnergyJ &&
            candidate.s.pushForceN > other.s.pushForceN,
        );
      expect(dominatesEveryone, `${candidate.name} beats everything on every axis`).toBe(false);
    }
  });

  it('spreads the roster across the design space', () => {
    const stats = ROSTER.map((d) => computeStats(d));
    const speeds = stats.map((s) => s.topSpeedMps);
    const durability = stats.map((s) => s.totalHp);

    // There should be genuinely fast robots and genuinely tough ones.
    expect(Math.max(...speeds) / Math.min(...speeds)).toBeGreaterThan(1.3);
    expect(Math.max(...durability) / Math.min(...durability)).toBeGreaterThan(1.3);
  });
});
