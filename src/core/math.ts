/**
 * Small numeric helpers shared by the simulation and the renderer.
 * Everything here is pure so it can be unit tested without a browser.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** Convert revolutions per minute to radians per second. */
export function rpmToRadPerSec(rpm: number): number {
  return (rpm * 2 * Math.PI) / 60;
}

/** Convert radians per second to revolutions per minute. */
export function radPerSecToRpm(w: number): number {
  return (w * 60) / (2 * Math.PI);
}

/** Metres per second to miles per hour. */
export function mpsToMph(v: number): number {
  return v * 2.2369362920544;
}

/** Kilograms to pounds. */
export function kgToLb(kg: number): number {
  return kg * 2.2046226218;
}

/** Pounds to kilograms. */
export function lbToKg(lb: number): number {
  return lb / 2.2046226218;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Linear map from [inMin,inMax] onto [outMin,outMax], clamped at both ends. */
export function remap(v: number, inMin: number, inMax: number, outMin: number, outMax: number): number {
  if (inMax === inMin) return outMin;
  return lerp(outMin, outMax, clamp01((v - inMin) / (inMax - inMin)));
}

/** Smooth Hermite interpolation between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1));
  return t * t * (3 - 2 * t);
}

/**
 * Frame-rate independent exponential approach.
 * `halfLife` is the time in seconds for the gap to halve.
 */
export function damp(current: number, target: number, halfLife: number, dt: number): number {
  if (halfLife <= 0) return target;
  return target + (current - target) * Math.pow(2, -dt / halfLife);
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

/** Symmetric deadzone, rescaled so output still reaches ±1. */
export function deadzone(v: number, dz = 0.12): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Rotational kinetic energy in joules for a solid body. */
export function rotationalEnergy(momentOfInertia: number, radPerSec: number): number {
  return 0.5 * momentOfInertia * radPerSec * radPerSec;
}

/** Translational kinetic energy in joules. */
export function kineticEnergy(massKg: number, speedMps: number): number {
  return 0.5 * massKg * speedMps * speedMps;
}

/**
 * Moment of inertia of a spinner approximated as a ring of `mass`
 * with most material at the rim, plus a light disc hub.
 * `rimFraction` is how much of the mass sits at the outer radius.
 */
export function spinnerInertia(massKg: number, radiusM: number, rimFraction = 0.75): number {
  const rim = massKg * rimFraction * radiusM * radiusM; // I = m r^2
  const hub = 0.5 * massKg * (1 - rimFraction) * radiusM * radiusM; // I = 1/2 m r^2
  return rim + hub;
}

/** Format seconds as m:ss for the match clock. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}:${rem.toString().padStart(2, '0')}`;
}
