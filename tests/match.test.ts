/**
 * The match, headless.
 *
 * The clock, the knockout hand-off and the judges' cards are plain bookkeeping,
 * but `Match` was reachable only through a real WebGL `Stage`, so none of it was
 * covered — `onKnockout`, the hand-off from the primary win condition to the
 * results screen, could be replaced with `return;` and the whole suite stayed
 * green. These drive the real class with `headless: true`.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { initRapier } from '../src/physics/world.ts';
import { Match, type MatchOutcome } from '../src/game/match.ts';
import { CameraDirector } from '../src/render/cameras.ts';
import { presetById } from '../src/game/design.ts';
import type { Stage } from '../src/render/renderer.ts';

beforeAll(async () => {
  await initRapier();
});

const matches: Match[] = [];
afterEach(() => {
  for (const match of matches.splice(0)) match.dispose();
});

/** A Stage stand-in: `Match` only ever touches the scene and the bloom boost. */
function stubStage(): Stage {
  return {
    scene: new THREE.Scene(),
    setBloomBoost: () => {},
  } as unknown as Stage;
}

function makeMatch(options: { roundSeconds?: number } = {}): Match {
  const match = new Match({
    playerDesign: presetById('sparkplug').design,
    opponentDesign: presetById('doorstop').design,
    difficulty: 'veteran',
    stage: stubStage(),
    camera: new CameraDirector(),
    quickStart: true,
    headless: true,
    roundSeconds: options.roundSeconds ?? 180,
  });
  matches.push(match);
  return match;
}

/** Advance the match the way the app does: one presentation frame at a time. */
const advance = (match: Match, seconds: number, step = 1 / 60): void => {
  for (let t = 0; t < seconds; t += step) match.update(step);
};

describe('match', () => {
  it('hands a knockout to the results screen with the right winner', () => {
    const match = makeMatch();
    advance(match, 0.5);
    expect(match.getState()).toBe('fighting');

    const outcomes: MatchOutcome[] = [];
    match.events.on('outcome', (outcome) => outcomes.push(outcome));

    // Count the opponent out: the primary win condition in the real sport.
    match.opponent.damage.countOut();
    advance(match, 1);

    expect(outcomes.length, 'no outcome was ever emitted').toBe(1);
    const outcome = outcomes[0]!;
    expect(outcome.kind).toBe('ko');
    if (outcome.kind !== 'ko') throw new Error('unreachable');
    expect(outcome.winner).toBe(match.player);
    expect(outcome.loser).toBe(match.opponent);
    expect(match.getState()).toBe('knockout');
    expect(match.combat.isRunning, 'the fight kept running after the knockout').toBe(false);
    expect(match.result).toBe(outcome);
  });

  it('stops the clock at the knockout instead of running the round out', () => {
    const match = makeMatch();
    advance(match, 1);
    const before = match.timeRemaining;
    match.opponent.damage.countOut();
    advance(match, 3);
    expect(before - match.timeRemaining).toBeLessThan(2);
  });

  it('goes to the judges when the clock runs out, and the card adds up', () => {
    const match = makeMatch({ roundSeconds: 3 });
    advance(match, 5);

    const outcome = match.result;
    expect(outcome, 'the round never resolved').toBeTruthy();
    expect(outcome!.kind === 'decision' || outcome!.kind === 'draw').toBe(true);
    if (outcome!.kind === 'decision') {
      const card = outcome!.card;
      // 5-3-3 across damage, aggression and control, split between two machines.
      const total = card.total[0] + card.total[1];
      expect(total).toBeCloseTo(11, 6);
      expect(card.total[card.winner]).toBeGreaterThanOrEqual(card.total[card.winner === 0 ? 1 : 0]);
    }
    expect(match.getState() === 'decision' || match.getState() === 'finished').toBe(true);
  });

  it('runs the clock on wall time, not on the number of physics steps', () => {
    // The presentation clock and the solver clock are deliberately separate: a
    // three-minute round is three minutes whatever the frame rate.
    const fast = makeMatch({ roundSeconds: 60 });
    const slow = makeMatch({ roundSeconds: 60 });
    advance(fast, 4, 1 / 240);
    advance(slow, 4, 1 / 20);
    expect(fast.timeRemaining).toBeCloseTo(slow.timeRemaining, 0);
    expect(fast.world.stepCount).toBeGreaterThan(0);
    expect(Math.abs(60 - fast.timeRemaining - 4)).toBeLessThan(0.6);
  });

  it('never lets a disposed match keep driving the announcer', () => {
    const match = makeMatch();
    advance(match, 0.5);
    const captions: string[] = [];
    match.events.on('caption', ({ text }) => captions.push(text));
    match.dispose();
    matches.pop();

    // A second match must not be able to reach the first one's emitter.
    const next = makeMatch();
    advance(next, 1);
    expect(captions, 'a disposed match was still receiving announcer lines').toEqual([]);
  });
});
