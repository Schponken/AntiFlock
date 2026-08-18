/**
 * The renderer: scene, WebGL context, post-exposure and the per-frame sync
 * between the simulation and the meshes.
 *
 * Nothing here decides anything about the fight. It reads simulation state and
 * draws it.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import type { Fight } from '../sim/fight';
import type { Bot } from '../sim/bot';
import { buildArenaView, syncArenaView, type ArenaView } from './arenaMesh';
import { buildBotView, disposeBotView, syncBotView, type BotView } from './botMesh';
import { CameraDirector } from './camera';
import { Effects } from './fx';
import {
  applyLighting,
  buildLightRig,
  configureAtmosphere,
  createLightState,
  syncAtmosphere,
  type LightRig,
  type LightState,
} from './lighting';

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly director: CameraDirector;
  readonly effects = new Effects();
  readonly lights: LightRig;
  readonly lightState: LightState = createLightState();

  arenaView: ArenaView | null = null;
  redView: BotView | null = null;
  blueView: BotView | null = null;

  private elapsed = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      // Needed so the intro screenshot and the share button can read pixels.
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    configureAtmosphere(this.scene);
    this.lights = buildLightRig(this.scene);
    this.scene.add(this.effects.group);

    const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    this.director = new CameraDirector(aspect);
  }

  /** Build the arena geometry. Safe to call once per session. */
  buildArena(): void {
    if (this.arenaView) return;
    this.arenaView = buildArenaView();
    this.scene.add(this.arenaView.root);
  }

  /** Build the two robots' meshes for a fight. */
  buildBots(fight: Fight): void {
    this.clearBots();
    this.redView = buildBotView(fight.red, fight.red.design);
    this.blueView = buildBotView(fight.blue, fight.blue.design);
    for (const view of [this.redView, this.blueView]) {
      this.scene.add(view.root);
      if (view.weapon) this.scene.add(view.weapon);
    }
  }

  clearBots(): void {
    for (const view of [this.redView, this.blueView]) {
      if (!view) continue;
      this.scene.remove(view.root);
      if (view.weapon) this.scene.remove(view.weapon);
      disposeBotView(view);
    }
    this.redView = null;
    this.blueView = null;
    this.effects.clear();
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.director.resize(Math.max(width, 1) / Math.max(height, 1));
  }

  /** Sync everything and draw one frame. */
  render(fight: Fight | null, dt: number, sweepingSpots: boolean): void {
    this.elapsed += dt;

    if (fight) {
      if (this.arenaView) syncArenaView(this.arenaView, fight.arena);
      if (this.redView) syncBotView(this.redView, fight.red);
      if (this.blueView) syncBotView(this.blueView, fight.blue);
      this.updateHazardGlow(fight);
    }

    this.effects.update(dt);
    applyLighting(this.lights, this.lightState, dt, this.elapsed, sweepingSpots);
    syncAtmosphere(this.scene, this.lightState.house);

    if (fight) {
      this.director.update(
        dt,
        this.elapsed,
        fight.red.position,
        fight.blue.position,
        fight.red.forwardVector,
      );
    } else {
      this.director.update(
        dt,
        this.elapsed,
        { x: 0, y: 0.2, z: 0 },
        { x: 0, y: 0.2, z: 0 },
        { x: 1, y: 0, z: 0 },
      );
    }

    this.renderer.render(this.scene, this.director.camera);
  }

  /** Spinning weapons throw sparks off the floor and glow when they are up. */
  private updateHazardGlow(fight: Fight): void {
    for (const [bot, view] of [
      [fight.red, this.redView],
      [fight.blue, this.blueView],
    ] as const) {
      if (!view?.weapon) continue;
      const spin = bot.weaponSpinFraction;
      // Motion blur is not available, so a spinning rotor reads as one by going
      // slightly translucent as it approaches full speed.
      view.weapon.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          const material = object.material as THREE.MeshStandardMaterial;
          if (!material.transparent && spin > 0.25) {
            material.transparent = true;
          }
          if (material.transparent) {
            material.opacity = 1 - clamp01((spin - 0.25) / 0.75) * 0.45;
          }
        }
      });
    }
  }

  /** Set the safety light colour: red before the fight, green during it. */
  setSafetyLight(green: boolean): void {
    const material = this.arenaView?.safetyLightMaterial;
    if (!material) return;
    material.emissive.setHex(green ? 0x22ff44 : 0xff1500);
    material.color.setHex(green ? 0x003311 : 0x330000);
  }

  screenshot(): string {
    return this.renderer.domElement.toDataURL('image/png');
  }

  dispose(): void {
    this.clearBots();
    this.effects.dispose();
    this.renderer.dispose();
  }
}

/** Sparks thrown by a robot's wheels when they are scrubbing. */
export function emitTyreSmoke(effects: Effects, bot: Bot): void {
  for (const wheel of bot.wheels) {
    if (!wheel.grounded || wheel.slip < 0.35) continue;
    effects.smokePuff(wheel.contact, wheel.slip * 0.35);
  }
}
