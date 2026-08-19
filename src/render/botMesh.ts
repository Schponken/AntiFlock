/**
 * Builds a bot's visible machine from its design: frame, armour panels, wheels,
 * weapon and lights. The returned handles let the simulation dent panels, tear
 * them off, stop wheels and spin the rotor without knowing anything about Three.js.
 */

import * as THREE from 'three';
import type { DerivedStats } from '../game/design.ts';
import type { BotDesign } from '../game/design.ts';
import { finishById } from '../game/parts.ts';
import type { ArmorFace } from '../game/damage.ts';
import {
  makeLiveryTexture,
  makeMetalTexture,
  makeTyreTexture,
} from './textures.ts';

export interface BotVisual {
  root: THREE.Group;
  /** Chassis-space child that everything rigid hangs off. */
  body: THREE.Group;
  armorPanels: Map<ArmorFace, THREE.Mesh>;
  wheels: THREE.Object3D[];
  /** Rotor / arm, driven by its own physics body. */
  weapon: THREE.Group | null;
  weaponPivot: THREE.Group | null;
  underglow: THREE.PointLight;
  teamLight: THREE.Mesh;
  dispose(): void;
}

const disposables: THREE.BufferGeometry[] = [];
const track = <T extends THREE.BufferGeometry>(geometry: T): T => {
  disposables.push(geometry);
  return geometry;
};

/** A box with its edges knocked off, which is what welded plate actually looks like. */
function bevelledBox(w: number, h: number, d: number, bevel = 0.012): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = w / 2;
  const hh = h / 2;
  const b = Math.min(bevel, hw * 0.4, hh * 0.4);
  shape.moveTo(-hw + b, -hh);
  shape.lineTo(hw - b, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + b);
  shape.lineTo(hw, hh - b);
  shape.quadraticCurveTo(hw, hh, hw - b, hh);
  shape.lineTo(-hw + b, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - b);
  shape.lineTo(-hw, -hh + b);
  shape.quadraticCurveTo(-hw, -hh, -hw + b, -hh);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: true,
    bevelThickness: b * 0.8,
    bevelSize: b * 0.8,
    bevelSegments: 2,
    curveSegments: 3,
  });
  geometry.translate(0, 0, -d / 2);
  geometry.computeVertexNormals();
  return track(geometry);
}

function liveryMaterial(design: BotDesign, seed: number): THREE.MeshPhysicalMaterial {
  const finish = finishById(design.paint.finishId);
  const map = makeLiveryTexture(
    design.paint.primary,
    design.paint.secondary,
    design.paint.accent,
    design.paint.decal,
    seed,
  );
  const metal = makeMetalTexture(0x8b9099, seed);
  return new THREE.MeshPhysicalMaterial({
    map,
    normalMap: metal.normalMap,
    normalScale: new THREE.Vector2(0.5, 0.5),
    roughnessMap: metal.roughnessMap,
    metalness: finish.metalness,
    roughness: finish.roughness,
    clearcoat: finish.clearcoat,
    clearcoatRoughness: 0.22,
    envMapIntensity: 1.1,
  });
}

function rawMetalMaterial(tint: number, seed: number, roughness = 0.42): THREE.MeshStandardMaterial {
  const maps = makeMetalTexture(tint, seed);
  return new THREE.MeshStandardMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    roughnessMap: maps.roughnessMap,
    // Fully metallic surfaces have no diffuse response at all, so in a dark arena
    // they read as solid black silhouettes. Backing off the metalness and lifting
    // the environment contribution keeps steel looking like steel under the lights.
    metalness: 0.72,
    roughness: Math.max(0.3, roughness),
    envMapIntensity: 1.8,
  });
}

/** Impact teeth welded around a rotor. */
function addTeeth(
  parent: THREE.Object3D,
  count: number,
  radius: number,
  size: number,
  material: THREE.Material,
  axis: 'x' | 'y' | 'z',
): void {
  const geometry = track(new THREE.BoxGeometry(size * 1.6, size, size * 1.15));
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const tooth = new THREE.Mesh(geometry, material);
    if (axis === 'x') {
      tooth.position.set(0, Math.cos(angle) * radius, Math.sin(angle) * radius);
      tooth.rotation.x = -angle;
    } else {
      tooth.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      tooth.rotation.y = angle;
    }
    tooth.castShadow = true;
    parent.add(tooth);
  }
}

function buildRotor(stats: DerivedStats, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const rotor = stats.parts.weapon.rotor;
  if (!rotor) return group;

  const { shape, radius, thickness, span, teeth, axis } = rotor;

  switch (shape) {
    case 'disc': {
      const disc = new THREE.Mesh(
        track(new THREE.CylinderGeometry(radius, radius, thickness, 40, 1)),
        material,
      );
      // Cylinders are built around Y; lay it over for an X-axis weapon.
      if (axis === 'x') disc.rotation.z = Math.PI / 2;
      disc.castShadow = true;
      group.add(disc);

      // Lightening pockets. Cut as shallow recesses in the same steel rather than
      // black holes, which at a distance just read as a hole in the machine.
      const pocket = track(
        new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, thickness * 0.55, 12),
      );
      const pocketMat = new THREE.MeshStandardMaterial({
        color: 0x6a7079,
        metalness: 0.6,
        roughness: 0.75,
      });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const hole = new THREE.Mesh(pocket, pocketMat);
        hole.position.set(0, Math.cos(a) * radius * 0.52, Math.sin(a) * radius * 0.52);
        if (axis === 'x') hole.rotation.z = Math.PI / 2;
        group.add(hole);
      }
      addTeeth(group, teeth, radius * 0.97, thickness * 1.9, material, axis);
      break;
    }
    case 'bar': {
      const depth = radius * 0.24;
      const bar = new THREE.Mesh(track(new THREE.BoxGeometry(span, thickness, depth)), material);
      if (axis === 'y') {
        bar.rotation.set(0, 0, 0);
        // A horizontal bar lies flat: length on X, thickness on Y.
      } else {
        bar.rotation.z = Math.PI / 2;
      }
      bar.castShadow = true;
      group.add(bar);

      // Hardened tips at each end.
      const tipGeom = track(new THREE.BoxGeometry(span * 0.09, thickness * 1.5, depth * 1.25));
      for (const sign of [-1, 1]) {
        const tip = new THREE.Mesh(tipGeom, material);
        tip.position.set(sign * (span / 2 - span * 0.045), 0, 0);
        tip.castShadow = true;
        group.add(tip);
      }
      break;
    }
    case 'drum': {
      const drum = new THREE.Mesh(
        track(new THREE.CylinderGeometry(radius, radius, span, 28, 1)),
        material,
      );
      drum.rotation.z = Math.PI / 2;
      drum.castShadow = true;
      group.add(drum);
      const toothGeom = track(new THREE.BoxGeometry(span * 0.94, radius * 0.34, radius * 0.3));
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const tooth = new THREE.Mesh(toothGeom, material);
        tooth.position.set(0, Math.cos(a) * radius * 0.96, Math.sin(a) * radius * 0.96);
        tooth.rotation.x = -a;
        tooth.castShadow = true;
        group.add(tooth);
      }
      break;
    }
    case 'ring': {
      const ringGeom = track(new THREE.TorusGeometry(radius * 0.92, thickness * 1.2, 8, 26));
      for (const sign of [-1, 1]) {
        const ring = new THREE.Mesh(ringGeom, material);
        ring.position.x = (sign * span) / 2;
        ring.rotation.y = Math.PI / 2;
        ring.castShadow = true;
        group.add(ring);
      }
      const barGeom = track(
        new THREE.BoxGeometry(span, thickness * 2.2, thickness * 1.6),
      );
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const bar = new THREE.Mesh(barGeom, material);
        bar.position.set(0, Math.cos(a) * radius * 0.9, Math.sin(a) * radius * 0.9);
        bar.rotation.x = -a;
        bar.castShadow = true;
        group.add(bar);
      }
      break;
    }
  }
  return group;
}

/** Flippers, hammers and crushers are all an arm on a pivot; only the shape differs. */
function buildArm(stats: DerivedStats, material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  const weapon = stats.parts.weapon;
  const reach = weapon.actuator?.reach ?? weapon.clamp?.reach ?? 0.4;
  const width = stats.parts.chassis.width * 0.72;

  switch (weapon.kind) {
    case 'flipper': {
      const plate = new THREE.Mesh(track(new THREE.BoxGeometry(width, 0.016, reach)), material);
      plate.position.z = reach / 2;
      plate.castShadow = true;
      group.add(plate);
      const ribGeom = track(new THREE.BoxGeometry(0.02, 0.05, reach * 0.85));
      for (const sign of [-1, 0, 1]) {
        const rib = new THREE.Mesh(ribGeom, material);
        rib.position.set(sign * width * 0.34, -0.03, reach * 0.5);
        group.add(rib);
      }
      break;
    }
    case 'hammer': {
      const shaft = new THREE.Mesh(
        track(new THREE.BoxGeometry(0.055, 0.055, reach)),
        material,
      );
      shaft.position.z = reach / 2;
      shaft.castShadow = true;
      group.add(shaft);
      const head = new THREE.Mesh(track(new THREE.BoxGeometry(0.13, 0.11, 0.16)), material);
      head.position.z = reach;
      head.castShadow = true;
      group.add(head);
      const beak = new THREE.Mesh(track(new THREE.ConeGeometry(0.045, 0.12, 4)), material);
      beak.position.set(0, -0.09, reach);
      beak.rotation.x = Math.PI;
      group.add(beak);
      break;
    }
    case 'crusher': {
      const upper = new THREE.Mesh(track(new THREE.BoxGeometry(0.09, 0.07, reach)), material);
      upper.position.z = reach / 2;
      upper.castShadow = true;
      group.add(upper);
      const tooth = new THREE.Mesh(track(new THREE.ConeGeometry(0.05, 0.15, 5)), material);
      tooth.position.set(0, -0.1, reach * 0.92);
      tooth.rotation.x = Math.PI;
      tooth.castShadow = true;
      group.add(tooth);
      break;
    }
    default: {
      const wedge = new THREE.Mesh(track(new THREE.BoxGeometry(width, 0.02, reach)), material);
      wedge.position.z = reach / 2;
      group.add(wedge);
    }
  }
  return group;
}

/** Dimensions of the front wedge, shared by its mesh and its collider. */
export function wedgeDimensions(chassis: { width: number; height: number }): {
  hw: number;
  rise: number;
  depth: number;
} {
  return {
    hw: chassis.width * 0.48,
    rise: chassis.height * 0.55,
    depth: 0.24,
  };
}

/**
 * The static front wedge, used by wedge bots and by anything fitted with forks.
 *
 * Built from explicit vertices rather than an extruded shape. An extrusion has to
 * be rotated and translated into place afterwards, and getting either wrong
 * produces a slab lying across the floor at an angle rather than a ramp bolted to
 * the nose — which is exactly what happened. These six points are unambiguous,
 * and `wedgeCorners` in bot.ts builds the collider from the same description.
 */
function buildWedge(stats: DerivedStats, material: THREE.Material): THREE.Mesh {
  const { hw, rise, depth } = wedgeDimensions(stats.parts.chassis);

  // Tip along +Z at floor level, rising to a back face at the chassis nose.
  const tipL = [-hw, 0, depth];
  const tipR = [hw, 0, depth];
  const backBottomL = [-hw, 0, 0];
  const backBottomR = [hw, 0, 0];
  const backTopL = [-hw, rise, 0];
  const backTopR = [hw, rise, 0];

  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const positions = new Float32Array([
    // Ramp face.
    ...tri(tipL, tipR, backTopR),
    ...tri(tipL, backTopR, backTopL),
    // Underside.
    ...tri(tipL, backBottomL, backBottomR),
    ...tri(tipL, backBottomR, tipR),
    // Back face against the chassis.
    ...tri(backBottomL, backTopL, backTopR),
    ...tri(backBottomL, backTopR, backBottomR),
    // Sides.
    ...tri(tipL, backTopL, backBottomL),
    ...tri(tipR, backBottomR, backTopR),
  ]);

  const geometry = track(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function buildBotVisual(
  design: BotDesign,
  stats: DerivedStats,
  team: 0 | 1,
): BotVisual {
  const { chassis, weapon, wheel, armor, weaponMaterial } = stats.parts;
  const root = new THREE.Group();
  root.name = `bot-${design.name}`;
  const body = new THREE.Group();
  root.add(body);

  const seed = team === 0 ? 5 : 11;
  const paintMat = liveryMaterial(design, seed);
  const frameMat = rawMetalMaterial(armor.colorHint, seed + 1, armor.roughness);
  const weaponMat = rawMetalMaterial(weaponMaterial.colorHint, seed + 2, weaponMaterial.roughness);

  // --- Frame -------------------------------------------------------------
  const frame = new THREE.Mesh(
    bevelledBox(chassis.width * 0.94, chassis.height * 0.86, chassis.length * 0.94),
    frameMat,
  );
  frame.castShadow = true;
  frame.receiveShadow = true;
  body.add(frame);

  // --- Armour panels -----------------------------------------------------
  const armorPanels = new Map<ArmorFace, THREE.Mesh>();
  const plate = Math.max(0.008, stats.parts.chassis.armorArea > 0 ? design.armorThicknessMm / 1000 : 0.008);
  const hw = chassis.width / 2;
  const hh = chassis.height / 2;
  const hl = chassis.length / 2;

  const panelDefs: { face: ArmorFace; geom: [number, number, number]; pos: [number, number, number] }[] = [
    { face: 'front', geom: [chassis.width, chassis.height, plate], pos: [0, 0, hl] },
    { face: 'rear', geom: [chassis.width, chassis.height, plate], pos: [0, 0, -hl] },
    { face: 'left', geom: [plate, chassis.height, chassis.length], pos: [-hw, 0, 0] },
    { face: 'right', geom: [plate, chassis.height, chassis.length], pos: [hw, 0, 0] },
    { face: 'top', geom: [chassis.width, plate, chassis.length], pos: [0, hh, 0] },
    { face: 'bottom', geom: [chassis.width, plate, chassis.length], pos: [0, -hh, 0] },
  ];

  for (const def of panelDefs) {
    const mesh = new THREE.Mesh(
      track(new THREE.BoxGeometry(def.geom[0], def.geom[1], def.geom[2])),
      paintMat.clone(),
    );
    mesh.position.set(def.pos[0], def.pos[1], def.pos[2]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `armor-${def.face}`;
    body.add(mesh);
    armorPanels.set(def.face, mesh);
  }

  // --- Wedge / forks -----------------------------------------------------
  if (weapon.kind === 'wedge' || stats.parts.accessories.includes('forks')) {
    const wedge = buildWedge(stats, weapon.kind === 'wedge' ? paintMat : frameMat);
    wedge.position.set(0, -hh, hl - 0.01);
    body.add(wedge);
  }

  if (stats.parts.accessories.includes('wedgelets')) {
    const geom = track(new THREE.BoxGeometry(chassis.width * 0.26, 0.012, 0.14));
    for (const sign of [-1, 1]) {
      const wedgelet = new THREE.Mesh(geom, frameMat);
      wedgelet.position.set(sign * chassis.width * 0.3, -hh + 0.006, hl + 0.06);
      wedgelet.rotation.x = -0.09;
      body.add(wedgelet);
    }
  }

  if (stats.parts.accessories.includes('skirts')) {
    const geom = track(new THREE.BoxGeometry(0.01, chassis.height * 0.4, chassis.length * 0.9));
    for (const sign of [-1, 1]) {
      const skirt = new THREE.Mesh(geom, frameMat);
      skirt.position.set(sign * (hw + 0.008), -hh - chassis.height * 0.12, 0);
      body.add(skirt);
    }
  }

  // --- Wheels ------------------------------------------------------------
  const tyre = makeTyreTexture();
  const tyreMat = new THREE.MeshStandardMaterial({
    map: tyre.map,
    normalMap: tyre.normalMap,
    roughnessMap: tyre.roughnessMap,
    color: 0x2a2d31,
    metalness: 0.05,
    roughness: 0.85,
  });
  const hubMat = rawMetalMaterial(0xb8bec6, seed + 3, 0.3);
  const wheelGeom = track(
    new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 22, 1),
  );
  const hubGeom = track(
    new THREE.CylinderGeometry(wheel.radius * 0.42, wheel.radius * 0.42, wheel.width * 1.08, 12),
  );

  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < chassis.wheelCount; i++) {
    const group = new THREE.Group();
    const tyreMesh = new THREE.Mesh(wheelGeom, tyreMat);
    tyreMesh.rotation.z = Math.PI / 2;
    tyreMesh.castShadow = true;
    group.add(tyreMesh);
    const hub = new THREE.Mesh(hubGeom, hubMat);
    hub.rotation.z = Math.PI / 2;
    group.add(hub);
    root.add(group);
    wheels.push(group);
  }

  // --- Weapon ------------------------------------------------------------
  let weaponGroup: THREE.Group | null = null;
  let weaponPivot: THREE.Group | null = null;
  if (weapon.rotor) {
    weaponPivot = new THREE.Group();
    weaponGroup = buildRotor(stats, weaponMat);
    weaponPivot.add(weaponGroup);
    root.add(weaponPivot);

    // Weapon uprights, so the rotor visibly belongs to the machine.
    const postGeom = track(new THREE.BoxGeometry(0.035, chassis.height * 0.8, 0.05));
    for (const sign of [-1, 1]) {
      const post = new THREE.Mesh(postGeom, frameMat);
      post.position.set(
        sign * (weapon.rotor.axis === 'x' ? chassis.width * 0.42 : chassis.width * 0.2),
        chassis.weaponMount.y * 0.4,
        chassis.weaponMount.z * 0.72,
      );
      body.add(post);
    }
  } else if (weapon.actuator || weapon.clamp) {
    weaponPivot = new THREE.Group();
    weaponGroup = buildArm(stats, weaponMat);
    weaponPivot.add(weaponGroup);
    root.add(weaponPivot);
  }

  // --- Lights ------------------------------------------------------------
  const underglow = new THREE.PointLight(design.paint.glow, 0, 1.6, 2);
  underglow.position.set(0, -hh - 0.05, 0);
  body.add(underglow);

  // Every bot in the box carries a lit team indicator. It is a rule, and it is
  // also the only way the audience tells two dark machines apart.
  const teamColor = team === 0 ? 0xff2b2b : 0x2b6bff;
  const teamLight = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.035, 12, 10)),
    new THREE.MeshStandardMaterial({
      color: teamColor,
      emissive: teamColor,
      emissiveIntensity: 3.4,
      roughness: 0.3,
    }),
  );
  teamLight.position.set(0, hh + 0.03, -hl * 0.55);
  body.add(teamLight);

  const dispose = () => {
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        const material = object.material;
        if (Array.isArray(material)) material.forEach((m) => m.dispose());
        else material.dispose();
      }
    });
  };

  return {
    root,
    body,
    armorPanels,
    wheels,
    weapon: weaponGroup,
    weaponPivot,
    underglow,
    teamLight,
    dispose,
  };
}
