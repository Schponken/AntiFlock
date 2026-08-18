/**
 * Impact effects: sparks, smoke and shrapnel.
 *
 * All three run as fixed-size pooled particle systems on a single draw call
 * each, so a bar spinner grinding along armour at 240 Hz costs nothing beyond
 * the buffer updates. Sparks are ballistic and bounce off the floor, which is
 * what makes a hit read as metal rather than as a puff of orange.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import { fxRng } from '../core/rng';
import type { Vec3 } from '../sim/physics';
import { glowSprite, smokeSprite } from './textures';

const MAX_SPARKS = 1400;
const MAX_SMOKE = 220;
const MAX_DEBRIS = 90;

interface Particle {
  life: number;
  maxLife: number;
  px: number;
  py: number;
  pz: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  /** Heat 0..1, drives the spark colour from white through orange to red. */
  heat: number;
}

function blank(): Particle {
  return { life: 0, maxLife: 1, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, size: 1, heat: 1 };
}

export class Effects {
  readonly group = new THREE.Group();

  private sparks: Particle[] = [];
  private smoke: Particle[] = [];
  private debris: Particle[] = [];

  private sparkPoints: THREE.Points;
  private sparkPositions: Float32Array;
  private sparkColors: Float32Array;
  private sparkSizes: Float32Array;

  private smokePoints: THREE.Points;
  private smokePositions: Float32Array;
  private smokeOpacity: Float32Array;
  private smokeSizes: Float32Array;

  private debrisMesh: THREE.InstancedMesh;
  private debrisRotations: number[] = [];
  private dummy = new THREE.Object3D();

  constructor() {
    this.group.name = 'fx';

    // --- Sparks --------------------------------------------------------------
    for (let i = 0; i < MAX_SPARKS; i++) this.sparks.push(blank());
    this.sparkPositions = new Float32Array(MAX_SPARKS * 3);
    this.sparkColors = new Float32Array(MAX_SPARKS * 3);
    this.sparkSizes = new Float32Array(MAX_SPARKS);

    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    sparkGeometry.setAttribute('color', new THREE.BufferAttribute(this.sparkColors, 3));
    sparkGeometry.setAttribute('size', new THREE.BufferAttribute(this.sparkSizes, 1));

    const sparkMaterial = new THREE.PointsMaterial({
      size: 0.055,
      map: glowSprite('#ffffff', 'rgba(255,140,40,0)'),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      toneMapped: false,
    });

    this.sparkPoints = new THREE.Points(sparkGeometry, sparkMaterial);
    this.sparkPoints.frustumCulled = false;
    this.group.add(this.sparkPoints);

    // --- Smoke ---------------------------------------------------------------
    for (let i = 0; i < MAX_SMOKE; i++) this.smoke.push(blank());
    this.smokePositions = new Float32Array(MAX_SMOKE * 3);
    this.smokeOpacity = new Float32Array(MAX_SMOKE);
    this.smokeSizes = new Float32Array(MAX_SMOKE);

    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute('position', new THREE.BufferAttribute(this.smokePositions, 3));
    smokeGeometry.setAttribute('size', new THREE.BufferAttribute(this.smokeSizes, 1));

    const smokeMaterial = new THREE.PointsMaterial({
      size: 0.5,
      map: smokeSprite(),
      color: 0x8c8f96,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.smokePoints = new THREE.Points(smokeGeometry, smokeMaterial);
    this.smokePoints.frustumCulled = false;
    this.group.add(this.smokePoints);

    // --- Debris --------------------------------------------------------------
    for (let i = 0; i < MAX_DEBRIS; i++) {
      this.debris.push(blank());
      this.debrisRotations.push(0);
    }
    this.debrisMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.05, 0.012, 0.03),
      new THREE.MeshStandardMaterial({ color: 0x9aa1a9, metalness: 1, roughness: 0.4 }),
      MAX_DEBRIS,
    );
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.count = MAX_DEBRIS;
    this.group.add(this.debrisMesh);

    // Park everything off-screen until it is used.
    this.hideAll();
  }

  private hideAll(): void {
    for (let i = 0; i < MAX_SPARKS; i++) this.sparkSizes[i] = 0;
    for (let i = 0; i < MAX_SMOKE; i++) this.smokeSizes[i] = 0;
    this.dummy.position.set(0, -1000, 0);
    this.dummy.scale.setScalar(0.0001);
    this.dummy.updateMatrix();
    for (let i = 0; i < MAX_DEBRIS; i++) this.debrisMesh.setMatrixAt(i, this.dummy.matrix);
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  private take(pool: Particle[]): Particle | null {
    for (const p of pool) if (p.life <= 0) return p;
    return null;
  }

  /**
   * A shower of sparks at a point.
   *
   * `intensity` scales both the count and the speed, and `normal` biases the
   * spray so sparks come off the surface rather than out of it.
   */
  sparkBurst(point: Vec3, intensity: number, normal?: Vec3): void {
    const strength = clamp01(intensity);
    if (strength <= 0.01) return;
    const count = Math.round(6 + strength * 90);

    for (let i = 0; i < count; i++) {
      const p = this.take(this.sparks);
      if (!p) break;

      // Random direction, pushed away from the surface if we know which way
      // that is.
      let dx = fxRng.spread(1);
      let dy = fxRng.spread(1);
      let dz = fxRng.spread(1);
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      if (normal) {
        dx += normal.x * 0.9;
        dy += normal.y * 0.9;
        dz += normal.z * 0.9;
      }
      dy += 0.35; // sparks arc upward

      const speed = (2.5 + strength * 13) * fxRng.range(0.35, 1);
      p.px = point.x;
      p.py = point.y;
      p.pz = point.z;
      p.vx = dx * speed;
      p.vy = dy * speed;
      p.vz = dz * speed;
      p.maxLife = fxRng.range(0.25, 0.85) * (0.6 + strength * 0.7);
      p.life = p.maxLife;
      p.size = fxRng.range(0.6, 1.5);
      p.heat = 1;
    }

    // A big hit also throws shrapnel and leaves smoke.
    if (strength > 0.45) {
      this.debrisBurst(point, strength);
      this.smokePuff(point, strength * 0.7);
    }
  }

  /** A puff of smoke, for tyre scrub and burning electronics. */
  smokePuff(point: Vec3, intensity: number): void {
    const strength = clamp01(intensity);
    const count = Math.round(1 + strength * 6);
    for (let i = 0; i < count; i++) {
      const p = this.take(this.smoke);
      if (!p) break;
      p.px = point.x + fxRng.spread(0.08);
      p.py = point.y + fxRng.spread(0.05);
      p.pz = point.z + fxRng.spread(0.08);
      p.vx = fxRng.spread(0.35);
      p.vy = fxRng.range(0.25, 0.9);
      p.vz = fxRng.spread(0.35);
      p.maxLife = fxRng.range(0.8, 2.2);
      p.life = p.maxLife;
      p.size = fxRng.range(0.35, 0.9) * (0.6 + strength);
      p.heat = 0;
    }
  }

  /** Chunks torn off a robot. */
  debrisBurst(point: Vec3, intensity: number): void {
    const count = Math.round(1 + clamp01(intensity) * 7);
    for (let i = 0; i < count; i++) {
      const p = this.take(this.debris);
      if (!p) break;
      p.px = point.x;
      p.py = point.y;
      p.pz = point.z;
      const speed = fxRng.range(1.5, 5) * (0.5 + intensity);
      p.vx = fxRng.spread(1) * speed;
      p.vy = fxRng.range(0.5, 1.6) * speed;
      p.vz = fxRng.spread(1) * speed;
      p.maxLife = fxRng.range(1.4, 3.2);
      p.life = p.maxLife;
      p.size = fxRng.range(0.7, 1.8);
      p.heat = 0;
    }
  }

  /** Advance every particle and push the buffers to the GPU. */
  update(dt: number): void {
    const step = Math.min(dt, 0.05);

    // --- Sparks --------------------------------------------------------------
    for (let i = 0; i < MAX_SPARKS; i++) {
      const p = this.sparks[i]!;
      const o = i * 3;
      if (p.life <= 0) {
        this.sparkSizes[i] = 0;
        continue;
      }

      p.life -= step;
      p.vy -= 24 * step; // sparks are light, so they fall fast in screen terms
      p.vx *= 0.985;
      p.vz *= 0.985;
      p.px += p.vx * step;
      p.py += p.vy * step;
      p.pz += p.vz * step;

      // Bounce off the floor, losing most of the energy.
      if (p.py < 0.01 && p.vy < 0) {
        p.py = 0.01;
        p.vy = -p.vy * 0.32;
        p.vx *= 0.6;
        p.vz *= 0.6;
        p.heat *= 0.6;
      }

      const t = clamp01(p.life / p.maxLife);
      p.heat = Math.max(0, p.heat - step * 1.4);

      this.sparkPositions[o] = p.px;
      this.sparkPositions[o + 1] = p.py;
      this.sparkPositions[o + 2] = p.pz;

      // White hot, cooling through orange to a dull red.
      const heat = clamp01(p.heat);
      this.sparkColors[o] = 1;
      this.sparkColors[o + 1] = 0.35 + heat * 0.6;
      this.sparkColors[o + 2] = 0.08 + heat * heat * 0.72;

      this.sparkSizes[i] = p.size * t;
    }

    // --- Smoke ---------------------------------------------------------------
    for (let i = 0; i < MAX_SMOKE; i++) {
      const p = this.smoke[i]!;
      const o = i * 3;
      if (p.life <= 0) {
        this.smokeSizes[i] = 0;
        this.smokeOpacity[i] = 0;
        continue;
      }
      p.life -= step;
      p.vy += 0.4 * step; // smoke rises
      p.vx *= 0.97;
      p.vz *= 0.97;
      p.px += p.vx * step;
      p.py += p.vy * step;
      p.pz += p.vz * step;

      const t = clamp01(p.life / p.maxLife);
      this.smokePositions[o] = p.px;
      this.smokePositions[o + 1] = p.py;
      this.smokePositions[o + 2] = p.pz;
      // Smoke expands as it fades.
      this.smokeSizes[i] = p.size * (1.6 - t * 0.6);
      this.smokeOpacity[i] = t;
    }

    // --- Debris --------------------------------------------------------------
    for (let i = 0; i < MAX_DEBRIS; i++) {
      const p = this.debris[i]!;
      if (p.life <= 0) {
        this.dummy.position.set(0, -1000, 0);
        this.dummy.scale.setScalar(0.0001);
        this.dummy.updateMatrix();
        this.debrisMesh.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      p.life -= step;
      p.vy -= 9.81 * step;
      p.px += p.vx * step;
      p.py += p.vy * step;
      p.pz += p.vz * step;
      if (p.py < 0.01 && p.vy < 0) {
        p.py = 0.01;
        p.vy = -p.vy * 0.25;
        p.vx *= 0.55;
        p.vz *= 0.55;
      }
      this.debrisRotations[i] = (this.debrisRotations[i] ?? 0) + step * 9;

      this.dummy.position.set(p.px, p.py, p.pz);
      this.dummy.rotation.set(this.debrisRotations[i]!, this.debrisRotations[i]! * 0.7, 0);
      this.dummy.scale.setScalar(p.size * clamp01(p.life / p.maxLife + 0.3));
      this.dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(i, this.dummy.matrix);
    }

    (this.sparkPoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkPoints.geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    (this.sparkPoints.geometry.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
    (this.smokePoints.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.smokePoints.geometry.getAttribute('size') as THREE.BufferAttribute).needsUpdate = true;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  /** How many particles are alive, for the debug overlay. */
  get liveCount(): number {
    let n = 0;
    for (const p of this.sparks) if (p.life > 0) n++;
    for (const p of this.smoke) if (p.life > 0) n++;
    for (const p of this.debris) if (p.life > 0) n++;
    return n;
  }

  /** Kill everything, between matches. */
  clear(): void {
    for (const p of this.sparks) p.life = 0;
    for (const p of this.smoke) p.life = 0;
    for (const p of this.debris) p.life = 0;
    this.hideAll();
  }

  dispose(): void {
    this.sparkPoints.geometry.dispose();
    (this.sparkPoints.material as THREE.Material).dispose();
    this.smokePoints.geometry.dispose();
    (this.smokePoints.material as THREE.Material).dispose();
    this.debrisMesh.geometry.dispose();
    (this.debrisMesh.material as THREE.Material).dispose();
  }
}
