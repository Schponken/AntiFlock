/**
 * The arena, built as geometry.
 *
 * Reads its dimensions from `sim/arena` so the thing you can see and the thing
 * you collide with are guaranteed to be the same box.
 */

import * as THREE from 'three';
import {
  ARENA_HALF,
  ARENA_SIZE,
  CEILING_HEIGHT,
  KICKPLATE_HEIGHT,
  PULVERISERS,
  PULVERISER_PIVOT_Y,
  PULVERISER_REACH,
  PULVERISER_SWEEP,
  SAW_BANKS,
  SAW_RISE,
  WALL_HEIGHT,
  type Arena,
  pulveriserHeadPosition,
} from '../sim/arena';
import {
  crowdTexture,
  floorRoughness,
  floorTexture,
  gratingTexture,
  hazardStripeTexture,
  lexanTexture,
  metalTexture,
  paintedSteelTexture,
} from './textures';

export interface ArenaView {
  root: THREE.Group;
  /** Saw blade meshes, grouped per bank. */
  sawBlades: THREE.Mesh[][];
  /** Pulveriser arms, one per corner. */
  pulveriserArms: THREE.Group[];
  /** The four corner safety lights, red before the fight and green during. */
  safetyLights: THREE.Mesh[];
  safetyLightMaterial: THREE.MeshStandardMaterial;
  /** Wall panels, so the intro can flash them. */
  wallMaterial: THREE.MeshPhysicalMaterial;
}

export function buildArenaView(): ArenaView {
  const root = new THREE.Group();
  root.name = 'arena';

  // --- Floor -----------------------------------------------------------------
  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTexture(),
    roughnessMap: floorRoughness(),
    roughness: 0.62,
    metalness: 0.86,
    color: 0xffffff,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  root.add(floor);

  // Painted starting squares, red and blue.
  for (const [color, x] of [
    [0xd02a20, -4.4],
    [0x2a6ad0, 4.4],
  ] as const) {
    const square = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.05, 4, 1),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    square.rotation.x = -Math.PI / 2;
    square.rotation.z = Math.PI / 4;
    square.position.set(x, 0.006, 0);
    root.add(square);
  }

  // --- Walls -----------------------------------------------------------------
  // Polycarbonate: transmissive, scuffed, and it catches the arena lights.
  // Deliberately not using `transmission`: it costs a whole extra scene render
  // every frame, and for a scuffed panel seen at a glance a plain transparent
  // clearcoat is indistinguishable.
  const wallMaterial = new THREE.MeshPhysicalMaterial({
    map: lexanTexture(),
    color: 0xdceaf2,
    roughness: 0.16,
    metalness: 0.0,
    transparent: true,
    opacity: 0.17,
    side: THREE.DoubleSide,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    depthWrite: false,
  });

  const kickMaterial = new THREE.MeshStandardMaterial({
    map: hazardStripeTexture(),
    roughness: 0.62,
    metalness: 0.5,
  });

  const frameMaterial = new THREE.MeshStandardMaterial({
    map: paintedSteelTexture(0x24272d),
    roughness: 0.68,
    metalness: 0.72,
  });

  const sides: { pos: [number, number, number]; rot: number }[] = [
    { pos: [0, 0, -ARENA_HALF], rot: 0 },
    { pos: [0, 0, ARENA_HALF], rot: Math.PI },
    { pos: [-ARENA_HALF, 0, 0], rot: Math.PI / 2 },
    { pos: [ARENA_HALF, 0, 0], rot: -Math.PI / 2 },
  ];

  for (const side of sides) {
    const group = new THREE.Group();
    group.position.set(side.pos[0], side.pos[1], side.pos[2]);
    group.rotation.y = side.rot;

    // Kick plate along the bottom, in hazard yellow.
    const kick = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, KICKPLATE_HEIGHT), kickMaterial);
    kick.position.set(0, KICKPLATE_HEIGHT / 2, 0.01);
    group.add(kick);

    // The clear panel above it.
    const glassHeight = WALL_HEIGHT - KICKPLATE_HEIGHT;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, glassHeight), wallMaterial);
    glass.position.set(0, KICKPLATE_HEIGHT + glassHeight / 2, 0);
    group.add(glass);

    // Vertical mullions between the panels.
    const mullionCount = 6;
    for (let i = 0; i <= mullionCount; i++) {
      const x = -ARENA_HALF + (i / mullionCount) * ARENA_SIZE;
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.1, WALL_HEIGHT, 0.12),
        frameMaterial,
      );
      post.position.set(x, WALL_HEIGHT / 2, -0.02);
      post.castShadow = true;
      group.add(post);
    }

    // Top rail.
    const rail = new THREE.Mesh(new THREE.BoxGeometry(ARENA_SIZE + 0.3, 0.22, 0.3), frameMaterial);
    rail.position.set(0, WALL_HEIGHT, -0.05);
    rail.castShadow = true;
    group.add(rail);

    root.add(group);
  }

  // --- Roof truss ------------------------------------------------------------
  const trussMaterial = new THREE.MeshStandardMaterial({
    map: paintedSteelTexture(0x1a1d22),
    roughness: 0.75,
    metalness: 0.7,
  });
  for (let i = -3; i <= 3; i++) {
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA_SIZE + 1.2, 0.18, 0.18),
      trussMaterial,
    );
    beam.position.set(0, CEILING_HEIGHT + 0.4, i * 2.1);
    root.add(beam);

    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, ARENA_SIZE + 1.2), trussMaterial);
    cross.position.set(i * 2.1, CEILING_HEIGHT + 0.62, 0);
    root.add(cross);
  }

  // --- Stands and crowd ------------------------------------------------------
  const crowdMaterial = new THREE.MeshBasicMaterial({ map: crowdTexture(), toneMapped: false });
  const gratingMaterial = new THREE.MeshStandardMaterial({
    map: gratingTexture(),
    roughness: 0.8,
    metalness: 0.6,
  });

  for (const side of sides) {
    const group = new THREE.Group();
    group.position.set(side.pos[0] * 1.9, 0, side.pos[2] * 1.9);
    group.rotation.y = side.rot;

    // A raked bank of spectators behind each wall.
    const stand = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE * 2.1, 7), crowdMaterial);
    stand.position.set(0, 3.4, 0);
    stand.rotation.x = -0.22;
    group.add(stand);

    // Walkway in front of them.
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE * 2.1, 4), gratingMaterial);
    walk.rotation.x = -Math.PI / 2;
    walk.position.set(0, 0.02, 2.2);
    group.add(walk);

    root.add(group);
  }

  // --- Killsaws --------------------------------------------------------------
  const sawSteel = new THREE.MeshStandardMaterial({
    map: metalTexture(0xb8bec6),
    roughness: 0.24,
    metalness: 1.0,
  });
  // The slot the blades live in: a dark recess with grating in the bottom, so
  // it reads as a hole in the floor rather than a plate laid on top of it.
  const slotMaterial = new THREE.MeshStandardMaterial({
    map: gratingTexture(),
    color: 0x2a2d33,
    roughness: 0.95,
    metalness: 0.4,
  });

  const sawBlades: THREE.Mesh[][] = [];
  for (const layout of SAW_BANKS) {
    const blades: THREE.Mesh[] = [];
    const first = -((layout.bladeCount - 1) / 2) * layout.spacing;

    // The slot the blades come out of.
    const slotWidth = layout.radius * 2.1;
    const slotDepth = layout.spacing * layout.bladeCount + 0.18;
    const slot = new THREE.Mesh(new THREE.PlaneGeometry(slotWidth, slotDepth), slotMaterial);
    slot.rotation.x = -Math.PI / 2;
    // Sunk below the floor so it reads as a recess, with a lip around it.
    slot.position.set(layout.x, -0.05, layout.z);
    root.add(slot);

    const lip = new THREE.Mesh(
      new THREE.RingGeometry(0, 1, 4, 1),
      new THREE.MeshBasicMaterial({ color: 0x05060a, side: THREE.DoubleSide, depthWrite: false }),
    );
    lip.rotation.x = -Math.PI / 2;
    lip.rotation.z = Math.PI / 4;
    lip.scale.set(slotWidth * 0.72, slotDepth * 0.72, 1);
    lip.position.set(layout.x, 0.004, layout.z);
    root.add(lip);

    for (let i = 0; i < layout.bladeCount; i++) {
      const z = layout.z + first + i * layout.spacing;
      const blade = new THREE.Mesh(
        new THREE.CylinderGeometry(layout.radius, layout.radius, layout.thickness, 28),
        sawSteel,
      );
      // Stand the disc up so it spins about the arena's X axis.
      blade.rotation.z = Math.PI / 2;
      blade.position.set(layout.x, -layout.radius, z);
      blade.castShadow = true;

      // Teeth around the rim.
      const teeth = new THREE.Mesh(
        new THREE.TorusGeometry(layout.radius * 0.97, 0.022, 6, 24),
        sawSteel,
      );
      teeth.rotation.y = Math.PI / 2;
      blade.add(teeth);

      root.add(blade);
      blades.push(blade);
    }
    sawBlades.push(blades);
  }

  // --- Pulverisers -----------------------------------------------------------
  const pulveriserArms: THREE.Group[] = [];
  const hammerSteel = new THREE.MeshStandardMaterial({
    map: metalTexture(0x8e949c),
    roughness: 0.42,
    metalness: 0.95,
  });

  for (const layout of PULVERISERS) {
    // The gantry the hammer hangs from.
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, PULVERISER_PIVOT_Y, 0.22),
      frameMaterial,
    );
    post.position.set(layout.x, PULVERISER_PIVOT_Y / 2, layout.z);
    post.castShadow = true;
    root.add(post);

    const arm = new THREE.Group();
    arm.position.set(layout.x, PULVERISER_PIVOT_Y, layout.z);

    // The arm reaches along its own +X, which the yaw below points inward.
    const beam = new THREE.Mesh(
      new THREE.BoxGeometry(PULVERISER_REACH, 0.12, 0.16),
      hammerSteel,
    );
    beam.position.set(PULVERISER_REACH / 2, 0, 0);
    beam.castShadow = true;
    arm.add(beam);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.42), hammerSteel);
    head.position.set(PULVERISER_REACH, 0, 0);
    head.castShadow = true;
    arm.add(head);

    // A yaw of +phi about Y maps +X onto (cos phi, 0, -sin phi), so the sign is
    // flipped here to match the simulation's convention of +sin for Z.
    arm.rotation.y = -layout.yaw;
    root.add(arm);
    pulveriserArms.push(arm);
  }

  // --- Safety lights ---------------------------------------------------------
  const safetyLightMaterial = new THREE.MeshStandardMaterial({
    color: 0x330000,
    emissive: 0xff1500,
    emissiveIntensity: 2.4,
    roughness: 0.3,
  });
  const safetyLights: THREE.Mesh[] = [];
  for (const corner of [
    [-ARENA_HALF + 0.35, -ARENA_HALF + 0.35],
    [ARENA_HALF - 0.35, -ARENA_HALF + 0.35],
    [-ARENA_HALF + 0.35, ARENA_HALF - 0.35],
    [ARENA_HALF - 0.35, ARENA_HALF - 0.35],
  ] as const) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), safetyLightMaterial);
    lamp.position.set(corner[0], WALL_HEIGHT + 0.35, corner[1]);
    root.add(lamp);
    safetyLights.push(lamp);
  }

  return { root, sawBlades, pulveriserArms, safetyLights, safetyLightMaterial, wallMaterial };
}

/** Push the simulation's hazard state onto the meshes. */
export function syncArenaView(view: ArenaView, arena: Arena): void {
  for (let bank = 0; bank < arena.saws.length; bank++) {
    const saw = arena.saws[bank]!;
    const blades = view.sawBlades[bank];
    if (!blades) continue;
    const y = saw.restY + saw.extension * (saw.layout.radius + SAW_RISE);
    for (const blade of blades) {
      blade.position.y = y;
      // The cylinder is already rotated onto its side, so spinning it about its
      // own local Y is what turns the disc.
      blade.rotation.y = saw.angle;
    }
  }

  for (let i = 0; i < arena.pulverisers.length; i++) {
    const pulveriser = arena.pulverisers[i]!;
    const arm = view.pulveriserArms[i];
    if (!arm) continue;
    // Negative Z rotation swings the +X arm downward.
    arm.rotation.z = -pulveriser.swing * PULVERISER_SWEEP;
  }
}

/** Where a pulveriser head is, for spawning sparks at the right place. */
export { pulveriserHeadPosition };
