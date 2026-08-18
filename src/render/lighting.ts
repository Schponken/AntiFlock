/**
 * The arena light rig, and the show that runs on it.
 *
 * A real cage is lit from a truss overhead: a bank of hard key lights, cooler
 * fill from the sides, and moving spotlights that sweep the floor during the
 * introductions. The opening sequence drives all of it — the house goes dark,
 * the spots pick out each robot in turn, then everything slams back up for the
 * countdown.
 */

import * as THREE from 'three';
import { clamp01, damp, smoothstep } from '../core/math';
import { ARENA_HALF, CEILING_HEIGHT, WALL_HEIGHT } from '../sim/arena';

export interface LightRig {
  group: THREE.Group;
  ambient: THREE.HemisphereLight;
  key: THREE.DirectionalLight;
  /** Overhead work lights on the truss. */
  overheads: THREE.PointLight[];
  /** Two moving spotlights used during the introductions. */
  spots: THREE.SpotLight[];
  /** Warm accent uplights around the cage. */
  accents: THREE.PointLight[];
  /** Strobes that fire on `activate` and on a knockout. */
  strobe: THREE.PointLight;
  /** Soft light over the garage turntable, off during a fight. */
  inspection: THREE.SpotLight;
  inspectionFill: THREE.PointLight;
}

/** Levels the rig is driven to. Everything is a target the rig eases toward. */
export interface LightState {
  /** Overall house level, 0 = blackout, 1 = full. */
  house: number;
  /** Spotlight intensity. */
  spot: number;
  /** Where the spots are pointing, in world space. */
  spotTargets: [THREE.Vector3, THREE.Vector3];
  /** Strobe flash, decays on its own. */
  flash: number;
  /** Warm accent level. */
  accent: number;
  /** Turntable light level, 0..1. Only up in the garage. */
  inspection: number;
}

export function createLightState(): LightState {
  return {
    house: 1,
    spot: 0,
    spotTargets: [new THREE.Vector3(-4.4, 0.3, 0), new THREE.Vector3(4.4, 0.3, 0)],
    flash: 0,
    accent: 0.6,
    inspection: 0,
  };
}

export function buildLightRig(scene: THREE.Scene): LightRig {
  const group = new THREE.Group();
  group.name = 'lights';

  // A dim cool bounce so nothing is ever fully black.
  const ambient = new THREE.HemisphereLight(0x8fa6c4, 0x1a1c20, 0.55);
  group.add(ambient);

  // The key light casts the shadows.
  const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
  key.position.set(6, 14, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 46;
  const extent = ARENA_HALF + 2;
  key.shadow.camera.left = -extent;
  key.shadow.camera.right = extent;
  key.shadow.camera.top = extent;
  key.shadow.camera.bottom = -extent;
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  group.add(key);
  group.add(key.target);

  // Overhead work lights on the truss, in a grid.
  const overheads: THREE.PointLight[] = [];
  for (const x of [-ARENA_HALF * 0.55, ARENA_HALF * 0.55]) {
    for (const z of [-ARENA_HALF * 0.55, ARENA_HALF * 0.55]) {
      const lamp = new THREE.PointLight(0xffe9cc, 26, 26, 2);
      lamp.position.set(x, CEILING_HEIGHT - 0.2, z);
      group.add(lamp);
      overheads.push(lamp);
    }
  }

  // Moving spotlights for the introductions.
  const spots: THREE.SpotLight[] = [];
  for (const x of [-ARENA_HALF * 0.8, ARENA_HALF * 0.8]) {
    const spot = new THREE.SpotLight(0xffffff, 0, 34, Math.PI / 11, 0.5, 1.25);
    spot.position.set(x, CEILING_HEIGHT + 0.1, 0);
    spot.castShadow = false;
    group.add(spot);
    group.add(spot.target);
    spots.push(spot);
  }

  // Warm uplights washing the cage walls.
  const accents: THREE.PointLight[] = [];
  for (const [x, z, colour] of [
    [-ARENA_HALF + 0.6, 0, 0xff4020],
    [ARENA_HALF - 0.6, 0, 0x2050ff],
    [0, -ARENA_HALF + 0.6, 0xff8a20],
    [0, ARENA_HALF - 0.6, 0xff8a20],
  ] as const) {
    const lamp = new THREE.PointLight(colour, 9, 14, 2);
    lamp.position.set(x, WALL_HEIGHT * 0.6, z);
    group.add(lamp);
    accents.push(lamp);
  }

  // A single hard strobe over the middle.
  const strobe = new THREE.PointLight(0xffffff, 0, 40, 1.6);
  strobe.position.set(0, CEILING_HEIGHT - 0.6, 0);
  group.add(strobe);

  // The garage turntable gets its own light. Designing a robot in the arena's
  // moody fight lighting makes it impossible to see what you have built.
  const inspection = new THREE.SpotLight(0xf3f7ff, 0, 9, Math.PI / 5, 0.65, 1.1);
  inspection.position.set(0.6, 3.2, 1.4);
  inspection.castShadow = true;
  inspection.shadow.mapSize.set(1024, 1024);
  group.add(inspection);
  group.add(inspection.target);
  inspection.target.position.set(0, 0.15, 0);

  const inspectionFill = new THREE.PointLight(0x9fc2ff, 0, 7, 1.6);
  inspectionFill.position.set(-1.8, 1.1, -1.6);
  group.add(inspectionFill);

  scene.add(group);

  return { group, ambient, key, overheads, spots, accents, strobe, inspection, inspectionFill };
}

/** Smoothed levels the rig actually renders at. */
interface RigLevels {
  house: number;
  spot: number;
  accent: number;
  flash: number;
  sweep: number;
  inspection: number;
}

const levels: RigLevels = {
  house: 1,
  spot: 0,
  accent: 0.6,
  flash: 0,
  sweep: 0,
  inspection: 0,
};

/**
 * Ease the rig toward the requested state and apply it.
 *
 * `sweeping` makes the spots track slow figures across the floor, which is what
 * they do while the announcer is working through the introductions.
 */
export function applyLighting(
  rig: LightRig,
  state: LightState,
  dt: number,
  time: number,
  sweeping: boolean,
): void {
  levels.house = damp(levels.house, clamp01(state.house), 0.16, dt);
  levels.spot = damp(levels.spot, clamp01(state.spot), 0.12, dt);
  levels.accent = damp(levels.accent, clamp01(state.accent), 0.2, dt);
  levels.sweep = damp(levels.sweep, sweeping ? 1 : 0, 0.25, dt);
  levels.inspection = damp(levels.inspection, clamp01(state.inspection), 0.18, dt);

  // The flash decays fast on its own; the caller just kicks it.
  levels.flash = Math.max(0, state.flash);
  state.flash = Math.max(0, state.flash - dt * 5.5);

  const house = levels.house;

  rig.ambient.intensity = 0.1 + house * 0.42;
  rig.key.intensity = 0.1 + house * 1.5;
  for (const lamp of rig.overheads) lamp.intensity = house * 26;
  for (const lamp of rig.accents) {
    // The accents stay up when the house is down — that is what gives the
    // blackout its colour instead of leaving a black screen.
    lamp.intensity = (0.35 + 0.65 * levels.accent) * 8 * (1.35 - house * 0.35);
  }

  for (let i = 0; i < rig.spots.length; i++) {
    const spot = rig.spots[i]!;
    spot.intensity = levels.spot * 210;
    const target = state.spotTargets[i] ?? state.spotTargets[0]!;
    if (levels.sweep > 0.01) {
      // Lazy figure-of-eight around the assigned target while sweeping.
      const phase = time * 1.1 + i * Math.PI;
      const radius = 2.6 * levels.sweep;
      spot.target.position.set(
        target.x + Math.sin(phase) * radius,
        0.2,
        target.z + Math.sin(phase * 2) * radius * 0.6,
      );
    } else {
      spot.target.position.copy(target);
    }
    spot.target.updateMatrixWorld();
  }

  rig.strobe.intensity = levels.flash * 120;
  rig.inspection.intensity = levels.inspection * 90;
  rig.inspection.target.updateMatrixWorld();
  rig.inspectionFill.intensity = levels.inspection * 12;
}

/** Kick the strobe. */
export function flash(state: LightState, strength = 1): void {
  state.flash = Math.max(state.flash, strength);
}

/**
 * Scene fog and background, tuned so the arena reads as a lit box inside a
 * dark hall rather than a model floating in a void.
 */
export function configureAtmosphere(scene: THREE.Scene): void {
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.016);
}

/** Dim the atmosphere with the house lights. */
export function syncAtmosphere(scene: THREE.Scene, house: number): void {
  const level = 0.02 + smoothstep(0, 1, house) * 0.045;
  if (scene.background instanceof THREE.Color) {
    scene.background.setRGB(level * 0.7, level * 0.8, level * 1.2);
  }
  if (scene.fog instanceof THREE.FogExp2) {
    scene.fog.color.setRGB(level * 0.7, level * 0.8, level * 1.2);
  }
}
