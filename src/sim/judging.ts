/**
 * Judges' scoring, following the real rulebook: when a fight goes the
 * distance, three judges each award eleven points — five for damage, three for
 * aggression, three for control — and the robot with the most points wins.
 *
 * Pure module. The accumulators are fed by the match loop every tick.
 */

import { clamp01 } from '../core/math';
import { Rng } from '../core/rng';

export const DAMAGE_POINTS = 5;
export const AGGRESSION_POINTS = 3;
export const CONTROL_POINTS = 3;
export const POINTS_PER_JUDGE = DAMAGE_POINTS + AGGRESSION_POINTS + CONTROL_POINTS; // 11
export const JUDGE_COUNT = 3;

/** Running totals for one robot over the course of a fight. */
export interface ScoreCard {
  /** Energy delivered into the opponent, joules. Drives the damage category. */
  damageDealtJ: number;
  /** Hit points removed from the opponent. */
  hpDealt: number;
  /** Seconds spent driving at the opponent and initiating contact. */
  aggressionTime: number;
  /** Number of times this robot initiated a hit. */
  hitsLanded: number;
  /** Seconds spent controlling the fight — pinning, shoving, steering them into hazards. */
  controlTime: number;
  /** Seconds this robot spent being pushed around or stuck on a wall. */
  timeControlled: number;
  /** Times this robot drove the opponent into an arena hazard. */
  hazardDeliveries: number;
}

export function createScoreCard(): ScoreCard {
  return {
    damageDealtJ: 0,
    hpDealt: 0,
    aggressionTime: 0,
    hitsLanded: 0,
    controlTime: 0,
    timeControlled: 0,
    hazardDeliveries: 0,
  };
}

export interface CategoryScore {
  a: number;
  b: number;
}

export interface JudgeScore {
  damage: CategoryScore;
  aggression: CategoryScore;
  control: CategoryScore;
  totalA: number;
  totalB: number;
}

export interface Decision {
  judges: JudgeScore[];
  totalA: number;
  totalB: number;
  /** 'a', 'b', or 'draw' when the totals tie exactly. */
  winner: 'a' | 'b' | 'draw';
  /** True when every judge agreed. */
  unanimous: boolean;
  /** Human-readable summary for the broadcast graphic. */
  summary: string;
}

/**
 * Split a category's points between two robots given each one's raw merit.
 * A judge cannot award half a point, and a clear advantage sweeps the category
 * the way a real panel would score it.
 */
export function allocate(total: number, meritA: number, meritB: number, bias: number): number {
  const sum = meritA + meritB;
  if (sum <= 0) {
    // Nothing happened at all — the panel splits it as evenly as it can.
    return Math.floor(total / 2);
  }
  const ratio = clamp01(meritA / sum + bias);
  // Push the ratio away from the middle: judges reward a decisive edge.
  const decisive = clamp01(0.5 + (ratio - 0.5) * 1.55);
  return Math.round(decisive * total);
}

/**
 * Score a completed fight. `seed` makes the panel deterministic for a given
 * match so the same fight always produces the same decision.
 */
export function judgeDecision(a: ScoreCard, b: ScoreCard, seed = 0x5eed): Decision {
  const rng = new Rng(seed);
  const judges: JudgeScore[] = [];

  // Merit for each category, blending the raw numbers the way judges describe
  // their own reasoning.
  const dmgA = a.damageDealtJ * 0.7 + a.hpDealt * 22;
  const dmgB = b.damageDealtJ * 0.7 + b.hpDealt * 22;
  const aggA = a.aggressionTime * 1.0 + a.hitsLanded * 2.4;
  const aggB = b.aggressionTime * 1.0 + b.hitsLanded * 2.4;
  const ctlA = a.controlTime * 1.0 + a.hazardDeliveries * 8 + b.timeControlled * 0.5;
  const ctlB = b.controlTime * 1.0 + b.hazardDeliveries * 8 + a.timeControlled * 0.5;

  for (let i = 0; i < JUDGE_COUNT; i++) {
    // Each judge sees the fight slightly differently.
    const bias = rng.gaussian(0.035);

    const dA = allocate(DAMAGE_POINTS, dmgA, dmgB, bias);
    const gA = allocate(AGGRESSION_POINTS, aggA, aggB, bias);
    const cA = allocate(CONTROL_POINTS, ctlA, ctlB, bias);

    const score: JudgeScore = {
      damage: { a: dA, b: DAMAGE_POINTS - dA },
      aggression: { a: gA, b: AGGRESSION_POINTS - gA },
      control: { a: cA, b: CONTROL_POINTS - cA },
      totalA: dA + gA + cA,
      totalB: POINTS_PER_JUDGE - (dA + gA + cA),
    };
    judges.push(score);
  }

  const totalA = judges.reduce((s, j) => s + j.totalA, 0);
  const totalB = judges.reduce((s, j) => s + j.totalB, 0);
  const winner: Decision['winner'] = totalA > totalB ? 'a' : totalB > totalA ? 'b' : 'draw';

  const perJudgeWinners = judges.map((j) => (j.totalA > j.totalB ? 'a' : j.totalA < j.totalB ? 'b' : 'draw'));
  const unanimous = winner !== 'draw' && perJudgeWinners.every((w) => w === winner);

  const summary =
    winner === 'draw'
      ? `Split decision, ${totalA}–${totalB}. The judges cannot separate them.`
      : `${unanimous ? 'Unanimous' : 'Split'} decision, ${Math.max(totalA, totalB)}–${Math.min(totalA, totalB)}.`;

  return { judges, totalA, totalB, winner, unanimous, summary };
}
