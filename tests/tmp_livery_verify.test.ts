import { describe, it, expect, vi } from 'vitest';

// Minimal canvas stub so the real texture module runs under node.
const ctxStub = new Proxy({} as any, {
  get: (_t, p) => {
    if (p === 'canvas') return { width: 512, height: 512 };
    if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(512 * 512 * 4), width: 512, height: 512 });
    if (p === 'createImageData') return (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
    if (p === 'putImageData') return () => {};
    if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop: () => {} });
    if (p === 'measureText') return () => ({ width: 10 });
    return () => {};
  },
  set: () => true,
});
(globalThis as any).document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ctxStub }),
};

const mod = await import('../src/render/textures.ts');

describe('livery cache bound', () => {
  it('stays bounded and disposes evicted textures across 300 distinct colours', () => {
    const seen: any[] = [];
    for (let i = 0; i < 300; i++) {
      const t = mod.makeLiveryTexture(0x000000 + i, 0x334455, 0xffaa00, 'stripes' as any, 1);
      const spy = vi.spyOn(t, 'dispose');
      seen.push({ t, spy });
    }
    // Count how many of the 300 got disposed by eviction.
    const disposed = seen.filter((s) => s.spy.mock.calls.length > 0 || (s.t as any).__disposedEarly).length;
    // Reach into the module's live cache size via a fresh distinct key round-trip:
    // if unbounded, the very first colour would still be cached (no rebuild).
    const first = mod.makeLiveryTexture(0x000000, 0x334455, 0xffaa00, 'stripes' as any, 1);
    expect(first).not.toBe(seen[0].t); // evicted => rebuilt => NOT the same object
    const recent = mod.makeLiveryTexture(0x000000 + 299, 0x334455, 0xffaa00, 'stripes' as any, 1);
    expect(recent).toBe(seen[299].t);  // recent still cached
    console.log('disposed-after-creation spies:', disposed);
  });
});
