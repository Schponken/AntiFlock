/**
 * Match flow: the fight clock, the knockout count, and the broadcast start
 * sequence.
 *
 * The start sequence is a data-driven cue list so the lighting rig, the audio
 * engine and the on-screen graphics all read from one timeline and stay in
 * lockstep. Advancing it is a pure function of elapsed time, which means it can
 * be unit tested without a browser.
 */

import { clamp01 } from '../core/math';

export const MATCH_DURATION = 180; // three minutes, same as the show
export const KO_COUNT = 10; // a downed robot gets a ten count
export const KO_MOVEMENT_THRESHOLD = 0.35; // m/s that counts as "still moving"
/** Yaw rate that also counts as movement — spinning on the spot is not dead. */
export const KO_YAW_THRESHOLD = 0.7;
/** Sustained translation needed to reset the count once it has started. */
export const KO_RECOVERY_TIME = 0.45;

export type MatchPhase =
  | 'idle'
  | 'intro'
  | 'countdown'
  | 'fight'
  | 'knockout'
  | 'decision'
  | 'over';

export type CueKind =
  | 'house-lights-down'
  | 'spotlight-sweep'
  | 'crowd-swell'
  | 'introduce-red'
  | 'introduce-blue'
  | 'lights-full'
  | 'start-light-red'
  | 'drivers-ready'
  | 'count-3'
  | 'count-2'
  | 'count-1'
  | 'activate';

export interface Cue {
  /** Seconds from the start of the sequence. */
  readonly t: number;
  readonly kind: CueKind;
  /** Announcer line, where the cue has one. `{red}`/`{blue}` are substituted. */
  readonly line?: string;
}

/**
 * The opening sequence, beat for beat: the house goes dark, the spotlights
 * sweep the cage, both robots are introduced, the lights slam back up, the
 * start light goes red, and then three, two, one — activate.
 */
export const START_SEQUENCE: readonly Cue[] = [
  { t: 0.0, kind: 'house-lights-down' },
  { t: 0.15, kind: 'crowd-swell' },
  { t: 0.7, kind: 'spotlight-sweep' },
  { t: 1.6, kind: 'introduce-red', line: 'In the red square — {red}!' },
  { t: 4.4, kind: 'introduce-blue', line: 'And in the blue square — {blue}!' },
  { t: 7.2, kind: 'lights-full' },
  { t: 7.5, kind: 'start-light-red' },
  { t: 8.0, kind: 'drivers-ready', line: 'Drivers, take your positions.' },
  { t: 10.4, kind: 'count-3', line: 'Three' },
  { t: 11.4, kind: 'count-2', line: 'Two' },
  { t: 12.4, kind: 'count-1', line: 'One' },
  { t: 13.4, kind: 'activate', line: 'Activate!' },
];

export const START_SEQUENCE_DURATION = START_SEQUENCE[START_SEQUENCE.length - 1]!.t;

/** Per-robot state the match loop needs each tick. */
export interface BotTickInput {
  /** The damage model says this robot can no longer drive. */
  immobilised: boolean;
  /** Current ground speed in m/s, used to judge whether it is still moving. */
  speed: number;
  /**
   * Yaw rate in rad/s. A robot pirouetting on the spot has almost no ground
   * speed but is plainly still under power, and a referee would not count it
   * out — so translation alone is not enough to judge mobility.
   */
  yawRate?: number;
  /** True once the robot has been counted out or destroyed outright. */
  destroyed: boolean;
}

/** Is this robot showing enough movement to stop the count? */
export function isMoving(input: BotTickInput): boolean {
  if (input.immobilised) return false;
  return input.speed > KO_MOVEMENT_THRESHOLD || Math.abs(input.yawRate ?? 0) > KO_YAW_THRESHOLD;
}

export type WinReason = 'knockout' | 'decision' | 'draw' | 'none';

export interface MatchResult {
  winner: 'a' | 'b' | 'draw';
  reason: WinReason;
  /** Seconds into the fight the result was decided. */
  atTime: number;
}

export interface KoState {
  /** Counting down on this robot right now. */
  counting: boolean;
  /** Seconds elapsed on the count. */
  elapsed: number;
  /** Whole seconds shown on the referee's count, 1..10. */
  displayed: number;
  /** Seconds of sustained movement banked toward resetting the count. */
  recovery: number;
}

function newKoState(): KoState {
  return { counting: false, elapsed: 0, displayed: 0, recovery: 0 };
}

export interface MatchEvent {
  kind:
    | 'cue'
    | 'fight-start'
    | 'ko-start'
    | 'ko-tick'
    | 'ko-reset'
    | 'ko-complete'
    | 'time-expired'
    | 'match-over';
  cue?: Cue;
  /** Which robot the event concerns, when it is robot-specific. */
  side?: 'a' | 'b';
  /** Count value for `ko-tick`. */
  count?: number;
}

export class Match {
  phase: MatchPhase = 'idle';
  /** Seconds remaining on the fight clock. */
  timeRemaining = MATCH_DURATION;
  /** Seconds elapsed inside the current phase. */
  phaseTime = 0;
  /** Seconds elapsed in the start sequence. */
  sequenceTime = 0;
  ko: { a: KoState; b: KoState } = { a: newKoState(), b: newKoState() };
  result: MatchResult | null = null;

  private firedCues = new Set<CueKind>();
  private pending: MatchEvent[] = [];

  /** Begin the broadcast opening. */
  start(): void {
    this.phase = 'intro';
    this.phaseTime = 0;
    this.sequenceTime = 0;
    this.timeRemaining = MATCH_DURATION;
    this.ko = { a: newKoState(), b: newKoState() };
    this.result = null;
    this.firedCues.clear();
    this.pending.length = 0;
  }

  /** Jump straight to the fight, for testing or for an impatient player. */
  skipIntro(): void {
    if (this.phase !== 'intro' && this.phase !== 'countdown') return;
    this.sequenceTime = START_SEQUENCE_DURATION;
    for (const cue of START_SEQUENCE) {
      if (!this.firedCues.has(cue.kind)) {
        this.firedCues.add(cue.kind);
        this.pending.push({ kind: 'cue', cue });
      }
    }
    this.beginFight();
  }

  /** True once the robots are allowed to move. */
  get live(): boolean {
    return this.phase === 'fight' || this.phase === 'knockout';
  }

  /** 0..1 progress through the start sequence, for the intro graphics. */
  get sequenceProgress(): number {
    return clamp01(this.sequenceTime / START_SEQUENCE_DURATION);
  }

  /**
   * Advance the match. Returns the events that fired this tick so the caller
   * can drive audio, lights and UI from them.
   */
  tick(dt: number, a: BotTickInput, b: BotTickInput): MatchEvent[] {
    const events = this.pending;
    this.pending = [];
    this.phaseTime += dt;

    switch (this.phase) {
      case 'idle':
      case 'over':
        break;

      case 'intro':
      case 'countdown': {
        this.sequenceTime += dt;
        for (const cue of START_SEQUENCE) {
          if (this.sequenceTime >= cue.t && !this.firedCues.has(cue.kind)) {
            this.firedCues.add(cue.kind);
            events.push({ kind: 'cue', cue });
            if (cue.kind === 'count-3') this.phase = 'countdown';
            if (cue.kind === 'activate') this.beginFight(events);
          }
        }
        break;
      }

      case 'fight':
      case 'knockout': {
        this.timeRemaining = Math.max(0, this.timeRemaining - dt);
        this.tickKo('a', a, dt, events);
        this.tickKo('b', b, dt, events);

        if (this.result) break;

        if (this.timeRemaining <= 0) {
          events.push({ kind: 'time-expired' });
          this.phase = 'decision';
          this.phaseTime = 0;
        }
        break;
      }

      case 'decision':
        break;
    }

    return events;
  }

  /** Record the judges' verdict and close the match out. */
  concludeByDecision(winner: 'a' | 'b' | 'draw'): MatchResult {
    const result: MatchResult = {
      winner,
      reason: winner === 'draw' ? 'draw' : 'decision',
      atTime: MATCH_DURATION - this.timeRemaining,
    };
    this.result = result;
    this.phase = 'over';
    this.phaseTime = 0;
    this.pending.push({ kind: 'match-over' });
    return result;
  }

  private beginFight(sink?: MatchEvent[]): void {
    this.phase = 'fight';
    this.phaseTime = 0;
    (sink ?? this.pending).push({ kind: 'fight-start' });
  }

  private tickKo(side: 'a' | 'b', input: BotTickInput, dt: number, events: MatchEvent[]): void {
    const state = this.ko[side];

    if (input.destroyed) {
      // Nothing left to count.
      if (!this.result) this.finishByKnockout(side, events);
      return;
    }

    const moving = isMoving(input);

    if (!state.counting) {
      if (!moving) {
        // Only start counting once it has genuinely stopped, not on a pause.
        state.recovery -= dt;
        if (state.recovery <= -1.2) {
          state.counting = true;
          state.elapsed = 0;
          state.displayed = 0;
          state.recovery = 0;
          events.push({ kind: 'ko-start', side });
        }
      } else {
        state.recovery = 0;
      }
      return;
    }

    // Counting.
    if (moving) {
      state.recovery += dt;
      if (state.recovery >= KO_RECOVERY_TIME) {
        state.counting = false;
        state.elapsed = 0;
        state.displayed = 0;
        state.recovery = 0;
        events.push({ kind: 'ko-reset', side });
        return;
      }
    } else {
      state.recovery = Math.max(0, state.recovery - dt * 0.5);
    }

    const before = state.displayed;
    state.elapsed += dt;
    state.displayed = Math.min(KO_COUNT, Math.floor(state.elapsed) + 1);
    if (state.displayed !== before) {
      events.push({ kind: 'ko-tick', side, count: state.displayed });
    }

    this.phase = 'knockout';

    if (state.elapsed >= KO_COUNT) {
      this.finishByKnockout(side, events);
    }
  }

  private finishByKnockout(loser: 'a' | 'b', events: MatchEvent[]): void {
    const winner: 'a' | 'b' = loser === 'a' ? 'b' : 'a';
    this.result = {
      winner,
      reason: 'knockout',
      atTime: MATCH_DURATION - this.timeRemaining,
    };
    this.phase = 'over';
    this.phaseTime = 0;
    events.push({ kind: 'ko-complete', side: loser });
    events.push({ kind: 'match-over' });
  }
}

/** Fill `{red}` / `{blue}` into an announcer line. */
export function formatLine(line: string, redName: string, blueName: string): string {
  return line.replace('{red}', redName).replace('{blue}', blueName);
}
