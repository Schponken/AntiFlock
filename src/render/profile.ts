/**
 * One place that decides how expensive the picture is allowed to be.
 *
 * The arena and the lighting rig are built once and then live for the whole
 * match, so they cannot ask the renderer for its settings on the fly — they read
 * this profile at construction. Keeping the decision here also means "what does
 * low quality actually turn off" is answered in a single readable place rather
 * than scattered across three files.
 */

export type QualityLevel = 'low' | 'medium' | 'high';

export interface RenderProfile {
  quality: QualityLevel;
  /** True when WebGL is being emulated on the CPU (SwiftShader, llvmpipe). */
  software: boolean;
  shadows: boolean;
  shadowMapSize: number;
  /** How many of the overhead banks cast shadows. Each one is a full extra pass. */
  shadowCasters: number;
  /**
   * Real refraction through the arena glass. This is the single most expensive
   * thing on screen — it makes Three render the scene again into a transmission
   * buffer — so it is the first thing to go.
   */
  transmission: boolean;
  bloom: boolean;
  pixelRatioCap: number;
}

const PROFILES: Record<QualityLevel, Omit<RenderProfile, 'quality' | 'software'>> = {
  low: {
    shadows: false,
    shadowMapSize: 512,
    shadowCasters: 0,
    transmission: false,
    bloom: false,
    pixelRatioCap: 1,
  },
  medium: {
    shadows: true,
    shadowMapSize: 1024,
    shadowCasters: 2,
    transmission: false,
    bloom: true,
    pixelRatioCap: 1.35,
  },
  high: {
    shadows: true,
    shadowMapSize: 1024,
    shadowCasters: 4,
    transmission: true,
    bloom: true,
    pixelRatioCap: 2,
  },
};

let current: RenderProfile = { quality: 'high', software: false, ...PROFILES.high };

export function setRenderProfile(quality: QualityLevel, software = current.software): void {
  current = { quality, software, ...PROFILES[quality] };
}

export function getRenderProfile(): RenderProfile {
  return current;
}

/**
 * Ask the driver what it is. A CPU rasteriser can be two orders of magnitude
 * slower than a GPU, so it gets the cheap settings from the very first frame
 * rather than waiting for the adaptive pass to notice.
 */
export function detectSoftwareRenderer(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    if (!info) return false;
    const renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    return /swiftshader|llvmpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}
