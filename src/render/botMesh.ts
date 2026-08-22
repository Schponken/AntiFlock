/**
 * Builds a bot's visible machine from its design.
 *
 * The goal here is that a machine reads as *fabricated*: a welded frame with
 * armour bolted to it, motor cans down in the belly, a belt running from the
 * weapon motor to the rotor hub, bearing blocks carrying the shaft, and
 * fasteners everywhere. All of it is generated from the same design the physics
 * rig is built from, so a thicker armour spec really does produce visibly
 * thicker plate and a bigger disc really does have a bigger hub.
 *
 * The returned handles let the simulation dent panels, tear them off, stop
 * wheels and spin the rotor without knowing anything about Three.js.
 */

import * as THREE from 'three';
import type { BotDesign, DerivedStats } from '../game/design.ts';
import { finishById } from '../game/parts.ts';
import type { ArmorFace } from '../game/damage.ts';
import { makeLiveryTexture, makeMetalTexture, makeTyreTexture } from './textures.ts';
import {
  GeometryRegistry,
  beltBand,
  boltCluster,
  chamferedPlate,
  flushBoltGeometry,
  hexBoltGeometry,
  mergeGeometries,
  motorCan,
  pillowBlock,
  pulley,
  ringPlacements,
  rowPlacements,
  sprocketGeometry,
  applyPlanarUV,
  type BoltPlacement,
} from './hardware.ts';

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

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

function liveryMaterial(
  registry: GeometryRegistry,
  design: BotDesign,
  seed: number,
): THREE.MeshPhysicalMaterial {
  const finish = finishById(design.paint.finishId);
  const map = makeLiveryTexture(
    design.paint.primary,
    design.paint.secondary,
    design.paint.accent,
    design.paint.decal,
    seed,
  );
  const metal = makeMetalTexture(0x8b9099, seed);
  return registry.material(
    new THREE.MeshPhysicalMaterial({
      map,
      normalMap: metal.normalMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
      roughnessMap: metal.roughnessMap,
      metalness: finish.metalness,
      roughness: finish.roughness,
      clearcoat: finish.clearcoat,
      clearcoatRoughness: 0.22,
      envMapIntensity: 1.1,
    }),
  );
}

function rawMetalMaterial(
  registry: GeometryRegistry,
  tint: number,
  seed: number,
  roughness = 0.42,
): THREE.MeshStandardMaterial {
  const maps = makeMetalTexture(tint, seed);
  return registry.material(
    new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      // Fully metallic surfaces have no diffuse response at all, so in a dark
      // arena they read as solid black silhouettes. Backing off the metalness and
      // lifting the environment contribution keeps steel looking like steel.
      metalness: 0.72,
      roughness: Math.max(0.34, roughness),
      envMapIntensity: 1.25,
    }),
  );
}

/** Plain machined aluminium, for hubs, brackets and bearing housings. */
function machinedMaterial(registry: GeometryRegistry, seed: number): THREE.MeshStandardMaterial {
  const maps = makeMetalTexture(0xa9b0b8, seed);
  return registry.material(
    new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      metalness: 0.76,
      roughness: 0.46,
      envMapIntensity: 1.1,
    }),
  );
}

/** Anodised black hardware: motor cans, belts, fasteners. */
function hardwareMaterial(registry: GeometryRegistry, seed: number): THREE.MeshStandardMaterial {
  const maps = makeMetalTexture(0x4a4e55, seed);
  return registry.material(
    new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      metalness: 0.6,
      roughness: 0.58,
      envMapIntensity: 0.95,
    }),
  );
}

// ---------------------------------------------------------------------------
// Weapon rotors
// ---------------------------------------------------------------------------

/** Impact teeth: chamfered blocks bolted around the rim, not plain cubes. */
function addTeeth(
  registry: GeometryRegistry,
  parent: THREE.Object3D,
  options: {
    count: number;
    radius: number;
    size: number;
    axis: 'x' | 'y' | 'z';
    material: THREE.Material;
    boltMaterial: THREE.Material;
  },
): void {
  const { count, radius, size, axis, material, boltMaterial } = options;

  // A tooth is a wedge: a broad root at the disc and a narrower hardened tip.
  const geometry = registry.geometry(
    new THREE.CylinderGeometry(size * 0.55, size * 1.05, size * 2.1, 4, 1),
  );
  const bolts: BoltPlacement[] = [];

  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const tooth = new THREE.Mesh(geometry, material);
    if (axis === 'x') {
      tooth.position.set(0, Math.cos(angle) * radius, Math.sin(angle) * radius);
      /*
       * Rx(t) takes the cylinder's own +Y axis to (0, cos t, sin t), which is the
       * radial direction at angle +t — so a part sitting at +angle has to be
       * rotated by +angle, not -angle. The negated version pointed every tooth at
       * the mirror-image angle: 90 degrees out at the quarter positions and fully
       * reversed at the top and bottom of the disc, which is why the teeth read as
       * scattered debris rather than as a bolt circle. (`rotation.y` stays: with
       * Three's XYZ order it is applied first, about the tooth's own axis, so it
       * is a genuine roll that puts a corner rather than a flat face into the hit.)
       */
      tooth.rotation.x = angle;
      tooth.rotation.y = Math.PI / 4;
      /*
       * The bolt sits on the tooth's face, not out in the air past it.
       *
       * `size * 1.1` was a guess: a 4-segment prism rolled 45 degrees only reaches
       * `size * cos(45)` across its flats, so a 25 mm bolt head floated 11.8 mm
       * clear of the part it was supposed to be retaining. Real bolt-on teeth are
       * through-bolted, so both faces get a head.
       */
      for (const facing of [1, -1] as const) {
        bolts.push({
          position: new THREE.Vector3(
            facing * size * Math.SQRT1_2,
            Math.cos(angle) * radius * 0.92,
            Math.sin(angle) * radius * 0.92,
          ),
          normal: new THREE.Vector3(facing, 0, 0),
        });
      }
    } else {
      tooth.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
      tooth.rotation.z = angle + Math.PI / 2;
      tooth.rotation.y = Math.PI / 4;
      bolts.push({
        position: new THREE.Vector3(
          Math.cos(angle) * radius * 0.9,
          size * Math.SQRT1_2,
          Math.sin(angle) * radius * 0.9,
        ),
        normal: new THREE.Vector3(0, 1, 0),
      });
    }
    tooth.castShadow = true;
    parent.add(tooth);
  }

  const cluster = boltCluster(
    registry,
    hexBoltGeometry(registry, size * 0.3),
    boltMaterial,
    bolts,
  );
  if (cluster) parent.add(cluster);
}

/** The rotating element, with a real hub, bolt circle and drive pulley. */
function buildRotor(
  registry: GeometryRegistry,
  stats: DerivedStats,
  material: THREE.Material,
  hubMaterial: THREE.Material,
  boltMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const rotor = stats.parts.weapon.rotor;
  if (!rotor) return group;

  const { shape, radius, thickness, span, teeth, axis } = rotor;
  const spinAxis = axis === 'y' ? 'y' : 'x';

  switch (shape) {
    case 'disc': {
      const disc = new THREE.Mesh(
        registry.geometry(new THREE.CylinderGeometry(radius, radius, thickness, 44, 1)),
        material,
      );
      if (axis === 'x') disc.rotation.z = Math.PI / 2;
      disc.castShadow = true;
      group.add(disc);

      // Lightening pockets: shallow machined recesses, which is where the mass
      // the catalogue removed actually went.
      const pocket = registry.geometry(
        new THREE.CylinderGeometry(radius * 0.17, radius * 0.17, thickness * 1.02, 14),
      );
      const pocketMat = registry.material(
        new THREE.MeshStandardMaterial({ color: 0x5c626b, metalness: 0.6, roughness: 0.8 }),
      );
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const hole = new THREE.Mesh(pocket, pocketMat);
        hole.position.set(0, Math.cos(a) * radius * 0.55, Math.sin(a) * radius * 0.55);
        if (axis === 'x') hole.rotation.z = Math.PI / 2;
        group.add(hole);
      }

      addHub(registry, group, {
        radius: radius * 0.26,
        length: thickness * 3.4,
        axis: spinAxis,
        material: hubMaterial,
        boltMaterial,
        boltRadius: radius * 0.18,
      });
      addTeeth(registry, group, {
        count: teeth,
        radius: radius * 0.94,
        size: thickness * 1.5,
        axis: spinAxis,
        material,
        boltMaterial,
      });
      break;
    }

    case 'bar': {
      const depth = radius * 0.24;
      const bar = new THREE.Mesh(
        registry.geometry(new THREE.BoxGeometry(span, thickness, depth)),
        material,
      );
      if (axis !== 'y') bar.rotation.z = Math.PI / 2;
      bar.castShadow = true;
      group.add(bar);

      // Bolt-on hardened tips: the part that actually hits, replaced between fights.
      const tipGeom = registry.geometry(
        new THREE.CylinderGeometry(depth * 0.42, depth * 0.66, span * 0.1, 4, 1),
      );
      const tipBolts: BoltPlacement[] = [];
      for (const sign of [-1, 1]) {
        const tip = new THREE.Mesh(tipGeom, material);
        if (axis === 'y') {
          tip.position.set(sign * (span / 2 - span * 0.045), 0, 0);
          // Rz lays the tip along X, which is the bar's own axis; the roll then
          // has to be about X too. With Three's XYZ order Ry is applied *before*
          // Rz, so it acted on the untransformed part and swung the tip 45 degrees
          // out of the bar — the same Euler-order trap the drum teeth had.
          tip.rotation.set(Math.PI / 4, 0, sign > 0 ? -Math.PI / 2 : Math.PI / 2);
          tipBolts.push({
            position: new THREE.Vector3(sign * span * 0.4, thickness * 0.6, 0),
            normal: new THREE.Vector3(0, 1, 0),
          });
        } else {
          tip.position.set(0, sign * (span / 2 - span * 0.045), 0);
          tip.rotation.y = Math.PI / 4;
          tipBolts.push({
            position: new THREE.Vector3(thickness * 0.6, sign * span * 0.4, 0),
            normal: new THREE.Vector3(1, 0, 0),
          });
        }
        tip.castShadow = true;
        group.add(tip);
      }
      const cluster = boltCluster(
        registry,
        hexBoltGeometry(registry, thickness * 0.35),
        boltMaterial,
        tipBolts,
      );
      if (cluster) group.add(cluster);

      addHub(registry, group, {
        radius: depth * 0.62,
        length: thickness * 3.6,
        axis: spinAxis,
        material: hubMaterial,
        boltMaterial,
        boltRadius: depth * 0.42,
      });
      break;
    }

    case 'drum': {
      const drum = new THREE.Mesh(
        registry.geometry(new THREE.CylinderGeometry(radius, radius, span, 32, 1)),
        material,
      );
      drum.rotation.z = Math.PI / 2;
      drum.castShadow = true;
      group.add(drum);

      // End caps, proud of the shell like the real welded discs.
      const capGeom = registry.geometry(
        new THREE.CylinderGeometry(radius * 1.03, radius * 1.03, span * 0.05, 32),
      );
      for (const sign of [-1, 1]) {
        const cap = new THREE.Mesh(capGeom, hubMaterial);
        cap.rotation.z = Math.PI / 2;
        cap.position.x = (sign * span) / 2;
        group.add(cap);
      }

      const toothGeom = registry.geometry(
        new THREE.CylinderGeometry(radius * 0.16, radius * 0.3, span * 0.92, 4, 1),
      );
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const tooth = new THREE.Mesh(toothGeom, material);
        tooth.position.set(0, Math.cos(a) * radius * 0.99, Math.sin(a) * radius * 0.99);
        /*
         * A drum's teeth run the length of the drum, parallel to its axis. Rz lays
         * the cylinder along -X, which is that axis, and Rx is then a pure roll
         * about it — the `a` keeps each tooth square to its own radius and the
         * quarter turn puts a corner outward. Setting `rotation.y` instead swung
         * the tooth 45 degrees out of the drum entirely, because with the XYZ order
         * Ry is applied *before* Rz and so acts on the untransformed part.
         */
        tooth.rotation.set(a + Math.PI / 4, 0, Math.PI / 2);
        tooth.castShadow = true;
        group.add(tooth);
      }
      addHub(registry, group, {
        radius: radius * 0.2,
        length: span * 1.3,
        axis: 'x',
        material: hubMaterial,
        boltMaterial,
        boltRadius: radius * 0.13,
      });
      break;
    }

    case 'ring': {
      // A cage rotor: two end rings joined by the bars that do the hitting.
      const ringGeom = registry.geometry(
        new THREE.TorusGeometry(radius * 0.92, thickness * 1.2, 8, 30),
      );
      for (const sign of [-1, 1]) {
        const ring = new THREE.Mesh(ringGeom, material);
        ring.position.x = (sign * span) / 2;
        ring.rotation.y = Math.PI / 2;
        ring.castShadow = true;
        group.add(ring);
      }
      const barGeom = registry.geometry(
        new THREE.CylinderGeometry(thickness * 1.25, thickness * 1.25, span, 5),
      );
      for (let i = 0; i < teeth; i++) {
        const a = (i / teeth) * Math.PI * 2;
        const bar = new THREE.Mesh(barGeom, material);
        bar.position.set(0, Math.cos(a) * radius * 0.9, Math.sin(a) * radius * 0.9);
        bar.rotation.z = Math.PI / 2;
        bar.castShadow = true;
        group.add(bar);
      }
      // Spokes tying the rings back to the shaft.
      const spokeGeom = registry.geometry(
        new THREE.BoxGeometry(thickness * 1.4, radius * 0.9, thickness * 2),
      );
      for (const sign of [-1, 1]) {
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * Math.PI * 2;
          const spoke = new THREE.Mesh(spokeGeom, hubMaterial);
          spoke.position.set(
            (sign * span) / 2,
            (Math.cos(a) * radius * 0.9) / 2,
            (Math.sin(a) * radius * 0.9) / 2,
          );
          spoke.rotation.x = a;
          group.add(spoke);
        }
      }
      addHub(registry, group, {
        radius: radius * 0.16,
        length: span * 1.1,
        axis: 'x',
        material: hubMaterial,
        boltMaterial,
        boltRadius: radius * 0.1,
      });
      break;
    }
  }

  return group;
}

/** Central hub and its bolt circle, where the rotor keys onto the shaft. */
function addHub(
  registry: GeometryRegistry,
  parent: THREE.Object3D,
  options: {
    radius: number;
    length: number;
    axis: 'x' | 'y';
    material: THREE.Material;
    boltMaterial: THREE.Material;
    boltRadius: number;
  },
): void {
  const { radius, length, axis, material, boltMaterial, boltRadius } = options;

  const hub = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(radius, radius, length, 18)),
    material,
  );
  if (axis === 'x') hub.rotation.z = Math.PI / 2;
  hub.castShadow = true;
  parent.add(hub);

  const placements: BoltPlacement[] = [];
  for (const facing of [1, -1] as const) {
    placements.push(
      ...ringPlacements({
        count: 6,
        radius: boltRadius,
        axis,
        offset: (facing * length) / 2,
        facing,
      }),
    );
  }
  const cluster = boltCluster(
    registry,
    flushBoltGeometry(registry, boltRadius * 0.32),
    boltMaterial,
    placements,
  );
  if (cluster) parent.add(cluster);
}

// ---------------------------------------------------------------------------
// Actuated arms
// ---------------------------------------------------------------------------

/** Flippers, hammers and crushers are all an arm on a pivot; only the tool differs. */
function buildArm(
  registry: GeometryRegistry,
  stats: DerivedStats,
  material: THREE.Material,
  hubMaterial: THREE.Material,
  boltMaterial: THREE.Material,
): THREE.Group {
  const group = new THREE.Group();
  const weapon = stats.parts.weapon;
  const reach = weapon.actuator?.reach ?? weapon.clamp?.reach ?? 0.4;
  const width = stats.parts.chassis.width * 0.72;

  // Every arm turns on a real pivot tube.
  const pivot = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(0.028, 0.028, width * 0.9, 14)),
    hubMaterial,
  );
  pivot.rotation.z = Math.PI / 2;
  group.add(pivot);

  switch (weapon.kind) {
    case 'flipper': {
      const plate = new THREE.Mesh(
        chamferedPlate(registry, { width, height: reach, thickness: 0.016 }),
        material,
      );
      plate.rotation.x = -Math.PI / 2;
      plate.position.z = reach / 2;
      plate.castShadow = true;
      group.add(plate);

      // Stiffening ribs under the plate, and the bolts holding it to them.
      const ribGeom = registry.geometry(new THREE.BoxGeometry(0.016, 0.05, reach * 0.86));
      const bolts: BoltPlacement[] = [];
      for (const sign of [-1, 0, 1]) {
        const rib = new THREE.Mesh(ribGeom, hubMaterial);
        rib.position.set(sign * width * 0.34, -0.032, reach * 0.5);
        rib.castShadow = true;
        group.add(rib);
        bolts.push(
          ...rowPlacements({
            count: 3,
            from: new THREE.Vector3(sign * width * 0.34, 0.009, reach * 0.16),
            to: new THREE.Vector3(sign * width * 0.34, 0.009, reach * 0.88),
            normal: new THREE.Vector3(0, 1, 0),
          }),
        );
      }
      const cluster = boltCluster(
        registry,
        flushBoltGeometry(registry, 0.008),
        boltMaterial,
        bolts,
      );
      if (cluster) group.add(cluster);
      break;
    }

    case 'hammer': {
      const shaft = new THREE.Mesh(
        registry.geometry(new THREE.BoxGeometry(0.05, 0.05, reach)),
        hubMaterial,
      );
      shaft.position.z = reach / 2;
      shaft.castShadow = true;
      group.add(shaft);

      const head = new THREE.Mesh(
        registry.geometry(new THREE.BoxGeometry(0.13, 0.1, 0.15)),
        material,
      );
      head.position.z = reach;
      head.castShadow = true;
      group.add(head);

      // The beak that actually punches through top armour.
      const beak = new THREE.Mesh(
        registry.geometry(new THREE.ConeGeometry(0.042, 0.13, 4)),
        material,
      );
      beak.position.set(0, -0.1, reach + 0.01);
      beak.rotation.x = Math.PI;
      beak.rotation.y = Math.PI / 4;
      beak.castShadow = true;
      group.add(beak);

      const cluster = boltCluster(
        registry,
        hexBoltGeometry(registry, 0.009),
        boltMaterial,
        ringPlacements({ count: 4, radius: 0.045, axis: 'z', offset: reach - 0.076, facing: -1 }),
      );
      if (cluster) group.add(cluster);
      break;
    }

    case 'crusher': {
      const upper = new THREE.Mesh(
        registry.geometry(new THREE.BoxGeometry(0.085, 0.062, reach)),
        hubMaterial,
      );
      upper.position.z = reach / 2;
      upper.castShadow = true;
      group.add(upper);

      const tooth = new THREE.Mesh(
        registry.geometry(new THREE.ConeGeometry(0.046, 0.16, 5)),
        material,
      );
      tooth.position.set(0, -0.1, reach * 0.92);
      tooth.rotation.x = Math.PI;
      tooth.castShadow = true;
      group.add(tooth);

      // The ram that drives it, running back along the arm.
      const ram = new THREE.Mesh(
        registry.geometry(new THREE.CylinderGeometry(0.028, 0.028, reach * 0.5, 12)),
        material,
      );
      ram.rotation.x = Math.PI / 2;
      ram.position.set(0, 0.055, reach * 0.3);
      group.add(ram);
      break;
    }

    default: {
      const wedge = new THREE.Mesh(
        chamferedPlate(registry, { width, height: reach, thickness: 0.018 }),
        material,
      );
      wedge.rotation.x = -Math.PI / 2;
      wedge.position.z = reach / 2;
      group.add(wedge);
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// Wedge
// ---------------------------------------------------------------------------

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
 * Built from explicit vertices rather than an extruded shape. An extrusion has
 * to be rotated and translated into place afterwards, and getting either wrong
 * produces a slab lying across the floor at an angle rather than a ramp bolted
 * to the nose — which is exactly what happened. These six points are
 * unambiguous, and `wedgeHullPoints` in bot.ts builds the collider from the
 * same description.
 */
function rampGeometry(
  registry: GeometryRegistry,
  options: { xMin: number; xMax: number; rise: number; depth: number },
): THREE.BufferGeometry {
  const { xMin, xMax, rise, depth } = options;

  const tipL = [xMin, 0, depth];
  const tipR = [xMax, 0, depth];
  const backBottomL = [xMin, 0, 0];
  const backBottomR = [xMax, 0, 0];
  const backTopL = [xMin, rise, 0];
  const backTopR = [xMax, rise, 0];

  const tri = (a: number[], b: number[], c: number[]) => [...a, ...b, ...c];
  const positions = new Float32Array([
    ...tri(tipL, tipR, backTopR),
    ...tri(tipL, backTopR, backTopL),
    ...tri(tipL, backBottomL, backBottomR),
    ...tri(tipL, backBottomR, tipR),
    ...tri(backBottomL, backTopL, backTopR),
    ...tri(backBottomL, backTopR, backBottomR),
    ...tri(tipL, backTopL, backBottomL),
    ...tri(tipR, backBottomR, backTopR),
  ]);

  const geometry = registry.geometry(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  applyPlanarUV(geometry, 'x', 'z');
  return geometry;
}

/**
 * The front wedge.
 *
 * A wedge *weapon* is one solid plate running the full width. The forks
 * accessory is three separate ground-scraping prongs — which is what the real
 * thing is, and which stops the nose of every bot in the game looking like a
 * featureless white sheet. Both are subsets of the same convex envelope, so the
 * single hull collider in bot.ts remains an honest description of either.
 */
function buildWedge(
  registry: GeometryRegistry,
  stats: DerivedStats,
  material: THREE.Material,
  boltMaterial: THREE.Material,
  style: 'solid' | 'forks',
): THREE.Group {
  const { hw, rise, depth } = wedgeDimensions(stats.parts.chassis);
  const group = new THREE.Group();

  const spans: [number, number][] =
    style === 'solid'
      ? [[-hw, hw]]
      : [
          [-hw, -hw * 0.46],
          [-hw * 0.2, hw * 0.2],
          [hw * 0.46, hw],
        ];

  for (const [xMin, xMax] of spans) {
    const ramp = new THREE.Mesh(rampGeometry(registry, { xMin, xMax, rise, depth }), material);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    group.add(ramp);
  }

  // A crossbar tying the prongs together at the back, where they bolt to the frame.
  const crossbar = new THREE.Mesh(
    registry.geometry(new THREE.BoxGeometry(hw * 2, rise * 0.42, 0.022)),
    material,
  );
  crossbar.position.set(0, rise * 0.24, 0.012);
  crossbar.castShadow = true;
  group.add(crossbar);

  // Hardened tips on the leading edge of each prong.
  const tipGeom = registry.geometry(new THREE.BoxGeometry(1, 0.007, depth * 0.34));
  for (const [xMin, xMax] of spans) {
    const tip = new THREE.Mesh(tipGeom, material);
    tip.scale.x = (xMax - xMin) * 0.92;
    tip.position.set((xMin + xMax) / 2, 0.0045, depth * 0.84);
    tip.castShadow = true;
    group.add(tip);
  }

  const cluster = boltCluster(
    registry,
    hexBoltGeometry(registry, 0.008),
    boltMaterial,
    rowPlacements({
      count: 5,
      from: new THREE.Vector3(-hw * 0.8, rise * 0.24, 0.025),
      to: new THREE.Vector3(hw * 0.8, rise * 0.24, 0.025),
      normal: new THREE.Vector3(0, 0, 1),
    }),
  );
  if (cluster) group.add(cluster);

  return group;
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export function buildBotVisual(design: BotDesign, stats: DerivedStats, team: 0 | 1): BotVisual {
  const { chassis, weapon, wheel, armor, weaponMaterial } = stats.parts;
  const registry = new GeometryRegistry();

  const root = new THREE.Group();
  root.name = `bot-${design.name}`;
  const body = new THREE.Group();
  root.add(body);

  const seed = team === 0 ? 5 : 11;
  const paintMat = liveryMaterial(registry, design, seed);
  const frameMat = rawMetalMaterial(registry, armor.colorHint, seed + 1, armor.roughness);
  const weaponMat = rawMetalMaterial(
    registry,
    weaponMaterial.colorHint,
    seed + 2,
    weaponMaterial.roughness,
  );
  const machinedMat = machinedMaterial(registry, seed + 3);
  const hardwareMat = hardwareMaterial(registry, seed + 4);

  const hw = chassis.width / 2;
  const hh = chassis.height / 2;
  const hl = chassis.length / 2;
  const plate = Math.max(0.006, design.armorThicknessMm / 1000);

  // --- Welded frame ------------------------------------------------------
  // Corner posts and perimeter rails, visible in the gaps between the armour.
  const railThickness = Math.min(0.03, chassis.height * 0.12);
  const postGeom = registry.geometry(
    new THREE.BoxGeometry(railThickness, chassis.height * 0.92, railThickness),
  );
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(postGeom, frameMat);
      post.position.set(sx * (hw - railThickness), 0, sz * (hl - railThickness));
      post.castShadow = true;
      body.add(post);
    }
  }

  const longRail = registry.geometry(
    new THREE.BoxGeometry(railThickness, railThickness, chassis.length * 0.94),
  );
  const crossRail = registry.geometry(
    new THREE.BoxGeometry(chassis.width * 0.94, railThickness, railThickness),
  );
  for (const sy of [-1, 1]) {
    for (const sx of [-1, 1]) {
      const rail = new THREE.Mesh(longRail, frameMat);
      rail.position.set(sx * (hw - railThickness), sy * (hh - railThickness), 0);
      rail.castShadow = true;
      body.add(rail);
    }
    for (const sz of [-1, 1]) {
      const rail = new THREE.Mesh(crossRail, frameMat);
      rail.position.set(0, sy * (hh - railThickness), sz * (hl - railThickness));
      rail.castShadow = true;
      body.add(rail);
    }
  }

  // The belly pan the batteries and motors sit on.
  const bellyPan = new THREE.Mesh(
    registry.geometry(
      new THREE.BoxGeometry(chassis.width * 0.86, 0.01, chassis.length * 0.86),
    ),
    machinedMat,
  );
  bellyPan.position.y = -hh + chassis.height * 0.16;
  body.add(bellyPan);

  // --- Internals ---------------------------------------------------------
  // Drive motors down each side, and a battery pack between them. These are only
  // glimpsed through the gaps, but they are why the machine has a belly at all.
  const canRadius = Math.min(0.038, chassis.height * 0.16);
  const canLength = Math.min(0.13, chassis.length * 0.2);
  const perSide = Math.max(1, Math.floor(chassis.wheelCount / 2));
  for (const sx of [-1, 1]) {
    for (let i = 0; i < perSide; i++) {
      const t = perSide === 1 ? 0.5 : i / (perSide - 1);
      const can = motorCan(registry, hardwareMat, { radius: canRadius, length: canLength });
      can.position.set(
        sx * (hw - canLength * 0.62),
        -hh + chassis.height * 0.3,
        -chassis.length * 0.3 + t * chassis.length * 0.6,
      );
      if (sx < 0) can.rotation.y = Math.PI;
      body.add(can);
    }
  }

  const battery = new THREE.Mesh(
    registry.geometry(
      new THREE.BoxGeometry(chassis.width * 0.34, chassis.height * 0.3, chassis.length * 0.3),
    ),
    hardwareMat,
  );
  battery.position.set(0, -hh + chassis.height * 0.34, -chassis.length * 0.12);
  body.add(battery);

  // --- Armour panels -----------------------------------------------------
  const armorPanels = new Map<ArmorFace, THREE.Mesh>();
  const boltGeom = hexBoltGeometry(registry, Math.max(0.006, plate * 0.55));

  interface PanelDef {
    face: ArmorFace;
    width: number;
    height: number;
    position: [number, number, number];
    rotation: [number, number, number];
    normal: THREE.Vector3;
    /**
     * Intervals along the panel's own local X to leave open, as [centre, half].
     * Used to cut the wheel arches out of the side armour.
     */
    cutouts?: [number, number][];
  }

  /*
   * Where the wheels sit along the machine, in chassis Z — the same arithmetic
   * the drivetrain uses in `Bot`, because the arches have to line up with the
   * actual hard points and not with a guess.
   */
  const wheelRows = chassis.wheelCount / 2;
  const usableLength = chassis.length / 2 - wheel.radius - 0.03;
  const wheelZ: number[] = [];
  for (let row = 0; row < wheelRows; row++) {
    wheelZ.push(
      wheelRows === 1 ? 0 : -usableLength + (2 * usableLength * row) / (wheelRows - 1),
    );
  }
  // The side panel's local X runs along chassis Z, and the ±90 degree turn about
  // Y reverses it — which does not matter here, because the arches are symmetric.
  const wheelArches: [number, number][] = wheelZ.map((z) => [z, wheel.radius + 0.012]);

  /*
   * The weapon slot.
   *
   * A vertical rotor is hung at the nose and rises above the deck, so its envelope
   * genuinely passes through the front plate and the top deck — measured, 76 cm3
   * of solid disc inside the front plate and 29 cm3 inside the top one. Real
   * machines cut a slot for it. Both plates run their local X along chassis X, so
   * one opening centred on the machine's centreline serves both.
   */
  const mount = chassis.weaponMount;
  const rotorHalfWidth = weapon.rotor
    ? (weapon.rotor.shape === 'disc' ? weapon.rotor.thickness : weapon.rotor.span) / 2 + 0.014
    : 0;
  const verticalRotor = weapon.rotor?.axis === 'x';
  const rotorReach = weapon.rotor?.radius ?? 0;
  const frontSlot: [number, number][] =
    verticalRotor && mount.z + rotorReach > hl ? [[0, rotorHalfWidth]] : [];
  const topSlot: [number, number][] =
    verticalRotor && mount.y + rotorReach > hh ? [[0, rotorHalfWidth]] : [];

  // Panels are inset so the frame rails and corner posts stay visible around
  // them. That gap is the whole difference between "a painted box" and "plate
  // bolted into a welded frame".
  const inset = railThickness * 2.1;
  const panelDefs: PanelDef[] = [
    {
      face: 'front',
      width: chassis.width - inset,
      height: chassis.height - inset,
      position: [0, 0, hl + plate / 2],
      rotation: [0, 0, 0],
      normal: new THREE.Vector3(0, 0, 1),
      cutouts: frontSlot,
    },
    {
      face: 'rear',
      width: chassis.width - inset,
      height: chassis.height - inset,
      position: [0, 0, -hl - plate / 2],
      rotation: [0, Math.PI, 0],
      normal: new THREE.Vector3(0, 0, -1),
    },
    {
      face: 'left',
      width: chassis.length - inset,
      height: chassis.height - inset,
      position: [-hw - plate / 2, 0, 0],
      rotation: [0, -Math.PI / 2, 0],
      normal: new THREE.Vector3(-1, 0, 0),
      cutouts: wheelArches,
    },
    {
      face: 'right',
      width: chassis.length - inset,
      height: chassis.height - inset,
      position: [hw + plate / 2, 0, 0],
      rotation: [0, Math.PI / 2, 0],
      normal: new THREE.Vector3(1, 0, 0),
      cutouts: wheelArches,
    },
    {
      face: 'top',
      width: chassis.width - inset,
      height: chassis.length - inset,
      position: [0, hh + plate / 2, 0],
      rotation: [-Math.PI / 2, 0, 0],
      normal: new THREE.Vector3(0, 1, 0),
      cutouts: topSlot,
    },
    {
      face: 'bottom',
      width: chassis.width - inset,
      height: chassis.length - inset,
      position: [0, -hh - plate / 2, 0],
      rotation: [Math.PI / 2, 0, 0],
      normal: new THREE.Vector3(0, -1, 0),
    },
  ];

  for (const def of panelDefs) {
    // A panel is its own group so its fasteners come off with it when it is torn
    // away — armour and the bolts holding it are one part, physically.
    const panel = new THREE.Mesh(
      panelGeometry(registry, def.width, def.height, plate, def.cutouts),
      registry.material(paintMat.clone()),
    );
    panel.position.set(...def.position);
    panel.rotation.set(...def.rotation);
    panel.castShadow = true;
    panel.receiveShadow = true;
    panel.name = `armor-${def.face}`;

    /*
     * Fasteners around the perimeter of each surviving *segment*.
     *
     * Derived from the panel's uncut outline, the rows ran straight across the
     * openings: sixteen bolts per machine floated in the wheel arches, and two of
     * them sat inside the solid of a tyre. Bolting each segment to its own edges
     * is also what a fabricator would do — every piece of plate needs its own
     * fixings.
     */
    const edge = Math.max(0.022, plate * 1.6);
    const insetY = def.height / 2 - edge;
    const boltNormal = new THREE.Vector3(0, 0, 1);
    const perimeter: BoltPlacement[] = [];
    for (const [from, to] of panelSpans(def.width, plate, def.cutouts)) {
      const left = from + edge;
      const right = to - edge;
      if (right <= left) continue;
      const across = Math.max(2, Math.min(4, Math.round((to - from) / 0.12)));
      perimeter.push(
        ...rowPlacements({
          count: across,
          from: new THREE.Vector3(left, insetY, plate / 2),
          to: new THREE.Vector3(right, insetY, plate / 2),
          normal: boltNormal,
        }),
        ...rowPlacements({
          count: across,
          from: new THREE.Vector3(left, -insetY, plate / 2),
          to: new THREE.Vector3(right, -insetY, plate / 2),
          normal: boltNormal,
        }),
        ...rowPlacements({
          count: 2,
          from: new THREE.Vector3(left, -insetY * 0.4, plate / 2),
          to: new THREE.Vector3(left, insetY * 0.4, plate / 2),
          normal: boltNormal,
        }),
        ...rowPlacements({
          count: 2,
          from: new THREE.Vector3(right, -insetY * 0.4, plate / 2),
          to: new THREE.Vector3(right, insetY * 0.4, plate / 2),
          normal: boltNormal,
        }),
      );
    }
    const cluster = boltCluster(registry, boltGeom, hardwareMat, perimeter);
    if (cluster) panel.add(cluster);

    body.add(panel);
    armorPanels.set(def.face, panel);
  }

  // --- Wedge, wedgelets, skirts -----------------------------------------
  if (weapon.kind === 'wedge' || stats.parts.accessories.includes('forks')) {
    const isWeaponWedge = weapon.kind === 'wedge';
    const wedge = buildWedge(
      registry,
      stats,
      isWeaponWedge ? paintMat : frameMat,
      hardwareMat,
      isWeaponWedge ? 'solid' : 'forks',
    );
    wedge.position.set(0, -hh, hl - 0.01);
    body.add(wedge);
  }

  if (stats.parts.accessories.includes('wedgelets')) {
    const geom = chamferedPlate(registry, {
      width: chassis.width * 0.26,
      height: 0.14,
      thickness: 0.012,
    });
    for (const sign of [-1, 1]) {
      const wedgelet = new THREE.Mesh(geom, machinedMat);
      wedgelet.position.set(sign * chassis.width * 0.3, -hh + 0.006, hl + 0.07);
      wedgelet.rotation.set(-Math.PI / 2 - 0.09, 0, 0);
      wedgelet.castShadow = true;
      body.add(wedgelet);
    }
  }

  if (stats.parts.accessories.includes('skirts')) {
    /*
     * Sized from the actual ride height rather than from a fraction of the frame.
     * A skirt is a strip that hangs down to the floor to stop a wedge getting
     * under you; sized at 40% of the chassis height it hung 79 mm *below* the
     * floor the wheels were standing on, on every frame in the catalogue.
     */
    const skirtHeight = chassis.groundClearance + 0.012;
    const geom = chamferedPlate(registry, {
      width: chassis.length * 0.9,
      height: skirtHeight,
      thickness: 0.008,
    });
    for (const sign of [-1, 1]) {
      const skirt = new THREE.Mesh(geom, machinedMat);
      // Bottom edge lands on the floor line: -(height/2 + groundClearance).
      skirt.position.set(sign * (hw + plate + 0.006), -hh - chassis.groundClearance + skirtHeight / 2 - 0.006, 0);
      skirt.rotation.y = (sign * Math.PI) / 2;
      skirt.castShadow = true;
      body.add(skirt);
    }
  }

  // --- Wheels ------------------------------------------------------------
  const tyre = makeTyreTexture();
  const tyreMat = registry.material(
    new THREE.MeshStandardMaterial({
      map: tyre.map,
      normalMap: tyre.normalMap,
      roughnessMap: tyre.roughnessMap,
      color: 0x2a2d31,
      metalness: 0.05,
      roughness: 0.85,
    }),
  );

  const tyreGeom = registry.geometry(
    new THREE.CylinderGeometry(wheel.radius, wheel.radius, wheel.width, 26, 1),
  );
  const rimGeom = registry.geometry(
    new THREE.CylinderGeometry(wheel.radius * 0.64, wheel.radius * 0.64, wheel.width * 1.04, 20),
  );
  const hubGeom = registry.geometry(
    new THREE.CylinderGeometry(wheel.radius * 0.22, wheel.radius * 0.22, wheel.width * 1.3, 12),
  );
  const spokeGeom = registry.geometry(
    new THREE.BoxGeometry(wheel.width * 0.55, wheel.radius * 0.44, wheel.radius * 0.16),
  );
  const sprocket = sprocketGeometry(registry, {
    radius: wheel.radius * 0.42,
    teeth: 14,
    thickness: wheel.width * 0.16,
  });
  const wheelBoltGeom = flushBoltGeometry(registry, wheel.radius * 0.05);

  const wheels: THREE.Object3D[] = [];
  for (let i = 0; i < chassis.wheelCount; i++) {
    const group = new THREE.Group();
    /*
     * Which way this corner faces. One wheel was built and reused for both sides,
     * so the drive sprocket sat inboard on the right-hand wheels and *outboard* of
     * the tyre on the left-hand ones — a chain run to the outside face of a wheel,
     * on every machine in the game. The hub bolts were mirrored the same way,
     * hidden behind the tyre on one side.
     */
    const outboard = i % 2 === 0 ? -1 : 1;

    const tyreMesh = new THREE.Mesh(tyreGeom, tyreMat);
    tyreMesh.rotation.z = Math.PI / 2;
    tyreMesh.castShadow = true;
    group.add(tyreMesh);

    const rim = new THREE.Mesh(rimGeom, machinedMat);
    rim.rotation.z = Math.PI / 2;
    group.add(rim);

    const hub = new THREE.Mesh(hubGeom, machinedMat);
    hub.rotation.z = Math.PI / 2;
    group.add(hub);

    // Spokes between hub and rim, so the wheel is not a solid puck.
    for (let s = 0; s < 5; s++) {
      const a = (s / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(spokeGeom, machinedMat);
      spoke.position.set(0, Math.cos(a) * wheel.radius * 0.42, Math.sin(a) * wheel.radius * 0.42);
      spoke.rotation.x = a;
      group.add(spoke);
    }

    // Drive sprocket on the inboard face.
    const sprocketMesh = new THREE.Mesh(sprocket, hardwareMat);
    sprocketMesh.position.x = -outboard * wheel.width * 0.62;
    group.add(sprocketMesh);

    const cluster = boltCluster(
      registry,
      wheelBoltGeom,
      hardwareMat,
      ringPlacements({
        count: 5,
        radius: wheel.radius * 0.34,
        axis: 'x',
        offset: outboard * wheel.width * 0.54,
        facing: outboard as 1 | -1,
      }),
    );
    if (cluster) group.add(cluster);

    root.add(group);
    wheels.push(group);
  }

  // --- Weapon ------------------------------------------------------------
  let weaponGroup: THREE.Group | null = null;
  let weaponPivot: THREE.Group | null = null;

  if (weapon.rotor) {
    weaponPivot = new THREE.Group();
    weaponGroup = buildRotor(registry, stats, weaponMat, machinedMat, hardwareMat);
    weaponPivot.add(weaponGroup);
    root.add(weaponPivot);

    const axis = weapon.rotor.axis;

    if (axis === 'x') {
      /*
       * A vertical weapon hangs between two uprights at the nose, with the motor
       * and belt outboard on one side — exactly where you can see them.
       */
      const standoff = chassis.width * 0.42;

      /*
       * The post has to stand under the bearing it carries.
       *
       * The uprights sat at 70% of the mount's z, inside the shell, while the
       * pillow blocks were out at the mount — a 73 mm gap in Z between each block
       * and the post that is supposed to hold it, with the block hanging in mid
       * air. There was also no shaft at all: a 212 mm run of nothing between the
       * rotor hub and the bearing bore. Put the post under the block, brace it
       * back to the frame, and run a real shaft through both.
       */
      const uprightHeight = mount.y + chassis.height * 0.5;
      const stayLength = Math.max(0.04, Math.abs(mount.z) - chassis.length * 0.32);
      for (const sign of [-1, 1]) {
        const upright = new THREE.Mesh(
          registry.geometry(new THREE.BoxGeometry(0.032, uprightHeight, 0.055)),
          frameMat,
        );
        upright.position.set(sign * standoff, mount.y - uprightHeight / 2, mount.z);
        upright.castShadow = true;
        body.add(upright);

        // Diagonal stay back into the frame, so the post is not a cantilever.
        const stay = new THREE.Mesh(
          registry.geometry(new THREE.BoxGeometry(0.028, 0.028, stayLength)),
          frameMat,
        );
        stay.position.set(
          sign * standoff,
          mount.y - uprightHeight * 0.75,
          mount.z - Math.sign(mount.z || 1) * stayLength * 0.5,
        );
        body.add(stay);

        const block = pillowBlock(registry, machinedMat, { bore: 0.017, width: 0.05 });
        block.position.set(sign * standoff, mount.y, mount.z);
        body.add(block);
      }

      // The shaft the rotor is keyed to, running out through both bearings.
      const shaft = new THREE.Mesh(
        registry.geometry(
          new THREE.CylinderGeometry(0.016, 0.016, standoff * 2 + 0.06, 14),
        ),
        machinedMat,
      );
      shaft.rotation.z = Math.PI / 2;
      shaft.position.set(0, mount.y, mount.z);
      shaft.castShadow = true;
      body.add(shaft);

      const rotorPulleyRadius = Math.max(0.03, weapon.rotor.radius * 0.2);
      const motorPulleyRadius = rotorPulleyRadius * 0.5;
      const beltSpan = 0.24;

      const beltGroup = new THREE.Group();
      // Outboard of the side plate, not through it: the drive used to straddle the
      // armour, with the belt and motor pulley half inside the panel.
      beltGroup.position.set(Math.max(standoff + 0.05, hw + plate + 0.03), mount.y, mount.z);
      // Turn the band so it is extruded along the rotor's spin axis.
      beltGroup.rotation.y = Math.PI / 2;

      const belt = beltBand(registry, hardwareMat, {
        centerA: new THREE.Vector2(0, 0),
        radiusA: rotorPulleyRadius,
        centerB: new THREE.Vector2(beltSpan, -0.07),
        radiusB: motorPulleyRadius,
        width: 0.022,
        thickness: 0.005,
      });
      if (belt) beltGroup.add(belt);

      const drivePulley = pulley(registry, machinedMat, {
        radius: rotorPulleyRadius,
        width: 0.026,
      });
      drivePulley.rotation.y = Math.PI / 2;
      beltGroup.add(drivePulley);

      const motorPulley = pulley(registry, machinedMat, {
        radius: motorPulleyRadius,
        width: 0.024,
      });
      motorPulley.rotation.y = Math.PI / 2;
      // The band's small wrap is built at local +x (`centerB`), and the motor can
      // is hung on that side too; negating this put the pulley out on its own at
      // the far end of the belt, with the belt visibly wrapping empty air.
      motorPulley.position.set(beltSpan, -0.07, 0);
      beltGroup.add(motorPulley);
      body.add(beltGroup);

      const weaponMotor = motorCan(registry, hardwareMat, { radius: 0.042, length: 0.15 });
      weaponMotor.position.set(standoff * 0.55, mount.y - 0.07, mount.z - beltSpan);
      body.add(weaponMotor);
    } else {
      /*
       * A full-body horizontal weapon rides on a single central turret, and its
       * motor lives down inside the shell. Hanging the same two-upright rig off
       * this one piles hardware on top of the machine and hides the bar, which is
       * the one part of a horizontal spinner anybody wants to see.
       */
      const turret = new THREE.Mesh(
        registry.geometry(
          new THREE.CylinderGeometry(0.05, 0.075, Math.max(0.04, mount.y - hh + 0.06), 16),
        ),
        machinedMat,
      );
      turret.position.set(mount.x, (hh + mount.y) / 2, mount.z);
      turret.castShadow = true;
      body.add(turret);

      const collar = new THREE.Mesh(
        registry.geometry(new THREE.CylinderGeometry(0.058, 0.058, 0.022, 18)),
        hardwareMat,
      );
      collar.position.set(mount.x, mount.y - 0.02, mount.z);
      body.add(collar);

      const turretBolts = boltCluster(
        registry,
        hexBoltGeometry(registry, 0.008),
        hardwareMat,
        ringPlacements({
          count: 8,
          radius: 0.062,
          axis: 'y',
          offset: hh + plate + 0.004,
          facing: 1,
        }),
      );
      if (turretBolts) body.add(turretBolts);

      // The weapon motor stands on end inside the shell, driving up to the turret.
      const weaponMotor = motorCan(registry, hardwareMat, { radius: 0.04, length: 0.14 });
      weaponMotor.rotation.z = Math.PI / 2;
      weaponMotor.position.set(mount.x, -hh + chassis.height * 0.45, mount.z - chassis.length * 0.2);
      body.add(weaponMotor);
    }

  } else if (weapon.actuator || weapon.clamp) {
    weaponPivot = new THREE.Group();
    weaponGroup = buildArm(registry, stats, weaponMat, machinedMat, hardwareMat);
    weaponPivot.add(weaponGroup);
    root.add(weaponPivot);

    // Gas bottle and ram for a pneumatic weapon.
    const bottle = new THREE.Mesh(
      registry.geometry(new THREE.CylinderGeometry(0.045, 0.045, chassis.length * 0.4, 16)),
      hardwareMat,
    );
    bottle.rotation.x = Math.PI / 2;
    bottle.position.set(chassis.width * 0.22, -hh + chassis.height * 0.42, -chassis.length * 0.18);
    body.add(bottle);
  }

  // --- Lights ------------------------------------------------------------
  const underglow = new THREE.PointLight(design.paint.glow, 0, 1.6, 2);
  underglow.position.set(0, -hh - 0.05, 0);
  body.add(underglow);

  // Every bot in the box carries a lit team indicator. It is a rule, and it is
  // also the only way the audience tells two dark machines apart.
  const teamColor = team === 0 ? 0xff2b2b : 0x2b6bff;
  const teamLight = new THREE.Mesh(
    registry.geometry(new THREE.SphereGeometry(0.032, 12, 10)),
    registry.material(
      new THREE.MeshStandardMaterial({
        color: teamColor,
        emissive: teamColor,
        emissiveIntensity: 3.4,
        roughness: 0.3,
      }),
    ),
  );
  teamLight.position.set(0, hh + plate + 0.03, -hl * 0.55);
  body.add(teamLight);

  // A stalk so the indicator reads as fitted equipment rather than a floating dot.
  const stalk = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(0.006, 0.008, 0.04, 8)),
    hardwareMat,
  );
  stalk.position.set(0, hh + plate + 0.005, -hl * 0.55);
  body.add(stalk);

  return {
    root,
    body,
    armorPanels,
    wheels,
    weapon: weaponGroup,
    weaponPivot,
    underglow,
    teamLight,
    dispose: () => registry.dispose(),
  };
}

/**
 * A plate with the wheel arches cut out of it.
 *
 * Side armour was a solid slab running the whole length of the machine, and the
 * tyres are a centimetre or two proud of the frame — so every wheel was buried
 * halfway into its own armour, which no machine that has ever rolled out of a
 * pit does. Real side plate is either cut around the wheels or stops short of
 * them; this builds it as the segments that survive once the arches are removed,
 * merged into one geometry so the panel stays a single part that comes off as a
 * single part. Segments too narrow to be worth bolting on are dropped, which is
 * also the right answer for a six-wheel frame with no room between the rows.
 */
export function panelSpans(
  width: number,
  thickness: number,
  cutouts?: [number, number][],
): [number, number][] {
  const half = width / 2;
  if (!cutouts || cutouts.length === 0) return [[-half, half]];

  // Walk the panel from one edge to the other, skipping every opening.
  const openings = [...cutouts].sort((a, b) => a[0] - b[0]);
  const spans: [number, number][] = [];
  let cursor = -half;
  for (const [centre, radius] of openings) {
    const from = centre - radius;
    const to = centre + radius;
    if (from > cursor) spans.push([cursor, Math.min(from, half)]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < half) spans.push([cursor, half]);

  const minimum = Math.max(0.03, thickness * 4);
  const kept = spans.filter(([from, to]) => to - from >= minimum);
  // A frame whose openings leave nothing worth plating still needs *a* panel.
  return kept.length > 0 ? kept : [[-half, half]];
}

export function panelGeometry(
  registry: GeometryRegistry,
  width: number,
  height: number,
  thickness: number,
  cutouts?: [number, number][],
): THREE.BufferGeometry {
  const plain = (w: number): THREE.BufferGeometry =>
    chamferedPlate(registry, { width: w, height, thickness });
  if (!cutouts || cutouts.length === 0) return plain(width);

  const spans = panelSpans(width, thickness, cutouts);
  const pieces: THREE.BufferGeometry[] = [];
  for (const [from, to] of spans) {
    const piece = plain(to - from).clone();
    piece.translate((from + to) / 2, 0, 0);
    pieces.push(piece);
  }

  /*
   * Register what is actually handed back, and free the intermediates.
   *
   * `plain()` returns a registered plate, but the clone of it and the merged
   * result are new objects the registry has never seen — so teardown freed the
   * originals, which were never rendered, and left every side panel in the game
   * resident on the GPU for the lifetime of the page.
   */
  if (pieces.length === 1) return registry.geometry(pieces[0]!);
  const merged = mergeGeometries(pieces);
  for (const piece of pieces) piece.dispose();
  return registry.geometry(merged);
}
