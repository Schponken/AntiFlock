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

  it('goes to the judges when the clock runs out, and gives it to the better machine', () => {
    /*
     * Asserting "decision *or* draw" let the entire winner-and-scorecard branch be
     * replaced with a blanket draw and stay green. Put one machine clearly ahead
     * and demand the specific outcome.
     */
    const match = makeMatch({ roundSeconds: 3 });
    advance(match, 1);
    match.player.damageDealt = 8000;
    match.player.aggression = 12;
    match.player.control = 9;
    advance(match, 5);

    const outcome = match.result;
    expect(outcome, 'the round never resolved').toBeTruthy();
    expect(outcome!.kind, 'a clearly-won round was not scored as a decision').toBe('decision');
    if (outcome!.kind !== 'decision') throw new Error('unreachable');

    expect(outcome!.winner, 'the judges gave it to the machine that did nothing').toBe(
      match.player,
    );
    const card = outcome!.card;
    expect(card.draw).toBe(false);
    // 5-3-3 across damage, aggression and control, split between two machines.
    expect(card.total[0] + card.total[1]).toBeCloseTo(11, 6);
    expect(card.total[card.winner]).toBeGreaterThan(card.total[card.winner === 0 ? 1 : 0]);
    expect(card.damage[0]).toBeGreaterThan(card.damage[1]);
    expect(match.getState() === 'decision' || match.getState() === 'finished').toBe(true);
  });

  it('still reaches a draw when neither machine did anything', () => {
    /*
     * The companion to the test above: the draw branch is only reachable when the
     * two cards are *exactly* level, and in a live round both machines are driving,
     * so aggression and control drift apart within a frame or two. Hold both
     * tallies at zero right up to the bell to get the genuine 0-0 card.
     */
    const match = makeMatch({ roundSeconds: 3 });
    for (let t = 0; t < 5 && !match.result; t += 1 / 60) {
      for (const bot of [match.player, match.opponent]) {
        bot.damageDealt = 0;
        bot.aggression = 0;
        bot.control = 0;
      }
      match.update(1 / 60);
    }
    expect(match.result?.kind, 'a 0-0 round was not a draw').toBe('draw');
    if (match.result?.kind !== 'draw') throw new Error('unreachable');
    expect(match.result.card.draw).toBe(true);
    expect(match.result.card.total[0]).toBeCloseTo(match.result.card.total[1], 6);
    expect(match.result.card.unanimous, 'a 0-0 card was called unanimous').toBe(false);
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
