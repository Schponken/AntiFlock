/**
 * Every surface in the game is drawn here at runtime — there is not a single
 * image file in the build. Canvas 2D paints albedo and height maps, a Sobel pass
 * turns height into a normal map, and the results are cached so the arena and a
 * dozen bots share one set of GPU textures.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng.ts';
import type { DecalId } from '../game/parts.ts';

type Ctx = CanvasRenderingContext2D;

const cache = new Map<string, THREE.Texture>();

/*
 * Liveries get their own bounded cache.
 *
 * Every other texture in here is keyed on a value from a fixed catalogue, so the
 * main cache has a small, known ceiling. A livery is keyed on three RGB values the
 * player picks with a colour input — and that input fires on every pixel of a
 * drag, each event rebuilding the preview and minting another 512x512 texture that
 * nothing ever reclaimed. One thoughtful pass over the colour wheel was hundreds
 * of megabytes of GPU memory that only came back when the tab closed. An LRU that
 * disposes what it evicts keeps the recently-tried colours instant, which is the
 * only reason the cache exists, without the leak.
 */
const LIVERY_CACHE_LIMIT = 16;
const liveryCache = new Map<string, THREE.Texture>();

function cacheLivery(key: string, texture: THREE.Texture): void {
  liveryCache.set(key, texture);
  while (liveryCache.size > LIVERY_CACHE_LIMIT) {
    const oldest = liveryCache.keys().next();
    if (oldest.done) break;
    liveryCache.get(oldest.value)?.dispose();
    liveryCache.delete(oldest.value);
  }
}

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  // Texture synthesis reads pixels back constantly (noise blending, the Sobel pass
  // that turns height into normals). Declaring that up front keeps the backing
  // store on the CPU instead of stalling on a GPU readback for every call.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  return { canvas, ctx };
}

const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;

function toTexture(
  canvas: HTMLCanvasElement,
  { repeat = 1, srgb = false }: { repeat?: number; srgb?: boolean } = {},
): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = 8;
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Sobel filter turning a greyscale height canvas into a tangent-space normal map. */
export function heightToNormal(source: HTMLCanvasElement, strength = 2.2): THREE.Texture {
  const size = source.width;
  const src = source.getContext('2d')!.getImageData(0, 0, size, size).data;
  const { canvas, ctx } = makeCanvas(size);
  const out = ctx.createImageData(size, size);

  const at = (x: number, y: number): number => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    return src[(yi * size + xi) * 4]! / 255;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));

      let nx = dx * strength;
      let ny = dy * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;

      const i = (y * size + x) * 4;
      out.data[i] = (nx * 0.5 + 0.5) * 255;
      out.data[i + 1] = (ny * 0.5 + 0.5) * 255;
      out.data[i + 2] = (nz / len) * 0.5 * 255 + 127.5;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return toTexture(canvas);
}

// ---------------------------------------------------------------------------
// Noise helpers
// ---------------------------------------------------------------------------

/** Tiling value noise. Wrapping the lattice keeps every texture seamless. */
function valueNoise(size: number, cells: number, rng: Rng): Float32Array {
  const lattice = new Float32Array(cells * cells);
  for (let i = 0; i < lattice.length; i++) lattice[i] = rng.next();

  const out = new Float32Array(size * size);
  const fade = (t: number) => t * t * (3 - 2 * t);
  const sample = (cx: number, cy: number) =>
    lattice[((cy + cells) % cells) * cells + ((cx + cells) % cells)]!;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fade(fx - x0);
      const ty = fade(fy - y0);
      const a = sample(x0, y0) * (1 - tx) + sample(x0 + 1, y0) * tx;
      const b = sample(x0, y0 + 1) * (1 - tx) + sample(x0 + 1, y0 + 1) * tx;
      out[y * size + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

function fbm(size: number, octaves: number, rng: Rng): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoise(size, 4 * 2 ** o, rng);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + layer[i]! * amp;
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / total;
  return out;
}

function paintNoise(ctx: Ctx, size: number, rng: Rng, alpha: number, octaves = 4): void {
  const noise = fbm(size, octaves, rng);
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < noise.length; i++) {
    const n = (noise[i]! - 0.5) * 255 * alpha;
    const p = i * 4;
    image.data[p] = Math.max(0, Math.min(255, image.data[p]! + n));
    image.data[p + 1] = Math.max(0, Math.min(255, image.data[p + 1]! + n));
    image.data[p + 2] = Math.max(0, Math.min(255, image.data[p + 2]! + n));
  }
  ctx.putImageData(image, 0, 0);
}

/** Fine directional scratches — the single most convincing "this has been used" cue. */
function drawScratches(ctx: Ctx, size: number, rng: Rng, count: number, opacity: number): void {
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const len = rng.range(size * 0.02, size * 0.4);
    const angle = rng.bool(0.75) ? rng.spread(0.25) : rng.range(0, Math.PI);
    const bright = rng.bool(0.5);
    ctx.strokeStyle = bright
      ? `rgba(255,255,255,${opacity * rng.range(0.3, 1)})`
      : `rgba(0,0,0,${opacity * rng.range(0.3, 1)})`;
    ctx.lineWidth = rng.range(0.4, 2.1);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * len, y + Math.sin(angle) * len);
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Arena surfaces
// ---------------------------------------------------------------------------

export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

/**
 * Arena floor: steel plate with a diamond tread, weld seams between sheets, and
 * a lifetime of gouges, scorch marks and rubber streaks.
 */
export function makeArenaFloor(): SurfaceMaps {
  const key = 'arena-floor';
  const cachedMap = cache.get(key);
  if (cachedMap) {
    return {
      map: cachedMap,
      normalMap: cache.get(key + ':n')!,
      roughnessMap: cache.get(key + ':r')!,
    };
  }

  const size = 1024;
  const rng = new Rng(0xa11eeff);
  const { canvas, ctx } = makeCanvas(size);
  const height = makeCanvas(size);
  const rough = makeCanvas(size);

  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, size, size);
  paintNoise(ctx, size, new Rng(7), 0.28, 5);

  height.ctx.fillStyle = '#808080';
  height.ctx.fillRect(0, 0, size, size);

  // Diamond tread: two mirrored rows of raised lozenges per tile.
  const tile = size / 8;
  for (let ty = 0; ty < 8; ty++) {
    for (let tx = 0; tx < 8; tx++) {
      const flip = (tx + ty) % 2 === 0;
      for (let i = 0; i < 2; i++) {
        const cx = tx * tile + tile * (0.3 + i * 0.42);
        const cy = ty * tile + tile * (0.5 + (i === 0 ? -0.18 : 0.18));
        const ang = (flip ? 1 : -1) * 0.62;
        for (const target of [ctx, height.ctx]) {
          target.save();
          target.translate(cx, cy);
          target.rotate(ang);
          const grad = target.createLinearGradient(0, -tile * 0.1, 0, tile * 0.1);
          if (target === ctx) {
            grad.addColorStop(0, '#5a5f66');
            grad.addColorStop(1, '#2e3136');
          } else {
            grad.addColorStop(0, '#f0f0f0');
            grad.addColorStop(1, '#9a9a9a');
          }
          target.fillStyle = grad;
          target.beginPath();
          target.roundRect(-tile * 0.3, -tile * 0.085, tile * 0.6, tile * 0.17, tile * 0.06);
          target.fill();
          target.restore();
        }
      }
    }
  }

  // Weld seams between the 4x4 floor sheets.
  for (const target of [ctx, height.ctx]) {
    target.save();
    target.strokeStyle = target === ctx ? 'rgba(20,20,22,0.8)' : 'rgba(60,60,60,0.9)';
    target.lineWidth = 5;
    for (let i = 1; i < 4; i++) {
      const p = (size / 4) * i;
      target.beginPath();
      target.moveTo(p, 0);
      target.lineTo(p, size);
      target.moveTo(0, p);
      target.lineTo(size, p);
      target.stroke();
    }
    target.restore();
  }

  // Battle scars: gouges, scorches and tyre marks.
  drawScratches(ctx, size, rng, 900, 0.18);
  for (let i = 0; i < 26; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(size * 0.02, size * 0.09);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(12,10,10,${rng.range(0.25, 0.55)})`);
    grad.addColorStop(1, 'rgba(12,10,10,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Roughness: scuffed patches are shinier where they have been polished by battle.
  rough.ctx.fillStyle = '#b4b4b4';
  rough.ctx.fillRect(0, 0, size, size);
  paintNoise(rough.ctx, size, new Rng(31), 0.5, 4);
  drawScratches(rough.ctx, size, new Rng(99), 500, 0.35);

  const map = toTexture(canvas, { repeat: 5, srgb: true });
  const normalMap = heightToNormal(height.canvas, 1.6);
  normalMap.repeat.set(5, 5);
  const roughnessMap = toTexture(rough.canvas, { repeat: 5 });

  cache.set(key, map);
  cache.set(key + ':n', normalMap);
  cache.set(key + ':r', roughnessMap);
  return { map, normalMap, roughnessMap };
}

/** Scuffed polycarbonate: mostly clear, with a haze of impact scratches. */
export function makeLexanScratches(): THREE.Texture {
  const key = 'lexan';
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#111111';
  ctx.fillRect(0, 0, size, size);
  const rng = new Rng(0x5ca7ed);
  drawScratches(ctx, size, rng, 420, 0.55);
  // A few star-shaped impact marks where something big hit the glass.
  for (let i = 0; i < 7; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    for (let s = 0; s < 9; s++) {
      const a = rng.range(0, Math.PI * 2);
      const l = rng.range(6, 34);
      ctx.lineWidth = rng.range(0.5, 1.6);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }
  }
  const texture = toTexture(canvas, { repeat: 3 });
  cache.set(key, texture);
  return texture;
}

/** Painted concrete for the walls behind the safety glass. */
export function makeConcrete(): SurfaceMaps {
  const key = 'concrete';
  const cached = cache.get(key);
  if (cached) {
    return { map: cached, normalMap: cache.get(key + ':n')!, roughnessMap: cache.get(key + ':r')! };
  }

  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const height = makeCanvas(size);
  ctx.fillStyle = '#26282c';
  ctx.fillRect(0, 0, size, size);
  paintNoise(ctx, size, new Rng(4242), 0.35, 5);

  height.ctx.fillStyle = '#7d7d7d';
  height.ctx.fillRect(0, 0, size, size);
  paintNoise(height.ctx, size, new Rng(4242), 0.5, 5);

  const rng = new Rng(11);
  for (let i = 0; i < 240; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const r = rng.range(0.6, 3.4);
    ctx.fillStyle = `rgba(0,0,0,${rng.range(0.1, 0.4)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    height.ctx.fillStyle = `rgba(0,0,0,${rng.range(0.2, 0.6)})`;
    height.ctx.beginPath();
    height.ctx.arc(x, y, r, 0, Math.PI * 2);
    height.ctx.fill();
  }

  const rough = makeCanvas(size);
  rough.ctx.fillStyle = '#d2d2d2';
  rough.ctx.fillRect(0, 0, size, size);
  paintNoise(rough.ctx, size, new Rng(777), 0.4, 4);

  const map = toTexture(canvas, { repeat: 4, srgb: true });
  const normalMap = heightToNormal(height.canvas, 1.1);
  normalMap.repeat.set(4, 4);
  const roughnessMap = toTexture(rough.canvas, { repeat: 4 });
  cache.set(key, map);
  cache.set(key + ':n', normalMap);
  cache.set(key + ':r', roughnessMap);
  return { map, normalMap, roughnessMap };
}

/** Diagonal hazard chevrons for the hazard zones and the pit rim. */
/**
 * A bank of lamp cells behind a diffuser, for the overhead light housings.
 *
 * Used as an emissive map: the banks were flat white slabs, which is the one
 * light source in the room the player looks straight at.
 */
export function makeLampGrid(cells = 4): THREE.Texture {
  const key = `lampgrid-${cells}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, 0, size, size);

  const pitch = size / cells;
  const inset = pitch * 0.12;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const left = x * pitch + inset;
      const top = y * pitch + inset;
      const w = pitch - inset * 2;
      const gradient = ctx.createLinearGradient(left, top, left, top + w);
      gradient.addColorStop(0, '#fffaf0');
      gradient.addColorStop(0.5, '#fff3dc');
      gradient.addColorStop(1, '#e8d8bd');
      ctx.fillStyle = gradient;
      ctx.fillRect(left, top, w, w);

      // The bar of the fitting across the middle of each cell.
      ctx.fillStyle = '#2a2d33';
      ctx.fillRect(left, top + w * 0.47, w, w * 0.06);
    }
  }

  const texture = toTexture(canvas, { srgb: true });
  cache.set(key, texture);
  return texture;
}

export function makeHazardStripes(a = 0xffc300, b = 0x14161a): THREE.Texture {
  const key = `hazard-${a}-${b}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  ctx.fillStyle = hex(b);
  ctx.fillRect(0, 0, size, size);
  ctx.save();
  ctx.fillStyle = hex(a);
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 4);
  for (let i = -size; i < size; i += size / 4) {
    ctx.fillRect(i, -size, size / 8, size * 2);
  }
  ctx.restore();
  drawScratches(ctx, size, new Rng(5150), 220, 0.3);
  const texture = toTexture(canvas, { repeat: 1, srgb: true });
  cache.set(key, texture);
  return texture;
}

/** Sponsor-style banner ring around the top of the box. */
export function makeBannerTexture(): THREE.Texture {
  const key = 'banner';
  const cached = cache.get(key);
  if (cached) return cached;

  const w = 2048;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b0d11';
  ctx.fillRect(0, 0, w, h);

  const words = ['ANTIFLOCK', 'ROBOT COMBAT LEAGUE', 'HEAVYWEIGHT', 'FIGHT NIGHT'];
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${h * 0.42}px "Barlow Condensed", "Arial Narrow", sans-serif`;

  /*
   * Lay the run out first, then stretch it to fit exactly.
   *
   * Drawing until the cursor passed the edge wrote the last entry straight off
   * the canvas, and the texture wraps — so the banner read a word bisected at the
   * seam, over and over, all the way round the box. Measuring first and scaling
   * the whole run means every entry is whole and the repeat is seamless.
   */
  const gap = 120;
  const layout: { word: string; x: number; width: number }[] = [];
  let cursor = 0;
  for (let i = 0; cursor < w; i++) {
    const word = words[i % words.length]!;
    const width = ctx.measureText(word).width;
    layout.push({ word, x: cursor, width });
    cursor += width + gap;
  }
  // Drop the entry that spilled over, then stretch what is left across the full
  // width so the join lands between words rather than through one.
  if (layout.length > 1) {
    layout.pop();
    cursor = layout[layout.length - 1]!.x + layout[layout.length - 1]!.width + gap;
  }

  ctx.save();
  ctx.scale(w / Math.max(1, cursor), 1);
  layout.forEach((entry, i) => {
    ctx.fillStyle = i % 2 === 0 ? '#e8eaf0' : '#ff3b30';
    ctx.fillText(entry.word, entry.x + 40, h / 2);
    // Divider chevron between entries.
    ctx.fillStyle = '#2a2f38';
    ctx.fillRect(entry.x + entry.width + 70, h * 0.2, 6, h * 0.6);
  });
  ctx.restore();
  const texture = toTexture(canvas, { repeat: 1, srgb: true });
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, texture);
  return texture;
}

/** A wall of out-of-focus faces and phone screens behind the glass. */
export function makeCrowdTexture(): THREE.Texture {
  const key = 'crowd';
  const cached = cache.get(key);
  if (cached) return cached;

  const w = 1024;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, '#05060a');
  sky.addColorStop(1, '#12141c');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const rng = new Rng(0xc0ffee);
  for (let row = 0; row < 7; row++) {
    const y = h - 14 - row * 30;
    const scale = 1 - row * 0.07;
    for (let i = 0; i < 90; i++) {
      const x = rng.range(0, w);
      const shade = Math.floor(rng.range(24, 74) * scale);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
      ctx.beginPath();
      ctx.arc(x, y, 9 * scale, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(x - 10 * scale, y + 6 * scale, 20 * scale, 26 * scale);
      // The occasional raised phone screen.
      if (rng.bool(0.09)) {
        ctx.fillStyle = `rgba(190,215,255,${rng.range(0.35, 0.85)})`;
        ctx.fillRect(x - 3, y - 16 * scale, 6, 10);
      }
    }
  }
  const texture = toTexture(canvas, { repeat: 1, srgb: true });
  texture.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, texture);
  return texture;
}

// ---------------------------------------------------------------------------
// Bot liveries
// ---------------------------------------------------------------------------

/** Painted, decal'd, scratched armour panel matching the player's colour scheme. */
export function makeLiveryTexture(
  primary: number,
  secondary: number,
  accent: number,
  decal: DecalId,
  seed = 1,
): THREE.Texture {
  const key = `livery-${primary}-${secondary}-${accent}-${decal}-${seed}`;
  const cached = liveryCache.get(key);
  if (cached) {
    // Re-insert so the most recently used entry is the last to be evicted.
    liveryCache.delete(key);
    liveryCache.set(key, cached);
    return cached;
  }

  const size = 512;
  const { canvas, ctx } = makeCanvas(size);
  const rng = new Rng(0x1000 + seed * 7717);

  ctx.fillStyle = hex(primary);
  ctx.fillRect(0, 0, size, size);

  ctx.save();
  switch (decal) {
    case 'stripes': {
      ctx.fillStyle = hex(secondary);
      ctx.fillRect(size * 0.36, 0, size * 0.1, size);
      ctx.fillRect(size * 0.54, 0, size * 0.1, size);
      ctx.fillStyle = hex(accent);
      ctx.fillRect(size * 0.48, 0, size * 0.04, size);
      break;
    }
    case 'flames': {
      ctx.fillStyle = hex(secondary);
      ctx.fillRect(0, 0, size, size * 0.42);
      ctx.fillStyle = hex(accent);
      for (let i = 0; i < 9; i++) {
        const x = (i / 9) * size;
        ctx.beginPath();
        ctx.moveTo(x, size * 0.42);
        ctx.quadraticCurveTo(x + size * 0.03, size * 0.6, x + size * 0.07, size * 0.44);
        ctx.quadraticCurveTo(x + size * 0.1, size * 0.72, x + size * 0.13, size * 0.42);
        ctx.closePath();
        ctx.fill();
      }
      break;
    }
    case 'checker': {
      const n = 8;
      const c = size / n;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          if ((x + y) % 2 === 0) continue;
          ctx.fillStyle = hex(secondary);
          ctx.fillRect(x * c, y * c, c, c);
        }
      }
      break;
    }
    case 'hazard': {
      ctx.fillStyle = hex(secondary);
      ctx.translate(size / 2, size / 2);
      ctx.rotate(-Math.PI / 4);
      for (let i = -size; i < size; i += size / 5) ctx.fillRect(i, -size, size / 10, size * 2);
      break;
    }
    case 'camo': {
      for (let i = 0; i < 34; i++) {
        ctx.fillStyle = rng.bool() ? hex(secondary) : hex(accent);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        const cx = rng.range(0, size);
        const cy = rng.range(0, size);
        ctx.moveTo(cx, cy);
        const points = rng.int(4, 7);
        for (let p = 0; p < points; p++) {
          const a = (p / points) * Math.PI * 2;
          const r = rng.range(size * 0.04, size * 0.13);
          ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'circuit': {
      ctx.strokeStyle = hex(accent);
      ctx.lineWidth = 2.2;
      for (let i = 0; i < 46; i++) {
        let x = Math.round(rng.range(0, size) / 16) * 16;
        let y = Math.round(rng.range(0, size) / 16) * 16;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (let s = 0; s < rng.int(2, 6); s++) {
          if (rng.bool()) x += rng.pick([-48, -32, 32, 48]);
          else y += rng.pick([-48, -32, 32, 48]);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.fillStyle = hex(accent);
        ctx.beginPath();
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'none':
      break;
  }
  ctx.restore();

  // Panel lines and fasteners sell the "this is fabricated metal" read.
  ctx.strokeStyle = 'rgba(0,0,0,0.42)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (size / 4) * i;
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }
  for (let i = 0; i < 24; i++) {
    const x = rng.range(size * 0.05, size * 0.95);
    const y = rng.range(size * 0.05, size * 0.95);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath();
    ctx.arc(x - 0.8, y - 0.8, 2.1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawScratches(ctx, size, rng, 380, 0.22);
  paintNoise(ctx, size, rng, 0.06, 3);

  const texture = toTexture(canvas, { repeat: 1, srgb: true });
  cacheLivery(key, texture);
  return texture;
}

/** Bare structural metal, used for frames, weapon rotors and arena hardware. */
export function makeMetalTexture(tint = 0x8b9099, seed = 3): SurfaceMaps {
  const key = `metal-${tint}-${seed}`;
  const cached = cache.get(key);
  if (cached) {
    return { map: cached, normalMap: cache.get(key + ':n')!, roughnessMap: cache.get(key + ':r')! };
  }

  const size = 512;
  const rng = new Rng(0x2000 + seed * 331);
  const { canvas, ctx } = makeCanvas(size);
  const height = makeCanvas(size);

  ctx.fillStyle = hex(tint);
  ctx.fillRect(0, 0, size, size);
  paintNoise(ctx, size, rng, 0.16, 4);

  height.ctx.fillStyle = '#808080';
  height.ctx.fillRect(0, 0, size, size);

  // Brushed grain.
  for (let i = 0; i < 2600; i++) {
    const y = rng.range(0, size);
    const x = rng.range(0, size);
    const len = rng.range(20, 190);
    const shade = rng.range(-0.14, 0.14);
    ctx.strokeStyle =
      shade > 0 ? `rgba(255,255,255,${shade})` : `rgba(0,0,0,${-shade})`;
    ctx.lineWidth = rng.range(0.4, 1.4);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + rng.spread(1.4));
    ctx.stroke();
  }

  drawScratches(height.ctx, size, new Rng(seed * 13 + 5), 300, 0.35);
  drawScratches(ctx, size, rng, 260, 0.22);

  const rough = makeCanvas(size);
  rough.ctx.fillStyle = '#7a7a7a';
  rough.ctx.fillRect(0, 0, size, size);
  paintNoise(rough.ctx, size, new Rng(seed * 91), 0.45, 4);
  drawScratches(rough.ctx, size, new Rng(seed * 17), 320, 0.4);

  const map = toTexture(canvas, { srgb: true });
  const normalMap = heightToNormal(height.canvas, 1.0);
  const roughnessMap = toTexture(rough.canvas);
  cache.set(key, map);
  cache.set(key + ':n', normalMap);
  cache.set(key + ':r', roughnessMap);
  return { map, normalMap, roughnessMap };
}

/** Tyre tread: soft rubber with a chevron pattern and a lot of scuffing. */
export function makeTyreTexture(): SurfaceMaps {
  const key = 'tyre';
  const cached = cache.get(key);
  if (cached) {
    return { map: cached, normalMap: cache.get(key + ':n')!, roughnessMap: cache.get(key + ':r')! };
  }
  const size = 256;
  const { canvas, ctx } = makeCanvas(size);
  const height = makeCanvas(size);
  ctx.fillStyle = '#191b1e';
  ctx.fillRect(0, 0, size, size);
  height.ctx.fillStyle = '#606060';
  height.ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 16; i++) {
    const x = (i / 16) * size;
    for (const target of [ctx, height.ctx]) {
      target.fillStyle = target === ctx ? '#26292d' : '#e0e0e0';
      target.save();
      target.translate(x, size / 2);
      target.rotate(0.32);
      target.fillRect(-size * 0.02, -size * 0.6, size * 0.045, size * 1.2);
      target.restore();
    }
  }
  drawScratches(ctx, size, new Rng(63), 260, 0.14);

  const rough = makeCanvas(size);
  rough.ctx.fillStyle = '#e6e6e6';
  rough.ctx.fillRect(0, 0, size, size);
  paintNoise(rough.ctx, size, new Rng(64), 0.3, 3);

  const map = toTexture(canvas, { repeat: 1, srgb: true });
  const normalMap = heightToNormal(height.canvas, 1.5);
  const roughnessMap = toTexture(rough.canvas);
  cache.set(key, map);
  cache.set(key + ':n', normalMap);
  cache.set(key + ':r', roughnessMap);
  return { map, normalMap, roughnessMap };
}

/** Soft round sprite used for sparks, smoke puffs and light glows. */
export function makeSparkSprite(): THREE.Texture {
  const key = 'spark';
  const cached = cache.get(key);
  if (cached) return cached;
  const size = 64;
  const { canvas, ctx } = makeCanvas(size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.28, 'rgba(255,226,160,0.92)');
  grad.addColorStop(0.6, 'rgba(255,140,40,0.35)');
  grad.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const texture = toTexture(canvas, { srgb: true });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, texture);
  return texture;
}

export function makeSmokeSprite(): THREE.Texture {
  const key = 'smoke';
  const cached = cache.get(key);
  if (cached) return cached;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(190,190,195,0.55)');
  grad.addColorStop(0.55, 'rgba(120,120,128,0.22)');
  grad.addColorStop(1, 'rgba(80,80,88,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  paintNoise(ctx, size, new Rng(808), 0.18, 4);
  const texture = toTexture(canvas, { srgb: true });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  cache.set(key, texture);
  return texture;
}

/** Free every cached texture — used when tearing the game down. */
export function disposeTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
  for (const texture of liveryCache.values()) texture.dispose();
  liveryCache.clear();
}
