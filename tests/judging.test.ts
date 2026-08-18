import { describe, it, expect } from 'vitest';
import {
  AGGRESSION_POINTS,
  CONTROL_POINTS,
  DAMAGE_POINTS,
  JUDGE_COUNT,
  POINTS_PER_JUDGE,
  allocate,
  createScoreCard,
  judgeDecision,
  type ScoreCard,
} from '../src/sim/judging';

function card(over: Partial<ScoreCard> = {}): ScoreCard {
  return { ...createScoreCard(), ...over };
}

describe('point allocation', () => {
  it('splits an empty category down the middle', () => {
    expect(allocate(5, 0, 0, 0)).toBe(2);
  });

  it('sweeps the category for a dominant robot', () => {
    expect(allocate(DAMAGE_POINTS, 1000, 0, 0)).toBe(DAMAGE_POINTS);
    expect(allocate(DAMAGE_POINTS, 0, 1000, 0)).toBe(0);
  });

  it('never awards more than the category is worth, or less than zero', () => {
    for (const merit of [0, 1, 10, 1e6]) {
      for (const bias of [-0.5, -0.05, 0, 0.05, 0.5]) {
        const p = allocate(CONTROL_POINTS, merit, 10, bias);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(CONTROL_POINTS);
      }
    }
  });
});

describe('judges decision', () => {
  it('awards the full card to a robot that did everything', () => {
    const a = card({ damageDealtJ: 40_000, hpDealt: 400, aggressionTime: 90, hitsLanded: 20, controlTime: 80 });
    const b = card();
    const d = judgeDecision(a, b);
    expect(d.winner).toBe('a');
    expect(d.unanimous).toBe(true);
    expect(d.totalA).toBe(JUDGE_COUNT * POINTS_PER_JUDGE);
    expect(d.totalB).toBe(0);
  });

  it('always distributes exactly eleven points per judge', () => {
    const a = card({ damageDealtJ: 12_000, hpDealt: 90, aggressionTime: 40, hitsLanded: 6, controlTime: 30 });
    const b = card({ damageDealtJ: 9_000, hpDealt: 70, aggressionTime: 55, hitsLanded: 4, controlTime: 44 });
    const d = judgeDecision(a, b);
    for (const j of d.judges) {
      expect(j.totalA + j.totalB).toBe(POINTS_PER_JUDGE);
      expect(j.damage.a + j.damage.b).toBe(DAMAGE_POINTS);
      expect(j.aggression.a + j.aggression.b).toBe(AGGRESSION_POINTS);
      expect(j.control.a + j.control.b).toBe(CONTROL_POINTS);
    }
    expect(d.totalA + d.totalB).toBe(JUDGE_COUNT * POINTS_PER_JUDGE);
  });

  it('uses three judges', () => {
    expect(judgeDecision(card(), card()).judges.length).toBe(JUDGE_COUNT);
  });

  it('is deterministic for a given seed and varies with the seed', () => {
    const a = card({ damageDealtJ: 10_000, hpDealt: 80, aggressionTime: 50, controlTime: 40 });
    const b = card({ damageDealtJ: 9_800, hpDealt: 78, aggressionTime: 52, controlTime: 41 });
    expect(judgeDecision(a, b, 1).totalA).toBe(judgeDecision(a, b, 1).totalA);
    // Different panels can see a very close fight differently.
    const spread = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => judgeDecision(a, b, s).totalA));
    expect(spread.size).toBeGreaterThan(1);
  });

  it('rewards damage above everything else', () => {
    // A landed the big hits; B out-drove them everywhere else.
    const a = card({ damageDealtJ: 50_000, hpDealt: 350 });
    const b = card({ aggressionTime: 120, hitsLanded: 30, controlTime: 120 });
    const d = judgeDecision(a, b);
    expect(d.judges[0]!.damage.a).toBe(DAMAGE_POINTS);
    expect(d.judges[0]!.aggression.a).toBe(0);
  });

  it('credits control for driving the opponent into hazards', () => {
    const a = card({ controlTime: 20, hazardDeliveries: 6 });
    const b = card({ controlTime: 25 });
    const d = judgeDecision(a, b);
    expect(d.judges[0]!.control.a).toBeGreaterThan(d.judges[0]!.control.b);
  });

  it('describes the result for the broadcast graphic', () => {
    const d = judgeDecision(card({ hpDealt: 300, aggressionTime: 60, controlTime: 60 }), card());
    expect(d.summary).toMatch(/decision/i);
    expect(d.summary).toMatch(/\d+–\d+/);
  });

  it('can return a draw when nothing separates them', () => {
    const d = judgeDecision(card(), card());
    expect(d.totalA + d.totalB).toBe(JUDGE_COUNT * POINTS_PER_JUDGE);
    // With identical cards each judge splits every category the same way.
    expect(['a', 'b', 'draw']).toContain(d.winner);
  });
});
