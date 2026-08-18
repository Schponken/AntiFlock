import { describe, it, expect } from 'vitest';
import {
  KO_COUNT,
  MATCH_DURATION,
  Match,
  START_SEQUENCE,
  START_SEQUENCE_DURATION,
  formatLine,
  type BotTickInput,
  type MatchEvent,
} from '../src/sim/match';

const ALIVE: BotTickInput = { immobilised: false, speed: 3, destroyed: false };
const DEAD_STILL: BotTickInput = { immobilised: true, speed: 0, destroyed: false };

/** Run the match forward and collect every event that fired. */
function run(m: Match, seconds: number, a: BotTickInput, b: BotTickInput, dt = 1 / 60): MatchEvent[] {
  const out: MatchEvent[] = [];
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) out.push(...m.tick(dt, a, b));
  return out;
}

describe('start sequence', () => {
  it('is ordered and ends on activate', () => {
    for (let i = 1; i < START_SEQUENCE.length; i++) {
      expect(START_SEQUENCE[i]!.t).toBeGreaterThanOrEqual(START_SEQUENCE[i - 1]!.t);
    }
    expect(START_SEQUENCE[START_SEQUENCE.length - 1]!.kind).toBe('activate');
    expect(START_SEQUENCE_DURATION).toBeGreaterThan(8);
  });

  it('runs the whole show: dark, introductions, start light, three-two-one, activate', () => {
    const m = new Match();
    m.start();
    expect(m.phase).toBe('intro');

    const events = run(m, START_SEQUENCE_DURATION + 0.1, ALIVE, ALIVE);
    const kinds = events.filter((e) => e.kind === 'cue').map((e) => e.cue!.kind);

    expect(kinds).toEqual([
      'house-lights-down',
      'crowd-swell',
      'spotlight-sweep',
      'introduce-red',
      'introduce-blue',
      'lights-full',
      'start-light-red',
      'drivers-ready',
      'count-3',
      'count-2',
      'count-1',
      'activate',
    ]);
    expect(events.some((e) => e.kind === 'fight-start')).toBe(true);
    expect(m.phase).toBe('fight');
    expect(m.live).toBe(true);
  });

  it('counts down exactly one second apart', () => {
    const t3 = START_SEQUENCE.find((c) => c.kind === 'count-3')!.t;
    const t2 = START_SEQUENCE.find((c) => c.kind === 'count-2')!.t;
    const t1 = START_SEQUENCE.find((c) => c.kind === 'count-1')!.t;
    const go = START_SEQUENCE.find((c) => c.kind === 'activate')!.t;
    expect(t2 - t3).toBeCloseTo(1, 6);
    expect(t1 - t2).toBeCloseTo(1, 6);
    expect(go - t1).toBeCloseTo(1, 6);
  });

  it('fires every cue exactly once', () => {
    const m = new Match();
    m.start();
    const events = run(m, START_SEQUENCE_DURATION + 5, ALIVE, ALIVE);
    const kinds = events.filter((e) => e.kind === 'cue').map((e) => e.cue!.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.length).toBe(START_SEQUENCE.length);
  });

  it('keeps the robots locked until activate', () => {
    const m = new Match();
    m.start();
    run(m, START_SEQUENCE_DURATION - 0.5, ALIVE, ALIVE);
    expect(m.live).toBe(false);
    run(m, 1, ALIVE, ALIVE);
    expect(m.live).toBe(true);
  });

  it('can be skipped straight into the fight without losing cues', () => {
    const m = new Match();
    m.start();
    m.skipIntro();
    expect(m.phase).toBe('fight');
    const events = m.tick(1 / 60, ALIVE, ALIVE);
    const kinds = events.filter((e) => e.kind === 'cue').map((e) => e.cue!.kind);
    expect(kinds).toContain('activate');
    expect(events.some((e) => e.kind === 'fight-start')).toBe(true);
  });

  it('substitutes robot names into announcer lines', () => {
    const line = START_SEQUENCE.find((c) => c.kind === 'introduce-red')!.line!;
    expect(formatLine(line, 'ANTIFLOCK', 'MAGNETRON')).toBe('In the red square — ANTIFLOCK!');
  });
});

describe('fight clock', () => {
  it('runs for three minutes and then goes to the judges', () => {
    const m = new Match();
    m.start();
    m.skipIntro();
    expect(m.timeRemaining).toBe(MATCH_DURATION);

    const events = run(m, MATCH_DURATION + 1, ALIVE, ALIVE, 1 / 30);
    expect(m.timeRemaining).toBe(0);
    expect(events.some((e) => e.kind === 'time-expired')).toBe(true);
    expect(m.phase).toBe('decision');
  });

  it('records a judges decision and closes the match', () => {
    const m = new Match();
    m.start();
    m.skipIntro();
    run(m, MATCH_DURATION + 1, ALIVE, ALIVE, 1 / 30);
    const result = m.concludeByDecision('a');
    expect(result.winner).toBe('a');
    expect(result.reason).toBe('decision');
    expect(m.phase).toBe('over');
  });

  it('does not tick the clock before the fight starts', () => {
    const m = new Match();
    m.start();
    run(m, 3, ALIVE, ALIVE);
    expect(m.timeRemaining).toBe(MATCH_DURATION);
  });
});

describe('knockout count', () => {
  it('counts a stopped robot out in ten seconds', () => {
    const m = new Match();
    m.start();
    m.skipIntro();

    const events = run(m, 20, DEAD_STILL, ALIVE, 1 / 60);
    expect(events.some((e) => e.kind === 'ko-start' && e.side === 'a')).toBe(true);
    const ticks = events.filter((e) => e.kind === 'ko-tick' && e.side === 'a');
    expect(ticks.length).toBe(KO_COUNT);
    expect(ticks.map((t) => t.count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(events.some((e) => e.kind === 'ko-complete' && e.side === 'a')).toBe(true);
    expect(m.result?.winner).toBe('b');
    expect(m.result?.reason).toBe('knockout');
    expect(m.phase).toBe('over');
  });

  it('resets the count if the robot gets moving again', () => {
    const m = new Match();
    m.start();
    m.skipIntro();

    // Four seconds motionless, then it drives off.
    const stopped = run(m, 6, DEAD_STILL, ALIVE);
    expect(stopped.some((e) => e.kind === 'ko-start' && e.side === 'a')).toBe(true);

    const recovered = run(m, 2, ALIVE, ALIVE);
    expect(recovered.some((e) => e.kind === 'ko-reset' && e.side === 'a')).toBe(true);
    expect(m.ko.a.counting).toBe(false);
    expect(m.result).toBeNull();
  });

  it('does not start counting for a brief pause', () => {
    const m = new Match();
    m.start();
    m.skipIntro();
    const events = run(m, 0.8, { immobilised: false, speed: 0, destroyed: false }, ALIVE);
    expect(events.some((e) => e.kind === 'ko-start')).toBe(false);
  });

  it('ends the fight immediately for a robot that is destroyed outright', () => {
    const m = new Match();
    m.start();
    m.skipIntro();
    const events = run(m, 0.5, { immobilised: true, speed: 0, destroyed: true }, ALIVE);
    expect(events.some((e) => e.kind === 'ko-complete' && e.side === 'a')).toBe(true);
    expect(m.result?.winner).toBe('b');
  });

  it('does not count anybody out before the fight is live', () => {
    const m = new Match();
    m.start();
    const events = run(m, 5, DEAD_STILL, DEAD_STILL);
    expect(events.some((e) => e.kind === 'ko-start')).toBe(false);
  });

  it('produces the same result at any timestep', () => {
    const outcome = (dt: number) => {
      const m = new Match();
      m.start();
      m.skipIntro();
      run(m, 20, DEAD_STILL, ALIVE, dt);
      return m.result;
    };
    const a = outcome(1 / 60);
    const b = outcome(1 / 120);
    expect(a?.winner).toBe(b?.winner);
    expect(a?.reason).toBe(b?.reason);
    expect(a!.atTime).toBeCloseTo(b!.atTime, 1);
  });
});
