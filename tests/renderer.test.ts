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
import type * as THREE from 'three';
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

/**
 * A downgrade has to reach the scene that is already built.
 *
 * `Arena` and `LightRig` read the render profile once, in their constructors, and
 * a match builds both before the adaptive path has any frame times to judge. The
 * two most expensive things the low profile turns off — refraction through the
 * arena glass, which makes Three render the whole scene a second time, and the
 * shadow-casting overhead banks, which are a full extra pass each — were
 * therefore never actually shed: a machine that fell behind dropped its pixel
 * ratio and its bloom and kept every cost that mattered.
 */

/**
 * A stand-in for the 2D canvas the procedural textures draw on.
 *
 * The scene objects under test are the *visible* ones, so they cannot be built
 * headless — and every one of them generates a texture on the way up. The
 * drawing calls themselves do not matter here; what matters is that the objects
 * get built at all, so a Proxy that answers every method with a no-op and every
 * property with another Proxy is exactly enough.
 */
function withCanvas(run: () => void | Promise<void>): void | Promise<void> {
  const stub = (): unknown =>
    new Proxy(
      function () {
        /* no-op */
      },
      {
        get: (_t, key) => {
          if (key === 'width' || key === 'height') return 256;
          if (key === 'data') return new Uint8ClampedArray(4);
          if (key === Symbol.toPrimitive || key === 'toString') return () => '';
          return stub();
        },
        set: () => true,
        apply: () => stub(),
      },
    );

  const previous = (globalThis as Record<string, unknown>).document;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => {
      if (tag !== 'canvas') return stub();
      return {
        width: 256,
        height: 256,
        getContext: () => stub(),
      };
    },
  };
  try {
    return run();
  } finally {
    if (previous === undefined) delete (globalThis as Record<string, unknown>).document;
    else (globalThis as Record<string, unknown>).document = previous;
  }
}

describe('profile changes reaching a live scene', () => {
  it('sheds the glass refraction and the shadow casters on a downgrade', async () => {
    const { setRenderProfile, getRenderProfile } = await import('../src/render/profile.ts');
    const { Arena } = await import('../src/game/arena.ts');
    const { LightRig } = await import('../src/render/lightRig.ts');
    const { PhysicsWorld, initRapier } = await import('../src/physics/world.ts');
    await initRapier();

    setRenderProfile('low');
    setRenderProfile('high');
    expect(getRenderProfile().transmission, 'the high profile is not the expensive one').toBe(
      true,
    );

    const world = new PhysicsWorld();
    let arena!: InstanceType<typeof Arena>;
    let rig!: InstanceType<typeof LightRig>;
    withCanvas(() => {
      arena = new Arena(world);
      rig = new LightRig();
    });

    const refracting = (): number => {
      let count = 0;
      arena.group.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        for (const m of Array.isArray(material) ? material : [material]) {
          const physical = m as THREE.MeshPhysicalMaterial | undefined;
          if (physical?.isMeshPhysicalMaterial && physical.transmission > 0) count += 1;
        }
      });
      return count;
    };
    const casters = (): number => {
      let count = 0;
      rig.group.traverse((object) => {
        if ((object as THREE.Light).isLight && object.castShadow) count += 1;
      });
      return count;
    };

    expect(refracting(), 'the arena glass was never built to refract').toBeGreaterThan(0);
    expect(casters(), 'no light was ever casting a shadow').toBeGreaterThan(0);

    setRenderProfile('low');

    expect(
      refracting(),
      'the glass kept refracting after the machine dropped to the low profile',
    ).toBe(0);
    expect(
      casters(),
      'the overhead banks kept casting after the machine dropped to the low profile',
    ).toBe(0);

    // Going back up has to restore both, or the adaptive path is a one-way door.
    setRenderProfile('high');
    expect(refracting(), 'the glass never came back on an upgrade').toBeGreaterThan(0);
    expect(casters(), 'the shadow casters never came back on an upgrade').toBeGreaterThan(0);

    // And a disposed scene must stop listening, or every finished match keeps
    // being handed profile changes for the lifetime of the page.
    arena.dispose();
    rig.dispose();
    setRenderProfile('low');
    setRenderProfile('high');

    world.free();
    setRenderProfile('high');
  });
});
