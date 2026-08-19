/**
 * Impact effects: showers of sparks, drifting smoke, and the scorch marks a
 * fight leaves on the floor.
 *
 * Both particle pools are fixed-size GPU buffers with CPU-side integration. The
 * pool never grows and never allocates during a fight, so a spinner grinding
 * against armour for ten seconds costs exactly as much as one hit.
 */

import * as THREE from 'three';
import { fxRng } from '../core/rng.ts';
import { clamp01 } from '../core/mathx.ts';
import { makeSmokeSprite, makeSparkSprite } from './textures.ts';

const SPARK_CAPACITY = 900;
const SMOKE_CAPACITY = 260;
const SCORCH_CAPACITY = 40;

const sparkVertex = /* glsl */ `
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const sparkFragment = /* glsl */ `
  uniform sampler2D map;
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec4 texel = texture2D(map, gl_PointCoord);
    if (texel.a < 0.01) discard;
    gl_FragColor = vec4(vColor, 1.0) * texel * vAlpha;
  }
`;

interface Pool {
  points: THREE.Points;
  positions: Float32Array;
  colors: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  velocities: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  cursor: number;
  capacity: number;
  geometry: THREE.BufferGeometry;
}

function makePool(capacity: number, map: THREE.Texture, blending: THREE.Blending): Pool {
  const positions = new Float32Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const sizes = new Float32Array(capacity);
  const alphas = new Float32Array(capacity);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
  // Particles are placed anywhere in the box; a generous sphere avoids culling pops.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2, 0), 40);

  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: map } },
    vertexShader: sparkVertex,
    fragmentShader: sparkFragment,
    transparent: true,
    depthWrite: false,
    blending,
    vertexColors: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    positions,
    colors,
    sizes,
    alphas,
    velocities: new Float32Array(capacity * 3),
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    cursor: 0,
    capacity,
    geometry,
  };
}

export class Fx {
  readonly group = new THREE.Group();

  private sparks: Pool;
  private smoke: Pool;
  private scorches: THREE.Mesh[] = [];
  private scorchCursor = 0;

  /** Accumulated camera shake, consumed by the camera rig each frame. */
  private shake = 0;

  constructor() {
    this.group.name = 'fx';
    this.sparks = makePool(SPARK_CAPACITY, makeSparkSprite(), THREE.AdditiveBlending);
    this.smoke = makePool(SMOKE_CAPACITY, makeSmokeSprite(), THREE.NormalBlending);
    this.group.add(this.sparks.points);
    this.group.add(this.smoke.points);
    this.buildScorches();
  }

  private buildScorches(): void {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({
      map: makeSmokeSprite(),
      color: 0x000000,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    for (let i = 0; i < SCORCH_CAPACITY; i++) {
      const mesh = new THREE.Mesh(geometry, material.clone());
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.006;
      mesh.visible = false;
      this.group.add(mesh);
      this.scorches.push(mesh);
    }
  }

  get shakeAmount(): number {
    return this.shake;
  }

  private emit(
    pool: Pool,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    color: THREE.Color,
    size: number,
    life: number,
  ): void {
    const i = pool.cursor;
    pool.cursor = (pool.cursor + 1) % pool.capacity;

    pool.positions[i * 3] = position.x;
    pool.positions[i * 3 + 1] = position.y;
    pool.positions[i * 3 + 2] = position.z;
    pool.velocities[i * 3] = velocity.x;
    pool.velocities[i * 3 + 1] = velocity.y;
    pool.velocities[i * 3 + 2] = velocity.z;
    pool.colors[i * 3] = color.r;
    pool.colors[i * 3 + 1] = color.g;
    pool.colors[i * 3 + 2] = color.b;
    pool.sizes[i] = size;
    pool.alphas[i] = 1;
    pool.life[i] = life;
    pool.maxLife[i] = life;
  }

  private tmpVec = new THREE.Vector3();
  private tmpColor = new THREE.Color();

  /**
   * A shower of sparks off the impact point, thrown back along the surface
   * normal with a wide spread — grinding steel throws sparks everywhere.
   */
  sparkBurst(position: THREE.Vector3, normal: THREE.Vector3, intensity: number): void {
    const strength = clamp01(intensity);
    const count = Math.round(12 + strength * 90);
    const speed = 4 + strength * 16;

    for (let i = 0; i < count; i++) {
      const direction = this.tmpVec
        .copy(normal)
        .addScaledVector(
          new THREE.Vector3(fxRng.spread(1), fxRng.spread(1), fxRng.spread(1)),
          0.9,
        )
        .normalize()
        .multiplyScalar(speed * fxRng.range(0.35, 1.3));
      direction.y += fxRng.range(0.5, 3.5);

      // Sparks cool from white-hot through yellow to a deep orange.
      const heat = fxRng.range(0.45, 1);
      this.tmpColor.setRGB(1, 0.45 + heat * 0.5, 0.08 + heat * 0.32);

      this.emit(
        this.sparks,
        position,
        direction,
        this.tmpColor,
        fxRng.range(0.5, 1.6) * (0.6 + strength),
        fxRng.range(0.25, 0.9),
      );
    }

    this.shake = Math.min(1.4, this.shake + strength * 0.55);
  }

  /** Smoke from a damaged machine or a heavy hit. */
  smokePuff(position: THREE.Vector3, intensity: number): void {
    const strength = clamp01(intensity);
    const count = Math.round(2 + strength * 9);
    for (let i = 0; i < count; i++) {
      this.tmpVec.set(fxRng.spread(0.8), fxRng.range(0.4, 1.7), fxRng.spread(0.8));
      const shade = fxRng.range(0.16, 0.4);
      this.tmpColor.setRGB(shade, shade, shade * 1.05);
      this.emit(
        this.smoke,
        position,
        this.tmpVec,
        this.tmpColor,
        fxRng.range(6, 16) * (0.6 + strength),
        fxRng.range(1.1, 2.6),
      );
    }
  }

  /** Leave a permanent-ish mark on the floor where something big happened. */
  scorch(position: THREE.Vector3, radius: number): void {
    const mesh = this.scorches[this.scorchCursor]!;
    this.scorchCursor = (this.scorchCursor + 1) % SCORCH_CAPACITY;
    mesh.position.set(position.x, 0.006, position.z);
    mesh.scale.setScalar(radius);
    mesh.rotation.z = fxRng.range(0, Math.PI * 2);
    mesh.visible = true;
    (mesh.material as THREE.MeshBasicMaterial).opacity = 0.55;
  }

  /** Shake the camera without an impact, e.g. for the lights slamming on. */
  addShake(amount: number): void {
    this.shake = Math.min(1.6, this.shake + amount);
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.4);

    this.integrate(this.sparks, dt, -22, 0.5);
    this.integrate(this.smoke, dt, 1.4, 1.6);

    // Scorch marks fade very slowly, so the floor tells the story of the fight.
    for (const mesh of this.scorches) {
      if (!mesh.visible) continue;
      const material = mesh.material as THREE.MeshBasicMaterial;
      material.opacity -= dt * 0.012;
      if (material.opacity <= 0) mesh.visible = false;
    }
  }

  private integrate(pool: Pool, dt: number, gravity: number, drag: number): void {
    const { positions, velocities, life, maxLife, alphas, capacity } = pool;
    let anyAlive = false;

    for (let i = 0; i < capacity; i++) {
      if (life[i]! <= 0) {
        alphas[i] = 0;
        continue;
      }
      anyAlive = true;
      life[i] = life[i]! - dt;

      const decay = Math.max(0, 1 - drag * dt);
      velocities[i * 3] = velocities[i * 3]! * decay;
      velocities[i * 3 + 1] = velocities[i * 3 + 1]! * decay + gravity * dt;
      velocities[i * 3 + 2] = velocities[i * 3 + 2]! * decay;

      positions[i * 3] = positions[i * 3]! + velocities[i * 3]! * dt;
      positions[i * 3 + 1] = positions[i * 3 + 1]! + velocities[i * 3 + 1]! * dt;
      positions[i * 3 + 2] = positions[i * 3 + 2]! + velocities[i * 3 + 2]! * dt;

      // Sparks bounce off the floor once, which is what sells the scale.
      if (positions[i * 3 + 1]! < 0.01 && velocities[i * 3 + 1]! < 0) {
        positions[i * 3 + 1] = 0.01;
        velocities[i * 3 + 1] = -velocities[i * 3 + 1]! * 0.35;
        velocities[i * 3] = velocities[i * 3]! * 0.6;
        velocities[i * 3 + 2] = velocities[i * 3 + 2]! * 0.6;
      }

      alphas[i] = clamp01(life[i]! / Math.max(0.001, maxLife[i]!));
    }

    if (!anyAlive) return;
    pool.geometry.attributes.position!.needsUpdate = true;
    pool.geometry.attributes.alpha!.needsUpdate = true;
    pool.geometry.attributes.color!.needsUpdate = true;
    pool.geometry.attributes.size!.needsUpdate = true;
  }

  /** Wipe every particle, e.g. between matches. */
  reset(): void {
    for (const pool of [this.sparks, this.smoke]) {
      pool.life.fill(0);
      pool.alphas.fill(0);
      pool.geometry.attributes.alpha!.needsUpdate = true;
    }
    for (const mesh of this.scorches) mesh.visible = false;
    this.shake = 0;
  }

  dispose(): void {
    for (const pool of [this.sparks, this.smoke]) {
      pool.geometry.dispose();
      (pool.points.material as THREE.Material).dispose();
    }
    for (const mesh of this.scorches) (mesh.material as THREE.Material).dispose();
  }
}
