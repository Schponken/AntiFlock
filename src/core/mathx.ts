/** Small numeric helpers shared by the simulation, AI and presentation layers. */

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => clamp(v, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : clamp01((v - a) / (b - a));

export const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = invLerp(edge0, edge1, x);
  return t * t * (3 - 2 * t);
};

/** Frame-rate independent exponential approach. `rate` is "how much closer per second". */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Move `current` toward `target` by at most `maxDelta`. */
export const approach = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
};

/** Wrap an angle into (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};

export const degToRad = (d: number): number => (d * Math.PI) / 180;
export const radToDeg = (r: number): number => (r * 180) / Math.PI;

/** Deadzone with rescaling so the usable range stays [0,1]. */
export const deadzone = (v: number, dz = 0.12): number => {
  const m = Math.abs(v);
  if (m < dz) return 0;
  return Math.sign(v) * ((m - dz) / (1 - dz));
};

export const round = (v: number, decimals = 0): number => {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
};

/** Kilograms to pounds — the sport is scored in pounds, the sim runs in SI. */
export const kgToLb = (kg: number): number => kg * 2.2046226218;
export const lbToKg = (lb: number): number => lb / 2.2046226218;

/** metres/second to miles-per-hour, for the tip-speed readout. */
export const mpsToMph = (mps: number): number => mps * 2.2369362921;
