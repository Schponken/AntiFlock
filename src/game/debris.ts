/**
 * Torn-off armour and wheels become real rigid bodies that skid around the floor
 * and get in the way. The pool is capped and old pieces are recycled, so a long
 * fight cannot bury the solver in junk.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world.ts';
import { DEBRIS_GROUPS } from '../physics/groups.ts';
import { makeMetalTexture } from '../render/textures.ts';
import { fxRng } from '../core/rng.ts';

/** Hard cap. Beyond this the oldest piece is removed to make room. */
export const MAX_DEBRIS_PIECES = 22;

/** Pieces that have stopped moving are swept up after this many seconds. */
const LIFETIME = 45;

interface Piece {
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh | null;
  age: number;
}

export class Debris {
  readonly group = new THREE.Group();

  private world: PhysicsWorld;
  private headless: boolean;
  private pieces: Piece[] = [];
  private panelMaterialCache = new Map<number, THREE.MeshStandardMaterial>();
  private wheelMaterial: THREE.MeshStandardMaterial | null = null;

  constructor(world: PhysicsWorld, options: { headless?: boolean } = {}) {
    this.world = world;
    this.headless = options.headless ?? false;
    this.group.name = 'debris';
  }

  get count(): number {
    return this.pieces.length;
  }

  spawnPanel(options: {
    position: THREE.Vector3;
    size: THREE.Vector3;
    velocity: THREE.Vector3;
    color: number;
    mass: number;
  }): void {
    const { position, size, velocity, color, mass } = options;
    const half = new THREE.Vector3(
      Math.max(0.01, size.x / 2),
      Math.max(0.01, size.y / 2),
      Math.max(0.01, size.z / 2),
    );

    const body = this.createBody(position, velocity);
    const desc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z)
      .setMass(Math.max(0.3, mass))
      .setFriction(0.6)
      .setRestitution(0.2)
      .setCollisionGroups(DEBRIS_GROUPS);
    this.world.world.createCollider(desc, body);

    let mesh: THREE.Mesh | null = null;
    if (!this.headless) {
      mesh = new THREE.Mesh(
        new THREE.BoxGeometry(half.x * 2, half.y * 2, half.z * 2),
        this.panelMaterial(color),
      );
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    this.push({ body, mesh, age: 0 });
  }

  spawnWheel(options: {
    position: THREE.Vector3;
    radius: number;
    width: number;
    velocity: THREE.Vector3;
    mass: number;
  }): void {
    const { position, radius, width, velocity, mass } = options;
    const body = this.createBody(position, velocity);
    const desc = RAPIER.ColliderDesc.cylinder(width / 2, radius)
      .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
      .setMass(Math.max(0.3, mass))
      .setFriction(1.1)
      .setRestitution(0.3)
      .setCollisionGroups(DEBRIS_GROUPS);
    this.world.world.createCollider(desc, body);

    let mesh: THREE.Mesh | null = null;
    if (!this.headless) {
      mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(radius, radius, width, 18),
        this.wheelMat(),
      );
      mesh.geometry.rotateZ(Math.PI / 2);
      mesh.castShadow = true;
      this.group.add(mesh);
    }

    this.push({ body, mesh, age: 0 });
  }

  /** Small shards thrown off by a big hit. Visual only — no colliders, no cost. */
  private createBody(position: THREE.Vector3, velocity: THREE.Vector3): RAPIER.RigidBody {
    const body = this.world.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(position.x, position.y, position.z)
        .setLinvel(velocity.x, velocity.y, velocity.z)
        .setAngvel({
          x: fxRng.spread(18),
          y: fxRng.spread(18),
          z: fxRng.spread(18),
        })
        .setLinearDamping(0.12)
        .setAngularDamping(0.25),
    );
    return body;
  }

  private push(piece: Piece): void {
    this.pieces.push(piece);
    while (this.pieces.length > MAX_DEBRIS_PIECES) {
      const oldest = this.pieces.shift();
      if (oldest) this.remove(oldest);
    }
  }

  update(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i]!;
      piece.age += dt;
      const t = piece.body.translation();
      // Sweep up anything that has fallen out of the world or timed out.
      if (piece.age > LIFETIME || t.y < -4) {
        this.pieces.splice(i, 1);
        this.remove(piece);
      }
    }
  }

  syncVisuals(): void {
    if (this.headless) return;
    for (const piece of this.pieces) {
      if (!piece.mesh) continue;
      const t = piece.body.translation();
      const r = piece.body.rotation();
      piece.mesh.position.set(t.x, t.y, t.z);
      piece.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  clear(): void {
    for (const piece of this.pieces) this.remove(piece);
    this.pieces.length = 0;
  }

  dispose(): void {
    this.clear();
    for (const material of this.panelMaterialCache.values()) material.dispose();
    this.panelMaterialCache.clear();
    this.wheelMaterial?.dispose();
  }

  private remove(piece: Piece): void {
    this.world.world.removeRigidBody(piece.body);
    if (piece.mesh) {
      piece.mesh.geometry.dispose();
      piece.mesh.removeFromParent();
    }
  }

  private panelMaterial(color: number): THREE.MeshStandardMaterial {
    let material = this.panelMaterialCache.get(color);
    if (!material) {
      const maps = makeMetalTexture(0x8b9099, 41);
      material = new THREE.MeshStandardMaterial({
        color,
        normalMap: maps.normalMap,
        roughnessMap: maps.roughnessMap,
        metalness: 0.7,
        roughness: 0.55,
      });
      this.panelMaterialCache.set(color, material);
    }
    return material;
  }

  private wheelMat(): THREE.MeshStandardMaterial {
    if (!this.wheelMaterial) {
      this.wheelMaterial = new THREE.MeshStandardMaterial({
        color: 0x24272b,
        metalness: 0.1,
        roughness: 0.88,
      });
    }
    return this.wheelMaterial;
  }
}
