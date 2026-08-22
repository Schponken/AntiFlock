/**
 * Renderer setup: tone mapping, shadows, a procedurally-generated environment
 * map so all that bare metal has something to reflect, and a bloom pass so the
 * arena lights and spark showers actually glow.
 *
 * Quality is adaptive. If the frame budget slips the renderer sheds resolution
 * and then post-processing before it lets the simulation stutter, because a
 * physics game that runs slowly is a different — and much worse — game.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { clamp, damp } from '../core/mathx.ts';
import {
  detectSoftwareRenderer,
  getRenderProfile,
  setRenderProfile,
  type QualityLevel,
} from './profile.ts';

export type { QualityLevel };

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  quality?: QualityLevel;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();

  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private renderPass: RenderPass | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private quality: QualityLevel;
  /** Current and target extra bloom strength, eased in `render`. */
  private bloomBoost = 0;
  private bloomBoostTarget = 0;
  private software = false;
  private envTexture: THREE.Texture | null = null;

  /** Rolling average frame time in milliseconds, for adaptive quality. */
  private frameMs = 16.7;
  private sinceAdapt = 0;

  constructor(options: RendererOptions) {
    this.quality = options.quality ?? 'high';
    setRenderProfile(this.quality);

    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: this.quality !== 'low',
      powerPreference: 'high-performance',
      stencil: false,
    });

    // A CPU rasteriser cannot afford any of the expensive passes, and waiting for
    // the adaptive pass to work that out costs the player their first fight.
    this.software = detectSoftwareRenderer(this.renderer.getContext());
    if (this.software) {
      this.quality = 'low';
    }
    setRenderProfile(this.quality, this.software);

    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = getRenderProfile().shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0x04050a);
    this.scene.fog = new THREE.FogExp2(0x05070c, 0.012);

    this.buildEnvironment();
  }

  private pixelRatio(): number {
    const device = globalThis.devicePixelRatio ?? 1;
    return Math.min(device, getRenderProfile().pixelRatioCap);
  }

  /** True when WebGL is being emulated on the CPU. */
  get isSoftware(): boolean {
    return this.software;
  }

  /**
   * A tiny emissive scene, pre-filtered into an environment map. This is what
   * makes titanium read as titanium: overhead light bars above, team colours to
   * either side, dark floor below.
   */
  private buildEnvironment(): void {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();

    const envScene = new THREE.Scene();
    envScene.background = new THREE.Color(0x0a0c12);

    const addPanel = (
      color: number,
      intensity: number,
      size: [number, number],
      position: [number, number, number],
      rotation: [number, number, number],
    ) => {
      const material = new THREE.MeshBasicMaterial({ color });
      material.color.multiplyScalar(intensity);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
      mesh.position.set(...position);
      mesh.rotation.set(...rotation);
      envScene.add(mesh);
    };

    // Overhead banks.
    for (const x of [-4, 4]) {
      for (const z of [-4, 4]) {
        addPanel(0xfff3e2, 9, [3.4, 2.2], [x, 9, z], [Math.PI / 2, 0, 0]);
      }
    }
    // Team-coloured side spill.
    addPanel(0xff2b2b, 1.6, [16, 5], [0, 2.5, -9], [0, 0, 0]);
    addPanel(0x2b6bff, 1.6, [16, 5], [0, 2.5, 9], [0, Math.PI, 0]);
    addPanel(0x1a1d24, 1, [16, 5], [-9, 2.5, 0], [0, Math.PI / 2, 0]);
    addPanel(0x1a1d24, 1, [16, 5], [9, 2.5, 0], [0, -Math.PI / 2, 0]);
    // Dark floor.
    addPanel(0x14161b, 1, [20, 20], [0, 0, 0], [-Math.PI / 2, 0, 0]);

    const target = pmrem.fromScene(envScene, 0.04);
    this.envTexture = target.texture;
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.85;

    envScene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        (object.material as THREE.Material).dispose();
      }
    });
    pmrem.dispose();
  }

  attachCamera(camera: THREE.PerspectiveCamera): void {
    this.camera = camera;
    this.buildComposer();
  }

  private buildComposer(): void {
    if (!this.camera) return;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;

    if (!getRenderProfile().bloom) return;

    const size = this.renderer.getSize(new THREE.Vector2());
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(this.pixelRatio());
    this.composer.setSize(size.x, size.y);

    this.renderPass = new RenderPass(this.scene, this.camera);
    this.composer.addPass(this.renderPass);

    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      this.quality === 'high' ? 0.52 : 0.36,
      0.62,
      0.86,
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    setRenderProfile(quality, this.software);
    this.renderer.setPixelRatio(this.pixelRatio());
    const shadows = getRenderProfile().shadows;
    const shadowsChanged = this.renderer.shadowMap.enabled !== shadows;
    this.renderer.shadowMap.enabled = shadows;
    /*
     * Toggling `shadowMap.enabled` is not enough on its own.
     *
     * `shadowMapEnabled` is baked into the program cache key but is not one of the
     * conditions Three checks in `needsProgramChange`, so materials compiled while
     * shadows were on keep their `USE_SHADOWMAP` define — while the shadow pass
     * stops running and stops refreshing the maps. The result of dropping to the
     * low profile mid-session was every surface wearing the last shadow it saw,
     * frozen in place. Flagging the materials forces the recompile that clears it.
     */
    if (shadowsChanged) {
      this.scene.traverse((object) => {
        const material = (object as THREE.Mesh).material;
        if (!material) return;
        if (Array.isArray(material)) material.forEach((m) => (m.needsUpdate = true));
        else material.needsUpdate = true;
      });
    }
    this.buildComposer();
    this.resize();
  }

  getQuality(): QualityLevel {
    return this.quality;
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || 1280;
    const height = canvas.clientHeight || 720;
    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.setSize(width, height, false);
    this.composer?.setPixelRatio(this.pixelRatio());
    this.composer?.setSize(width, height);
    if (this.camera) {
      this.camera.aspect = width / Math.max(1, height);
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Crank the bloom, for the lights slamming on.
   *
   * The target is eased towards in `render`, so the show's "boost, then settle"
   * pair of cues actually settles instead of hard-cutting on the frame the second
   * cue happens to land on. Pass `immediate` to snap, for a cut that is meant to
   * be a cut.
   */
  setBloomBoost(amount: number, immediate = false): void {
    this.bloomBoostTarget = amount;
    if (immediate) this.bloomBoost = amount;
    this.applyBloomBoost();
  }

  private applyBloomBoost(): void {
    if (!this.bloomPass) return;
    this.bloomPass.strength = clamp(
      (this.quality === 'high' ? 0.52 : 0.36) + this.bloomBoost,
      0.1,
      2.4,
    );
  }

  render(dt: number): void {
    if (!this.camera) return;
    if (this.bloomBoost !== this.bloomBoostTarget) {
      this.bloomBoost = damp(this.bloomBoost, this.bloomBoostTarget, 3.4, dt);
      if (Math.abs(this.bloomBoost - this.bloomBoostTarget) < 0.002) {
        this.bloomBoost = this.bloomBoostTarget;
      }
      this.applyBloomBoost();
    }
    if (this.composer) this.composer.render(dt);
    else this.renderer.render(this.scene, this.camera);

    this.adapt(dt);
  }

  /**
   * Drop quality if we are consistently missing frames. Only ever steps down —
   * hunting up and down mid-fight is more distracting than a slightly soft image.
   */
  private adapt(dt: number): void {
    this.frameMs = this.frameMs * 0.94 + dt * 1000 * 0.06;
    this.sinceAdapt += dt;
    if (this.sinceAdapt < 4) return;
    this.sinceAdapt = 0;

    if (this.frameMs > 34 && this.quality === 'high') this.setQuality('medium');
    else if (this.frameMs > 42 && this.quality === 'medium') this.setQuality('low');
  }

  dispose(): void {
    this.composer?.dispose();
    this.envTexture?.dispose();
    this.renderer.dispose();
  }
}
