/**
 * Procedural textures.
 *
 * Every surface in the arena is generated at runtime on a canvas: diamond
 * plate, scuffed steel, hazard chevrons, the polycarbonate wall panels, the
 * grating, the crowd. Nothing is downloaded, so the game has no external asset
 * dependencies at all and still gets the look of a real cage — a scratched
 * steel floor, painted safety markings, and armour that scuffs where it has
 * been hit.
 *
 * Textures are cached by key so building forty robots does not build forty
 * copies of the same diamond plate.
 */

import * as THREE from 'three';
import { Rng } from '../core/rng';

const cache = new Map<string, THREE.Texture>();

function makeCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable — cannot build textures');
  return { canvas, ctx };
}

function finish(
  canvas: HTMLCanvasElement,
  repeat: number,
  options: { srgb?: boolean; anisotropy?: number } = {},
): THREE.Texture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  texture.anisotropy = options.anisotropy ?? 8;
  if (options.srgb !== false) texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Shared textures are cached forever. That is safe because the set of keys is
 * small and fixed: the arena surfaces plus one entry per metal or tyre tint.
 *
 * Robot hull textures are deliberately *not* cached — they are keyed by the
 * entire livery including the name, so editing a robot in the garage would mint
 * a new one on every keystroke. Those are owned by the robot's view instead and
 * disposed with it.
 */
function cached(key: string, build: () => THREE.Texture): THREE.Texture {
  const hit = cache.get(key);
  if (hit) return hit;
  const texture = build();
  cache.set(key, texture);
  return texture;
}

/** Convert 0xRRGGBB to a CSS colour string. */
export function cssColor(hex: number, alpha = 1): string {
  const r = (hex >> 16) & 0xff;
  const g = (hex >> 8) & 0xff;
  const b = hex & 0xff;
  return alpha >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** Sprinkle fine grain over the whole canvas — the base of every metal look. */
function addNoise(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  amount: number,
  scale = 1,
): void {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng.next() - 0.5) * amount * 255 * scale;
    data[i] = Math.max(0, Math.min(255, data[i]! + n));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1]! + n));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2]! + n));
  }
  ctx.putImageData(image, 0, 0);
}

/** Long directional scratches, the way a steel floor wears. */
function addScratches(
  ctx: CanvasRenderingContext2D,
  size: number,
  rng: Rng,
  count: number,
  opacity = 0.1,
): void {
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < count; i++) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const angle = rng.range(0, Math.PI * 2);
    const len = rng.range(size * 0.04, size * 0.4);
    const light = rng.chance(0.4);
    ctx.strokeStyle = light
      ? `rgba(255,255,255,${opacity * rng.range(0.4, 1)})`
      : `rgba(0,0,0,${opacity * rng.range(0.4, 1)})`;
    ctx.lineWidth = rng.range(0.5, 2.2);
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

/**
 * The arena floor: heavy steel diamond plate, worn in the middle where the
 * fighting happens, with weld seams between panels.
 */
export function floorTexture(): THREE.Texture {
  return cached('floor', () => {
    const size = 1024;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x510012);

    // Base steel.
    const base = ctx.createLinearGradient(0, 0, size, size);
    base.addColorStop(0, '#3a3d42');
    base.addColorStop(0.5, '#44484e');
    base.addColorStop(1, '#35383d');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    addNoise(ctx, size, rng, 0.08);

    // Diamond plate: two crossing rows of raised lozenges per cell.
    const cell = size / 8;
    for (let gy = 0; gy < 8; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const ox = gx * cell;
        const oy = gy * cell;
        for (let k = 0; k < 2; k++) {
          const angle = k === 0 ? Math.PI / 4 : -Math.PI / 4;
          const cx = ox + cell * (k === 0 ? 0.3 : 0.7);
          const cy = oy + cell * (k === 0 ? 0.3 : 0.7);
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(angle);
          const w = cell * 0.34;
          const h = cell * 0.1;
          // Highlight on the upper edge, shadow beneath — this is what sells
          // the raised look with no normal map.
          ctx.fillStyle = 'rgba(255,255,255,0.16)';
          ctx.fillRect(-w / 2, -h / 2 - 1.5, w, h);
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          ctx.fillRect(-w / 2, -h / 2 + 1.5, w, h);
          ctx.fillStyle = 'rgba(150,158,168,0.32)';
          ctx.fillRect(-w / 2, -h / 2, w, h);
          ctx.restore();
        }
      }
    }

    // Weld seams between the floor panels.
    ctx.strokeStyle = 'rgba(20,22,25,0.55)';
    ctx.lineWidth = 3;
    for (const t of [0.5]) {
      ctx.beginPath();
      ctx.moveTo(0, size * t);
      ctx.lineTo(size, size * t);
      ctx.moveTo(size * t, 0);
      ctx.lineTo(size * t, size);
      ctx.stroke();
    }

    addScratches(ctx, size, rng, 900, 0.12);

    // Scorch and rubber marks.
    for (let i = 0; i < 40; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(size * 0.02, size * 0.1);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(12,12,14,${rng.range(0.1, 0.32)})`);
      g.addColorStop(1, 'rgba(12,12,14,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    return finish(canvas, 6);
  });
}

/** Roughness map for the floor, so the worn patches shine differently. */
export function floorRoughness(): THREE.Texture {
  return cached('floor-rough', () => {
    const size = 512;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x510013);
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 160; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const r = rng.range(size * 0.03, size * 0.16);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      // Polished patches read as darker in a roughness map.
      g.addColorStop(0, `rgba(70,70,70,${rng.range(0.2, 0.6)})`);
      g.addColorStop(1, 'rgba(70,70,70,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    addNoise(ctx, size, rng, 0.12);
    return finish(canvas, 6, { srgb: false });
  });
}

/** The yellow-and-black hazard stripe that runs round the base of the walls. */
export function hazardStripeTexture(): THREE.Texture {
  return cached('hazard', () => {
    const size = 256;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x4a2d);

    ctx.fillStyle = '#e8b920';
    ctx.fillRect(0, 0, size, size);

    ctx.fillStyle = '#14151a';
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(-Math.PI / 4);
    const band = size * 0.19;
    for (let i = -6; i < 8; i++) {
      ctx.fillRect(i * band * 2, -size, band, size * 2);
    }
    ctx.restore();

    // Paint wear: this stripe takes a beating.
    for (let i = 0; i < 220; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      ctx.fillStyle = `rgba(70,72,78,${rng.range(0.1, 0.5)})`;
      ctx.fillRect(x, y, rng.range(1, 7), rng.range(1, 5));
    }
    addNoise(ctx, size, rng, 0.07);

    return finish(canvas, 1);
  });
}

/** Scuffed polycarbonate for the cage walls. */
export function lexanTexture(): THREE.Texture {
  return cached('lexan', () => {
    const size = 512;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x1e0bad);
    ctx.fillStyle = '#cfe3ee';
    ctx.fillRect(0, 0, size, size);
    addScratches(ctx, size, rng, 500, 0.16);
    // Impact stars where robots have been thrown into the wall.
    for (let i = 0; i < 14; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      const spokes = rng.int(6, 12);
      ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.25, 0.6)})`;
      ctx.lineWidth = rng.range(0.6, 1.6);
      for (let s = 0; s < spokes; s++) {
        const a = (s / spokes) * Math.PI * 2 + rng.spread(0.3);
        const len = rng.range(4, 26);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
        ctx.stroke();
      }
    }
    return finish(canvas, 3);
  });
}

/** Painted steel for the wall frames and the roof trusses. */
export function paintedSteelTexture(tint = 0x2a2e35): THREE.Texture {
  return cached(`painted-${tint}`, () => {
    const size = 512;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x9a11 + tint);
    ctx.fillStyle = cssColor(tint);
    ctx.fillRect(0, 0, size, size);
    addNoise(ctx, size, rng, 0.06);
    addScratches(ctx, size, rng, 260, 0.14);
    // Rust and chipped paint at the edges.
    for (let i = 0; i < 90; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      ctx.fillStyle = `rgba(120,72,40,${rng.range(0.05, 0.3)})`;
      ctx.beginPath();
      ctx.arc(x, y, rng.range(1, 6), 0, Math.PI * 2);
      ctx.fill();
    }
    return finish(canvas, 4);
  });
}

/** Steel grating for the walkways outside the cage. */
export function gratingTexture(): THREE.Texture {
  return cached('grating', () => {
    const size = 256;
    const { canvas, ctx } = makeCanvas(size);
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = '#4a4f57';
    ctx.lineWidth = 5;
    const step = size / 8;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step, size);
      ctx.stroke();
    }
    ctx.lineWidth = 2;
    for (let i = 0; i <= 8; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * step);
      ctx.lineTo(size, i * step);
      ctx.stroke();
    }
    return finish(canvas, 8);
  });
}

/**
 * The crowd: a dark wall of tiny warm highlights. Rendered onto the stands so
 * the arena does not sit in an empty void.
 */
export function crowdTexture(): THREE.Texture {
  return cached('crowd', () => {
    const size = 512;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0xc0d);
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, size, size);

    // Rows of people, receding and getting darker toward the top.
    const rows = 34;
    for (let row = rows - 1; row >= 0; row--) {
      const y = (row / rows) * size;
      const rowHeight = size / rows;
      const depth = row / rows;
      const brightness = 0.25 + 0.75 * (1 - depth);
      const perRow = 76;
      const rowOffset = rng.range(0, size / perRow);
      for (let i = 0; i < perRow; i++) {
        // Jitter hard: an evenly spaced grid of heads reads as a honeycomb.
        const x = (i / perRow) * size + rowOffset + rng.spread(size / perRow);
        if (rng.chance(0.12)) continue; // empty seats
        const h = rowHeight * rng.range(0.7, 1.15);
        const w = (size / perRow) * rng.range(0.5, 0.85);
        const shade = Math.floor(rng.range(18, 62) * brightness);
        ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
        ctx.beginPath();
        ctx.ellipse(x, y + rowHeight * 0.5, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        // The odd phone screen or lit face.
        if (rng.chance(0.035)) {
          ctx.fillStyle = `rgba(255,${Math.floor(rng.range(180, 240))},${Math.floor(rng.range(120, 190))},${rng.range(0.4, 0.95)})`;
          ctx.beginPath();
          ctx.arc(x + rng.spread(3), y + rowHeight * 0.4, rng.range(0.8, 2.2), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    return finish(canvas, 1);
  });
}

// ---------------------------------------------------------------------------
// Robot surfaces
// ---------------------------------------------------------------------------

export interface LiveryOptions {
  primary: number;
  secondary: number;
  accent: number;
  livery: string;
  /** Armour material tint, blended in so plastic reads as plastic. */
  materialTint: number;
  /** 0 = painted metal, 1 = raw plastic. */
  plastic: number;
  /** Robot name, painted on the side. */
  name: string;
}

/**
 * A robot's hull texture: base colour, livery pattern, scuffs, and the name
 * stencilled on the flank.
 */
export function hullTexture(options: LiveryOptions): THREE.Texture {
  // Not cached: the caller owns this texture and must dispose it. See the note
  // on `cached` above.
  {
    const size = 1024;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x8a17 + options.primary);

    ctx.fillStyle = cssColor(options.primary);
    ctx.fillRect(0, 0, size, size);

    // Blend the raw material through, so UHMW reads as plastic and titanium
    // reads as bare metal rather than paint.
    if (options.plastic > 0.01) {
      ctx.fillStyle = cssColor(options.materialTint, options.plastic * 0.55);
      ctx.fillRect(0, 0, size, size);
    }

    drawLivery(ctx, size, options, rng);

    // Panel lines and fasteners.
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, (size / 4) * i);
      ctx.lineTo(size, (size / 4) * i);
      ctx.stroke();
    }
    for (let gy = 0; gy < 4; gy++) {
      for (let gx = 0; gx < 8; gx++) {
        const x = (gx + 0.5) * (size / 8);
        const y = gy * (size / 4) + 16;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.beginPath();
        ctx.arc(x - 1.2, y - 1.2, 3.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // The robot's name across the flank.
    if (options.name) {
      const label = options.name.toUpperCase().slice(0, 16);
      ctx.save();
      ctx.font = `900 ${Math.round(size * 0.11)}px "Arial Black", Impact, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = size * 0.012;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, size / 2, size * 0.5);
      ctx.fillStyle = cssColor(options.secondary);
      ctx.fillText(label, size / 2, size * 0.5);
      ctx.restore();
    }

    // Battle damage: scuffs and bare metal showing through the paint.
    addScratches(ctx, size, rng, 420, 0.13);
    for (let i = 0; i < 60; i++) {
      const x = rng.range(0, size);
      const y = rng.range(0, size);
      ctx.fillStyle = `rgba(190,196,205,${rng.range(0.05, 0.22)})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rng.range(2, 14), rng.range(1, 5), rng.range(0, Math.PI), 0, Math.PI * 2);
      ctx.fill();
    }
    addNoise(ctx, size, rng, 0.05);

    return finish(canvas, 1);
  }
}

function drawLivery(
  ctx: CanvasRenderingContext2D,
  size: number,
  options: LiveryOptions,
  rng: Rng,
): void {
  const secondary = cssColor(options.secondary);
  const accent = cssColor(options.accent);

  switch (options.livery) {
    case 'stripes': {
      ctx.fillStyle = secondary;
      ctx.fillRect(0, size * 0.36, size, size * 0.06);
      ctx.fillRect(0, size * 0.58, size, size * 0.06);
      ctx.fillStyle = accent;
      ctx.fillRect(0, size * 0.44, size, size * 0.02);
      break;
    }
    case 'hazard': {
      ctx.save();
      ctx.translate(size / 2, size / 2);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = secondary;
      const band = size * 0.09;
      for (let i = -14; i < 16; i++) ctx.fillRect(i * band * 2, -size, band, size * 2);
      ctx.restore();
      break;
    }
    case 'checker': {
      const cells = 10;
      const c = size / cells;
      ctx.fillStyle = secondary;
      for (let y = 0; y < cells; y++) {
        for (let x = 0; x < cells; x++) {
          if ((x + y) % 2 === 0) ctx.fillRect(x * c, y * c, c, c);
        }
      }
      break;
    }
    case 'flames': {
      ctx.fillStyle = secondary;
      for (let i = 0; i < 9; i++) {
        const baseX = (i / 9) * size;
        ctx.beginPath();
        ctx.moveTo(baseX, size);
        for (let s = 0; s <= 6; s++) {
          const t = s / 6;
          const x = baseX + Math.sin(t * Math.PI * 2 + i) * size * 0.05 + t * size * 0.09;
          const y = size - t * size * rng.range(0.45, 0.75);
          ctx.lineTo(x, y);
        }
        ctx.lineTo(baseX + size * 0.11, size);
        ctx.closePath();
        ctx.fill();
      }
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < 9; i++) {
        const baseX = (i / 9) * size + size * 0.02;
        ctx.beginPath();
        ctx.moveTo(baseX, size);
        ctx.lineTo(baseX + size * 0.03, size - size * 0.3);
        ctx.lineTo(baseX + size * 0.06, size);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'splitface': {
      ctx.fillStyle = secondary;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(size, 0);
      ctx.lineTo(0, size);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillRect(0, size * 0.47, size, size * 0.025);
      break;
    }
    case 'rivets': {
      ctx.strokeStyle = cssColor(options.secondary, 0.7);
      ctx.lineWidth = 4;
      for (let i = 0; i <= 6; i++) {
        ctx.strokeRect(size * 0.03, (size / 6) * i - size * 0.02, size * 0.94, size * 0.14);
      }
      break;
    }
    case 'plain':
    default:
      break;
  }
}

/** Bare metal for weapons, wheels hubs and structural parts. */
export function metalTexture(tint: number, roughness = 0.5): THREE.Texture {
  return cached(`metal-${tint}-${roughness}`, () => {
    const size = 512;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x51ee + tint);
    ctx.fillStyle = cssColor(tint);
    ctx.fillRect(0, 0, size, size);
    // Brushed grain.
    for (let i = 0; i < 2600; i++) {
      const y = rng.range(0, size);
      ctx.strokeStyle = `rgba(255,255,255,${rng.range(0.01, 0.07)})`;
      ctx.lineWidth = rng.range(0.4, 1.4);
      ctx.beginPath();
      ctx.moveTo(rng.range(-40, size), y);
      ctx.lineTo(rng.range(0, size + 40), y + rng.spread(1.2));
      ctx.stroke();
    }
    addScratches(ctx, size, rng, 320, 0.18);
    addNoise(ctx, size, rng, 0.05);
    return finish(canvas, 1);
  });
}

/** Tyre rubber with a tread pattern. */
export function tyreTexture(tint: number): THREE.Texture {
  return cached(`tyre-${tint}`, () => {
    const size = 256;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x7712 + tint);
    ctx.fillStyle = cssColor(tint);
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (let i = 0; i < 18; i++) {
      const x = (i / 18) * size;
      ctx.save();
      ctx.translate(x, 0);
      ctx.rotate(0.22);
      ctx.fillRect(0, -size, size * 0.022, size * 3);
      ctx.restore();
    }
    addNoise(ctx, size, rng, 0.1);
    return finish(canvas, 1);
  });
}

/** A soft radial sprite used for sparks, smoke and light glows. */
export function glowSprite(inner = '#ffffff', outer = 'rgba(255,190,90,0)'): THREE.Texture {
  return cached(`glow-${inner}-${outer}`, () => {
    const size = 128;
    const { canvas, ctx } = makeCanvas(size);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, inner);
    g.addColorStop(0.35, 'rgba(255,200,110,0.55)');
    g.addColorStop(1, outer);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    return finish(canvas, 1);
  });
}

/** A soft round puff for smoke. */
export function smokeSprite(): THREE.Texture {
  return cached('smoke', () => {
    const size = 128;
    const { canvas, ctx } = makeCanvas(size);
    const rng = new Rng(0x5309);
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.5, 'rgba(210,210,215,0.25)');
    g.addColorStop(1, 'rgba(180,180,190,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
    addNoise(ctx, size, rng, 0.05);
    return finish(canvas, 1);
  });
}

/** Release every cached texture. Used when tearing the game down. */
export function disposeTextures(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}
