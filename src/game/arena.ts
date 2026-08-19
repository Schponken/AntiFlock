/**
 * The box.
 *
 * A 48-foot steel floor inside polycarbonate walls, with the hazards that make
 * the sport what it is: killsaws that come up through slots in the floor, corner
 * pulverisers, and the screws down each side. Hazards are kinematic bodies, so
 * they shove dynamic machines around with real contact velocities rather than
 * teleporting through them.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/world.ts';
import { ARENA_GROUPS, HAZARD_GROUPS } from '../physics/groups.ts';
import {
  makeArenaFloor,
  makeBannerTexture,
  makeConcrete,
  makeCrowdTexture,
  makeHazardStripes,
  makeLexanScratches,
  makeMetalTexture,
} from '../render/textures.ts';
import { clamp01, smoothstep } from '../core/mathx.ts';
import { getRenderProfile } from '../render/profile.ts';

/** Inner clear span of the box, metres. The real thing is 48 feet square. */
export const ARENA_SIZE = 14.63;
export const ARENA_HALF = ARENA_SIZE / 2;
export const WALL_HEIGHT = 1.3;
const WALL_THICKNESS = 0.3;

/** Where each team is released from. */
export const START_SQUARES: readonly { x: number; z: number; facing: number }[] = [
  { x: 0, z: -ARENA_HALF + 2.1, facing: 0 },
  { x: 0, z: ARENA_HALF - 2.1, facing: Math.PI },
];

export type HazardKind = 'killsaw' | 'pulverizer' | 'screw';

export interface HazardHit {
  kind: HazardKind;
  /** Joules this hazard delivers on a clean contact. */
  energy: number;
}

interface Hazard {
  kind: HazardKind;
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D | null;
  energy: number;
  /** Seconds remaining of the current activation. */
  active: number;
  /** Cooldown before it can be triggered again. */
  cooldown: number;
  /** Local data for the specific hazard's motion. */
  home: THREE.Vector3;
  axis: THREE.Vector3;
  phase: number;
}

export class Arena {
  readonly group = new THREE.Group();
  /** Colliders that damage anything they touch. */
  readonly hazardColliders = new Map<number, HazardHit>();
  /** Static arena colliders, so impacts with the wall can still be scored. */
  readonly wallColliders = new Set<number>();

  private hazards: Hazard[] = [];
  private world: PhysicsWorld;
  private headless: boolean;
  private time = 0;
  private crowdMaterials: THREE.MeshBasicMaterial[] = [];

  constructor(world: PhysicsWorld, options: { headless?: boolean } = {}) {
    this.world = world;
    this.headless = options.headless ?? false;
    this.group.name = 'arena';

    this.buildFloor();
    this.buildWalls();
    this.buildKillsaws();
    this.buildPulverizers();
    this.buildScrews();
    if (!this.headless) {
      this.buildDressing();
    }
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildFloor(): void {
    const rapier = this.world.world;
    const floorBody = rapier.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.25, 0),
    );
    const floor = RAPIER.ColliderDesc.cuboid(ARENA_HALF + 1, 0.25, ARENA_HALF + 1)
      .setFriction(0.92)
      .setRestitution(0.06)
      .setCollisionGroups(ARENA_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(2500);
    const collider = rapier.createCollider(floor, floorBody);
    this.wallColliders.add(collider.handle);

    if (this.headless) return;

    const maps = makeArenaFloor();
    const material = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      metalness: 0.86,
      roughness: 0.52,
      envMapIntensity: 0.9,
    });
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE, 1, 1),
      material,
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // Painted start squares, one per team.
    for (let team = 0; team < 2; team++) {
      const square = START_SQUARES[team]!;
      const color = team === 0 ? 0xff2b2b : 0x2b6bff;
      const outline = new THREE.Mesh(
        new THREE.RingGeometry(0.62, 0.76, 4, 1),
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.55,
          roughness: 0.7,
          transparent: true,
          opacity: 0.9,
        }),
      );
      outline.rotation.set(-Math.PI / 2, 0, Math.PI / 4);
      outline.position.set(square.x, 0.004, square.z);
      this.group.add(outline);
    }

    // Hazard chevrons around the killsaw slots.
    const stripe = makeHazardStripes();
    const slotMat = new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.75 });
    for (const x of [-0.95, 0.95]) {
      for (const z of [-1.25, 1.25]) {
        const slot = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.9), slotMat);
        slot.rotation.x = -Math.PI / 2;
        slot.position.set(x, 0.005, z);
        this.group.add(slot);
      }
    }
  }

  private buildWalls(): void {
    const rapier = this.world.world;
    const wallBody = rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed());

    const specs: { pos: [number, number, number]; half: [number, number, number] }[] = [
      {
        pos: [0, WALL_HEIGHT / 2, ARENA_HALF + WALL_THICKNESS / 2],
        half: [ARENA_HALF + WALL_THICKNESS, WALL_HEIGHT / 2, WALL_THICKNESS / 2],
      },
      {
        pos: [0, WALL_HEIGHT / 2, -ARENA_HALF - WALL_THICKNESS / 2],
        half: [ARENA_HALF + WALL_THICKNESS, WALL_HEIGHT / 2, WALL_THICKNESS / 2],
      },
      {
        pos: [ARENA_HALF + WALL_THICKNESS / 2, WALL_HEIGHT / 2, 0],
        half: [WALL_THICKNESS / 2, WALL_HEIGHT / 2, ARENA_HALF + WALL_THICKNESS],
      },
      {
        pos: [-ARENA_HALF - WALL_THICKNESS / 2, WALL_HEIGHT / 2, 0],
        half: [WALL_THICKNESS / 2, WALL_HEIGHT / 2, ARENA_HALF + WALL_THICKNESS],
      },
    ];

    for (const spec of specs) {
      const desc = RAPIER.ColliderDesc.cuboid(spec.half[0], spec.half[1], spec.half[2])
        .setTranslation(spec.pos[0], spec.pos[1], spec.pos[2])
        .setFriction(0.28)
        .setRestitution(0.34)
        .setCollisionGroups(ARENA_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(3000);
      const collider = rapier.createCollider(desc, wallBody);
      this.wallColliders.add(collider.handle);
    }

    if (this.headless) return;

    /*
     * Polycarbonate: scuffed, and just visible enough to read as glass.
     *
     * Real refraction (`transmission`) makes Three render the whole scene a second
     * time into a transmission buffer. It looks superb and it is by far the most
     * expensive thing in the box, so below the top quality tier the walls fall back
     * to plain scratched transparency — which, on four flat panels seen edge-on,
     * reads almost identically.
     */
    const scratches = makeLexanScratches();
    const profile = getRenderProfile();
    const lexan = new THREE.MeshPhysicalMaterial({
      color: 0xdfe8f2,
      metalness: 0,
      roughness: 0.09,
      roughnessMap: scratches,
      transmission: profile.transmission ? 0.92 : 0,
      thickness: profile.transmission ? 0.06 : 0,
      ior: 1.585,
      transparent: true,
      opacity: profile.transmission ? 0.32 : 0.18,
      side: THREE.DoubleSide,
      envMapIntensity: 1.6,
    });

    const kickMaps = makeMetalTexture(0x4a4f56, 9);
    const kickPlate = new THREE.MeshStandardMaterial({
      map: kickMaps.map,
      normalMap: kickMaps.normalMap,
      roughnessMap: kickMaps.roughnessMap,
      metalness: 0.9,
      roughness: 0.55,
    });

    const stripe = makeHazardStripes(0xf5c400, 0x14161a);
    const railMat = new THREE.MeshStandardMaterial({ map: stripe, metalness: 0.4, roughness: 0.6 });

    for (let side = 0; side < 4; side++) {
      const angle = (side * Math.PI) / 2;
      const panel = new THREE.Group();
      panel.rotation.y = angle;
      panel.position.set(
        Math.sin(angle) * ARENA_HALF,
        0,
        Math.cos(angle) * ARENA_HALF,
      );

      const kick = new THREE.Mesh(new THREE.BoxGeometry(ARENA_SIZE, 0.34, 0.06), kickPlate);
      kick.position.set(0, 0.17, 0);
      kick.castShadow = true;
      kick.receiveShadow = true;
      panel.add(kick);

      const glass = new THREE.Mesh(
        new THREE.BoxGeometry(ARENA_SIZE, WALL_HEIGHT - 0.34, 0.03),
        lexan,
      );
      glass.position.set(0, 0.34 + (WALL_HEIGHT - 0.34) / 2, 0);
      panel.add(glass);

      const rail = new THREE.Mesh(new THREE.BoxGeometry(ARENA_SIZE, 0.09, 0.1), railMat);
      rail.position.set(0, WALL_HEIGHT + 0.04, 0);
      rail.castShadow = true;
      panel.add(rail);

      this.group.add(panel);
    }

    // Corner posts.
    const postMat = new THREE.MeshStandardMaterial({ color: 0x1d2126, metalness: 0.8, roughness: 0.5 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(
          new THREE.BoxGeometry(0.24, WALL_HEIGHT + 0.16, 0.24),
          postMat,
        );
        post.position.set(sx * ARENA_HALF, (WALL_HEIGHT + 0.16) / 2, sz * ARENA_HALF);
        post.castShadow = true;
        this.group.add(post);
      }
    }
  }

  private buildKillsaws(): void {
    const rapier = this.world.world;
    const bladeRadius = 0.26;
    const positions: [number, number][] = [
      [-0.95, -1.25],
      [0.95, -1.25],
      [-0.95, 1.25],
      [0.95, 1.25],
    ];

    const metal = this.headless ? null : makeMetalTexture(0xb9c0c8, 21);
    const bladeMat = this.headless
      ? null
      : new THREE.MeshStandardMaterial({
          map: metal!.map,
          normalMap: metal!.normalMap,
          metalness: 1,
          roughness: 0.22,
          side: THREE.DoubleSide,
        });

    for (const [x, z] of positions) {
      const home = new THREE.Vector3(x, -0.32, z);
      const body = rapier.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(home.x, home.y, home.z),
      );
      const desc = RAPIER.ColliderDesc.cylinder(0.012, bladeRadius)
        .setRotation({ x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) })
        .setFriction(0.5)
        .setRestitution(0.2)
        .setCollisionGroups(HAZARD_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = rapier.createCollider(desc, body);
      this.hazardColliders.set(collider.handle, { kind: 'killsaw', energy: 5200 });

      let mesh: THREE.Object3D | null = null;
      if (!this.headless) {
        mesh = new THREE.Group();
        const blade = new THREE.Mesh(
          new THREE.CylinderGeometry(bladeRadius, bladeRadius, 0.02, 32),
          bladeMat!,
        );
        blade.rotation.z = Math.PI / 2;
        blade.castShadow = true;
        mesh.add(blade);
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          const tooth = new THREE.Mesh(
            new THREE.BoxGeometry(0.026, 0.05, 0.03),
            bladeMat!,
          );
          tooth.position.set(0, Math.cos(a) * bladeRadius, Math.sin(a) * bladeRadius);
          tooth.rotation.x = -a;
          mesh.add(tooth);
        }
        mesh.position.copy(home);
        this.group.add(mesh);
      }

      this.hazards.push({
        kind: 'killsaw',
        body,
        mesh,
        energy: 5200,
        active: 0,
        cooldown: 0,
        home,
        axis: new THREE.Vector3(1, 0, 0),
        phase: 0,
      });
    }
  }

  private buildPulverizers(): void {
    const rapier = this.world.world;
    const armLength = 0.85;

    for (const sz of [-1, 1]) {
      const pivot = new THREE.Vector3(0, 1.55, sz * (ARENA_HALF - 0.45));
      const body = rapier.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pivot.x, pivot.y, pivot.z),
      );
      const arm = RAPIER.ColliderDesc.cuboid(0.16, armLength / 2, 0.1)
        .setTranslation(0, -armLength / 2, 0)
        .setFriction(0.5)
        .setRestitution(0.1)
        .setCollisionGroups(HAZARD_GROUPS)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const collider = rapier.createCollider(arm, body);
      this.hazardColliders.set(collider.handle, { kind: 'pulverizer', energy: 9000 });

      let mesh: THREE.Object3D | null = null;
      if (!this.headless) {
        mesh = new THREE.Group();
        const maps = makeMetalTexture(0x5c6169, 22);
        const material = new THREE.MeshStandardMaterial({
          map: maps.map,
          normalMap: maps.normalMap,
          roughnessMap: maps.roughnessMap,
          metalness: 0.92,
          roughness: 0.42,
        });
        const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.1, armLength, 0.1), material);
        shaft.position.y = -armLength / 2;
        shaft.castShadow = true;
        mesh.add(shaft);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.24, 0.2), material);
        head.position.y = -armLength;
        head.castShadow = true;
        mesh.add(head);
        mesh.position.copy(pivot);
        this.group.add(mesh);

        // Mounting bracket on the wall above.
        const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.5), material);
        bracket.position.set(pivot.x, pivot.y + 0.16, pivot.z + sz * 0.24);
        this.group.add(bracket);
      }

      this.hazards.push({
        kind: 'pulverizer',
        body,
        mesh,
        energy: 9000,
        active: 0,
        cooldown: 0,
        home: pivot,
        axis: new THREE.Vector3(1, 0, 0),
        phase: sz > 0 ? Math.PI : 0,
      });
    }
  }

  private buildScrews(): void {
    const rapier = this.world.world;
    const length = 4.2;
    const radius = 0.19;

    for (const sx of [-1, 1]) {
      const home = new THREE.Vector3(sx * (ARENA_HALF - 0.3), 0.14, 0);
      const body = rapier.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(home.x, home.y, home.z),
      );

      // Helical paddles: a plain cylinder would spin without moving anything.
      const blades = 8;
      for (let i = 0; i < blades; i++) {
        const t = i / blades;
        const angle = t * Math.PI * 3;
        const desc = RAPIER.ColliderDesc.cuboid(0.03, radius, 0.16)
          .setTranslation(0, 0, -length / 2 + t * length)
          .setRotation({
            x: 0,
            y: 0,
            z: Math.sin(angle / 2),
            w: Math.cos(angle / 2),
          })
          .setFriction(0.7)
          .setCollisionGroups(HAZARD_GROUPS)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
        const collider = rapier.createCollider(desc, body);
        this.hazardColliders.set(collider.handle, { kind: 'screw', energy: 1400 });
      }

      let mesh: THREE.Object3D | null = null;
      if (!this.headless) {
        mesh = new THREE.Group();
        const maps = makeMetalTexture(0x767c85, 23);
        const material = new THREE.MeshStandardMaterial({
          map: maps.map,
          normalMap: maps.normalMap,
          metalness: 0.9,
          roughness: 0.48,
        });
        const core = new THREE.Mesh(
          new THREE.CylinderGeometry(radius * 0.35, radius * 0.35, length, 12),
          material,
        );
        core.rotation.x = Math.PI / 2;
        mesh.add(core);
        for (let i = 0; i < blades; i++) {
          const t = i / blades;
          const angle = t * Math.PI * 3;
          const paddle = new THREE.Mesh(new THREE.BoxGeometry(0.06, radius * 2, 0.3), material);
          paddle.position.z = -length / 2 + t * length;
          paddle.rotation.z = angle;
          paddle.castShadow = true;
          mesh.add(paddle);
        }
        mesh.position.copy(home);
        this.group.add(mesh);
      }

      this.hazards.push({
        kind: 'screw',
        body,
        mesh,
        energy: 1400,
        active: 0,
        cooldown: 0,
        home,
        axis: new THREE.Vector3(0, 0, 1),
        phase: 0,
      });
      // The screws run continuously, like the real ones.
      body.setAngvel({ x: 0, y: 0, z: sx * 7.5 }, true);
    }
  }

  /** Crowd, banners and the room the box sits in. Cosmetic only. */
  private buildDressing(): void {
    const concrete = makeConcrete();
    const wallMat = new THREE.MeshStandardMaterial({
      map: concrete.map,
      normalMap: concrete.normalMap,
      roughnessMap: concrete.roughnessMap,
      metalness: 0.05,
      roughness: 0.94,
      side: THREE.BackSide,
    });
    const room = new THREE.Mesh(new THREE.BoxGeometry(46, 17, 46), wallMat);
    room.position.y = 6.5;
    this.group.add(room);

    const banner = makeBannerTexture();
    const bannerMat = new THREE.MeshStandardMaterial({
      map: banner,
      emissive: 0xffffff,
      emissiveMap: banner,
      emissiveIntensity: 0.22,
      roughness: 0.8,
    });
    for (let side = 0; side < 4; side++) {
      const angle = (side * Math.PI) / 2;
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE + 1.2, 0.46), bannerMat);
      strip.position.set(
        Math.sin(angle) * (ARENA_HALF + 0.9),
        WALL_HEIGHT + 0.42,
        Math.cos(angle) * (ARENA_HALF + 0.9),
      );
      strip.rotation.y = angle + Math.PI;
      this.group.add(strip);
    }

    const crowd = makeCrowdTexture();
    for (let side = 0; side < 4; side++) {
      const angle = (side * Math.PI) / 2;
      const material = new THREE.MeshBasicMaterial({
        map: crowd,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      });
      this.crowdMaterials.push(material);
      const stand = new THREE.Mesh(new THREE.PlaneGeometry(21, 4.2), material);
      stand.position.set(
        Math.sin(angle) * (ARENA_HALF + 5.6),
        2.5,
        Math.cos(angle) * (ARENA_HALF + 5.6),
      );
      stand.rotation.y = angle + Math.PI;
      this.group.add(stand);
    }
  }

  // -------------------------------------------------------------------------
  // Runtime
  // -------------------------------------------------------------------------

  /** Fire the killsaws. They rise, run, and drop back into their slots. */
  triggerKillsaws(duration = 5): void {
    for (const hazard of this.hazards) {
      if (hazard.kind !== 'killsaw' || hazard.cooldown > 0) continue;
      hazard.active = duration;
      hazard.cooldown = duration + 6;
    }
  }

  /** Swing a pulveriser. -1 for the near corner, +1 for the far one. */
  triggerPulverizer(side: -1 | 1): void {
    for (const hazard of this.hazards) {
      if (hazard.kind !== 'pulverizer' || hazard.cooldown > 0) continue;
      const isNear = hazard.home.z < 0;
      if ((side < 0) !== isNear) continue;
      hazard.active = 0.85;
      hazard.cooldown = 3.2;
    }
  }

  get killsawsUp(): boolean {
    return this.hazards.some((h) => h.kind === 'killsaw' && h.active > 0);
  }

  /** Advance hazard motion. Called from the fixed physics step. */
  update(dt: number): void {
    this.time += dt;

    for (const hazard of this.hazards) {
      if (hazard.cooldown > 0) hazard.cooldown -= dt;
      if (hazard.active > 0) hazard.active -= dt;

      switch (hazard.kind) {
        case 'killsaw': {
          // Rise over a quarter second, hold, then drop back.
          const raised = hazard.active > 0 ? smoothstep(0, 0.25, hazard.active > 0.3 ? 1 : hazard.active) : 0;
          const y = hazard.home.y + raised * 0.62;
          hazard.phase += dt * 230;
          hazard.body.setNextKinematicTranslation({ x: hazard.home.x, y, z: hazard.home.z });
          hazard.body.setNextKinematicRotation(
            axisAngleQuat(hazard.axis, hazard.phase),
          );
          if (hazard.mesh) {
            hazard.mesh.position.y = y;
            hazard.mesh.rotation.x = hazard.phase;
          }
          break;
        }
        case 'pulverizer': {
          // Snap down fast, recover slowly — the real ones hit hard and reset lazily.
          const t = hazard.active > 0 ? clamp01(1 - hazard.active / 0.85) : 0;
          const swing = t < 0.35 ? smoothstep(0, 0.35, t) : 1 - smoothstep(0.45, 1, t);
          const angle = swing * 1.5;
          hazard.body.setNextKinematicRotation(axisAngleQuat(hazard.axis, angle));
          if (hazard.mesh) hazard.mesh.rotation.x = angle;
          break;
        }
        case 'screw': {
          hazard.phase += dt * 7.5;
          if (hazard.mesh) hazard.mesh.rotation.z = hazard.phase * Math.sign(hazard.home.x);
          break;
        }
      }
    }
  }

  /** True when a machine has left the box — over the wall counts as a knockout. */
  isOutOfBounds(position: THREE.Vector3): boolean {
    const limit = ARENA_HALF + 0.4;
    return (
      Math.abs(position.x) > limit ||
      Math.abs(position.z) > limit ||
      position.y < -1.5 ||
      position.y > 6
    );
  }

  /** Nudge the crowd texture so the stands are not perfectly static. */
  animateCrowd(time: number): void {
    for (let i = 0; i < this.crowdMaterials.length; i++) {
      const material = this.crowdMaterials[i]!;
      material.opacity = 0.78 + Math.sin(time * 0.8 + i) * 0.06;
    }
  }
}

function axisAngleQuat(axis: THREE.Vector3, angle: number): RAPIER.Rotation {
  const s = Math.sin(angle / 2);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(angle / 2) };
}
