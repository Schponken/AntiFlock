/**
 * Graphics quality tiers.
 *
 * The expensive parts of this scene are per-pixel: physically based shading
 * with several lights, multisampling, and a shadow pass. On a GPU that is all
 * free; on a software rasteriser — SwiftShader in a headless browser, llvmpipe
 * on a machine with no working driver — it is the difference between sixty
 * frames a second and one.
 *
 * So the renderer is probed once at start-up and the tier is chosen from what
 * it finds, before the real context is created. Antialiasing in particular has
 * to be decided up front, because it is a context creation flag.
 */

export type QualityTier = 'high' | 'low';

export interface QualitySettings {
  tier: QualityTier;
  antialias: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** Cap on the device pixel ratio. */
  maxPixelRatio: number;
  /** Scale applied to particle pool sizes. */
  particleScale: number;
  /** Why this tier was chosen, for the debug overlay. */
  reason: string;
}

const HIGH: QualitySettings = {
  tier: 'high',
  antialias: true,
  shadows: true,
  shadowMapSize: 1024,
  maxPixelRatio: 2,
  particleScale: 1,
  reason: 'hardware renderer',
};

const LOW: QualitySettings = {
  tier: 'low',
  antialias: false,
  shadows: false,
  shadowMapSize: 512,
  maxPixelRatio: 1,
  particleScale: 0.35,
  reason: 'software renderer',
};

/** Substrings that identify a renderer with no GPU behind it. */
const SOFTWARE_RENDERERS = ['swiftshader', 'llvmpipe', 'softpipe', 'software rasterizer', 'microsoft basic render'];

/**
 * Ask the browser what it is actually rendering with.
 *
 * Uses a throwaway context so the answer is available before the real one is
 * created. Returns null when it cannot tell.
 */
export function probeRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (!gl) return null;

    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));

    // Release it straight away rather than waiting for the GC.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch {
    return null;
  }
}

/**
 * Choose a tier. `?quality=low` or `?quality=high` in the URL overrides the
 * detection, which is useful for testing and for anyone whose machine is
 * misdetected.
 */
export function detectQuality(search = typeof location !== 'undefined' ? location.search : ''): QualitySettings {
  const requested = new URLSearchParams(search).get('quality');
  if (requested === 'low') return { ...LOW, reason: 'requested by ?quality=low' };
  if (requested === 'high') return { ...HIGH, reason: 'requested by ?quality=high' };

  const renderer = probeRenderer();
  if (!renderer) return { ...LOW, reason: 'no WebGL renderer reported' };

  const lower = renderer.toLowerCase();
  if (SOFTWARE_RENDERERS.some((needle) => lower.includes(needle))) {
    return { ...LOW, reason: `software renderer (${renderer})` };
  }

  // A very small screen is usually a phone, which also benefits from less work.
  if (typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 500) {
    return { ...HIGH, maxPixelRatio: 1.5, reason: `small display (${renderer})` };
  }

  return { ...HIGH, reason: renderer };
}
