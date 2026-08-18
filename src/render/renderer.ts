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
import { detectQuality, type QualitySettings } from './quality';
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
  readonly effects: Effects;
  readonly lights: LightRig;
  readonly lightState: LightState = createLightState();
  readonly quality: QualitySettings;

  arenaView: ArenaView | null = null;
  redView: BotView | null = null;
  blueView: BotView | null = null;

  private elapsed = 0;

  // --- Adaptive resolution ----------------------------------------------------
  // Render scale is trimmed when frames run long, so a weak machine gets a
  // playable frame rate instead of a slideshow.
  //
  // Changing it reallocates the drawing buffer, which is far from free, so this
  // moves between a few fixed steps, waits a long time between changes, and
  // gives up after a handful. An eager version of this measurably made things
  // worse: it thrashed the framebuffer and produced multi-second stalls.
  private static readonly SCALE_STEPS = [1, 0.85, 0.7, 0.55, 0.45];
  private static readonly MAX_SCALE_CHANGES = 6;
  private maxPixelRatio = 1;
  private scaleStep = 0;
  private scaleChanges = 0;
  private frameTimeAverage = 1 / 60;
  private scaleCooldown = 2;
  private viewportWidth = 1;
  private viewportHeight = 1;
  /** Turn adaptive scaling off, for deterministic visual comparisons. */
  adaptiveResolution = true;

  constructor(canvas: HTMLCanvasElement) {
    this.quality = detectQuality();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      // Has to be decided at context creation, so it comes from the tier.
      antialias: this.quality.antialias,
      powerPreference: 'high-performance',
      // Needed so the canvas can be read back into a 2D context.
      preserveDrawingBuffer: true,
    });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.renderer.shadowMap.enabled = this.quality.shadows;
    // PCF rather than PCFSoft: the soft variant takes many more taps per
    // fragment, which is a poor trade on weaker hardware.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.effects = new Effects(this.quality.particleScale);
    configureAtmosphere(this.scene);
    this.lights = buildLightRig(this.scene, this.quality);
    this.scene.add(this.effects.group);

    const aspect = Math.max(canvas.clientWidth, 1) / Math.max(canvas.clientHeight, 1);
    this.director = new CameraDirector(aspect);
  }

  /** Build the arena geometry. Safe to call once per session. */
  buildArena(): void {
    if (this.arenaView) return;
    this.arenaView = buildArenaView();
    this.scene.add(this.arenaView.root);
    this.warmUp();
  }

  /**
   * Compile every shader the scene currently needs.
   *
   * Three compiles lazily during the first render that uses a material, and a
   * complex lit shader can take a long time to build. Doing it here means the
   * cost lands while a loading screen is up rather than as a stall on the first
   * frame of a fight.
   */
  warmUp(): void {
    this.renderer.compile(this.scene, this.director.camera);
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
    this.warmUp();
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
    this.viewportWidth = Math.max(width, 1);
    this.viewportHeight = Math.max(height, 1);
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
    this.director.resize(this.viewportWidth / this.viewportHeight);
  }

  /** Current render scale, 0..1, for the debug overlay. */
  get currentRenderScale(): number {
    return GameRenderer.SCALE_STEPS[this.scaleStep]!;
  }

  /**
   * Step the render scale down when frames are consistently long, and back up
   * when there is headroom to spare.
   */
  private adaptResolution(dt: number): void {
    if (!this.adaptiveResolution) return;

    this.frameTimeAverage += (dt - this.frameTimeAverage) * 0.05;
    this.scaleCooldown -= dt;
    if (this.scaleCooldown > 0) return;
    if (this.scaleChanges >= GameRenderer.MAX_SCALE_CHANGES) return;

    const steps = GameRenderer.SCALE_STEPS;
    let next = this.scaleStep;
    // Wide hysteresis: only act on frames well outside the budget, so a single
    // slow frame never triggers a reallocation.
    if (this.frameTimeAverage > 1 / 30 && this.scaleStep < steps.length - 1) next++;
    else if (this.frameTimeAverage < 1 / 100 && this.scaleStep > 0) next--;

    this.scaleCooldown = 2;
    if (next === this.scaleStep) return;

    this.scaleStep = next;
    this.scaleChanges++;
    this.renderer.setPixelRatio(Math.max(0.35, this.maxPixelRatio * steps[next]!));
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);
  }

  /** Sync everything and draw one frame. */
  render(fight: Fight | null, dt: number, sweepingSpots: boolean): void {
    this.elapsed += dt;
    this.adaptResolution(dt);

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
      // Opacity is a plain uniform, so this is free. Never touch `transparent`
      // here — the weapon materials are created transparent for exactly that
      // reason.
      const opacity = 1 - clamp01((spin - 0.25) / 0.75) * 0.45;
      view.weapon.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          (object.material as THREE.MeshStandardMaterial).opacity = opacity;
        }
      });
    }
  }

  /**
   * Set the start light: red while the robots are held, green once the fight
   * is live. This is the starting signal, not an arena safety interlock.
   */
  setStartLight(green: boolean): void {
    const material = this.arenaView?.startLightMaterial;
    if (!material) return;
    material.emissive.setHex(green ? 0x22ff44 : 0xff1500);
    material.color.setHex(green ? 0x003311 : 0x330000);
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
