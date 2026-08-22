/**
 * Adaptive quality, driven directly.
 *
 * `Stage.adapt` is pure arithmetic over a frame-time average, so it can be
 * exercised without a GPU by calling it against a stand-in `this`. It needed
 * covering: the previous version discarded every frame longer than 0.2 s as a
 * stall, which meant the entire 2-5 fps band never moved the average and a
 * machine that was genuinely too slow never dropped a tier — precisely the
 * machine the adaptive path exists for.
 */

import { describe, expect, it } from 'vitest';
import { Stage } from '../src/render/renderer.ts';

interface AdaptState {
  frameMs: number;
  sinceAdapt: number;
  quality: string;
  overBudgetWindows: number;
  setQuality(quality: string): void;
}

/** Run `adapt` for `frames` frames of `dt` and report where it ended up. */
function drive(dt: number, frames = 800, from = 'high'): { quality: string; steps: string[] } {
  const steps: string[] = [];
  const state: AdaptState = {
    frameMs: 16.7,
    sinceAdapt: 0,
    quality: from,
    overBudgetWindows: 0,
    setQuality(quality: string) {
      steps.push(quality);
      this.quality = quality;
    },
  };
  const adapt = (Stage.prototype as unknown as Record<string, (dt: number) => void>).adapt;
  for (let i = 0; i < frames; i++) adapt.call(state, dt);
  return { quality: state.quality, steps };
}

describe('adaptive quality', () => {
  it('leaves a machine that is keeping up alone', () => {
    expect(drive(1 / 60).steps).toEqual([]);
    expect(drive(1 / 30).steps, 'a steady 30 fps is not a reason to drop tiers').toEqual([]);
  });

  it('steps down for a machine that is missing frames', () => {
    expect(drive(0.045).steps).toEqual(['medium', 'low']);
  });

  it('still steps down when the machine is very slow indeed', () => {
    // 4, 3 and 2 fps. Every one of these used to be discarded as a stall.
    for (const dt of [0.25, 0.35, 0.5]) {
      expect(drive(dt).steps, `${(1 / dt).toFixed(0)} fps did not drop a tier`).toEqual([
        'medium',
        'low',
      ]);
    }
  });

  it('never steps below the cheapest tier, or back up', () => {
    const run = drive(0.5, 4000);
    expect(run.quality).toBe('low');
    expect(run.steps).toEqual(['medium', 'low']);
  });

  it('does not drop a tier for one long frame in an otherwise smooth run', () => {
    const steps: string[] = [];
    const state: AdaptState = {
      frameMs: 16.7,
      sinceAdapt: 0,
      quality: 'high',
      overBudgetWindows: 0,
      setQuality(quality: string) {
        steps.push(quality);
        this.quality = quality;
      },
    };
    const adapt = (Stage.prototype as unknown as Record<string, (dt: number) => void>).adapt;
    for (let i = 0; i < 1800; i++) {
      // Half a second of stall every five seconds — an alt-tab or a GC pause.
      adapt.call(state, i % 300 === 0 ? 0.5 : 1 / 60);
    }
    expect(steps, 'an occasional stall cost a graphics tier').toEqual([]);
  });
});
