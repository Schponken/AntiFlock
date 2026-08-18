/**
 * Robot geometry, built from the same design the physics reads.
 *
 * The hull mesh uses the identical wedge vertices the collider is built from,
 * so what you see really is what you hit. Wheels, weapons and lights are hung
 * off the same local frame the simulation uses for its mount points.
 */

import * as THREE from 'three';
import { clamp01 } from '../core/math';
import type { Bot } from '../sim/bot';
import { wedgeHullPoints } from '../sim/bot';
import type { BotDesign, BotStats } from '../sim/parts';
import { hullTexture, metalTexture, tyreTexture } from './textures';

export interface BotView {
  root: THREE.Group;
  hull: THREE.Mesh;
  wheels: THREE.Mesh[];
  weapon: THREE.Group | null;
  /** The team light on top, red or blue. */
  teamLight: THREE.Mesh;
  /** Both hull materials — the plain faces and the named flanks. */
  hullMaterials: THREE.MeshStandardMaterial[];
  /** Set as armour is destroyed, to darken and scuff the hull. */
  damageLevel: number;
}

/**
 * Build the hull as a closed mesh from the eight wedge points. Three's
 * ConvexGeometry lives in the examples bundle, so the six faces are assembled
 * by hand from the known point ordering — which also keeps the UVs sensible for
 * the livery.
 */
function buildHullGeometry(stats: BotStats, hullCenterY: number): THREE.BufferGeometry {
  const c = stats.chassis;
  const pts = wedgeHullPoints(c.length, c.width, c.height, c.wedge, hullCenterY);
  const p = (i: number): [number, number, number] => [pts[i * 3]!, pts[i * 3 + 1]!, pts[i * 3 + 2]!];

  // Point order from wedgeHullPoints:
  // 0 rear-bottom-right, 1 rear-bottom-left, 2 rear-top-right, 3 rear-top-left,
  // 4 front-bottom-right, 5 front-bottom-left, 6 front-nose-right, 7 front-nose-left
  const quads: [number, number, number, number][] = [
    [1, 0, 2, 3], // rear
    [4, 5, 7, 6], // nose
    [0, 4, 6, 2], // right flank
    [5, 1, 3, 7], // left flank
    [3, 2, 6, 7], // top (slopes down to the nose)
    [0, 1, 5, 4], // belly
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  // Two draw groups: the flanks carry the robot's name, everything else uses
  // the plain livery. Stencilling the name onto all six faces looks like a
  // mistake, and on the belly nobody would ever see it anyway.
  const FLANK_QUADS = new Set([2, 3]);
  const groups: { start: number; count: number; material: number }[] = [];

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const cc = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let quadIndex = 0; quadIndex < quads.length; quadIndex++) {
    const [i0, i1, i2, i3] = quads[quadIndex]!;
    groups.push({
      start: quadIndex * 6,
      count: 6,
      material: FLANK_QUADS.has(quadIndex) ? 1 : 0,
    });
    const v0 = p(i0);
    const v1 = p(i1);
    const v2 = p(i2);
    const v3 = p(i3);

    for (const [x, y, z] of [v0, v1, v2, v0, v2, v3]) positions.push(x, y, z);

    a.fromArray(v0);
    b.fromArray(v1);
    cc.fromArray(v2);
    ab.subVectors(b, a);
    ac.subVectors(cc, a);
    normal.crossVectors(ab, ac).normalize();
    for (let k = 0; k < 6; k++) normals.push(normal.x, normal.y, normal.z);

    // Simple planar UVs per face — enough for the livery and the name decal.
    uvs.push(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  for (const group of groups) geometry.addGroup(group.start, group.count, group.material);
  geometry.computeBoundingSphere();
  return geometry;
}

/** How plastic-looking the armour material is, 0..1. */
function plasticness(stats: BotStats): number {
  return stats.armor.metalness < 0.3 ? 1 : 0;
}

export function buildBotView(bot: Bot, design: BotDesign): BotView {
  const stats = bot.stats;
  const root = new THREE.Group();
  root.name = `bot-${bot.id}`;

  // --- Hull ------------------------------------------------------------------
  const liveryBase = {
    primary: design.primaryColor,
    secondary: design.secondaryColor,
    accent: design.accentColor,
    livery: design.livery,
    materialTint: stats.armor.tint,
    plastic: plasticness(stats),
  };
  const surface = {
    metalness: stats.armor.metalness * 0.8,
    roughness: stats.armor.roughness,
    envMapIntensity: 1.1,
  };

  const plainMaterial = new THREE.MeshStandardMaterial({
    map: hullTexture({ ...liveryBase, name: '' }),
    ...surface,
  });
  const hullMaterial = new THREE.MeshStandardMaterial({
    map: hullTexture({ ...liveryBase, name: design.name }),
    ...surface,
  });

  const hull = new THREE.Mesh(buildHullGeometry(stats, bot.hullCenterY), [
    plainMaterial,
    hullMaterial,
  ]);
  hull.castShadow = true;
  hull.receiveShadow = true;
  root.add(hull);

  // A thin skirt along the nose, so a wedge reads as a wedge.
  if (stats.chassis.wedge > 0.4) {
    const skirtMat = new THREE.MeshStandardMaterial({
      map: metalTexture(0x9aa1a9),
      metalness: 1,
      roughness: 0.35,
    });
    const skirt = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.008, stats.chassis.width * 0.94),
      skirtMat,
    );
    skirt.position.set(
      stats.chassis.length / 2 + 0.04,
      bot.hullCenterY - stats.chassis.height / 2,
      0,
    );
    root.add(skirt);
  }

  // --- Wheels ----------------------------------------------------------------
  const tyreMat = new THREE.MeshStandardMaterial({
    map: tyreTexture(stats.wheel.tint),
    roughness: 0.88,
    metalness: 0.05,
  });
  const hubMat = new THREE.MeshStandardMaterial({
    map: metalTexture(0x7d848c),
    roughness: 0.4,
    metalness: 0.95,
  });

  const wheels: THREE.Mesh[] = [];
  for (const wheel of bot.wheels) {
    const group = new THREE.Group();
    group.position.set(wheel.local.x, wheel.local.y, wheel.local.z);

    const tyre = new THREE.Mesh(
      new THREE.CylinderGeometry(wheel.radius, wheel.radius, 0.09, 24),
      tyreMat,
    );
    tyre.rotation.x = Math.PI / 2;
    tyre.castShadow = true;
    group.add(tyre);

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(wheel.radius * 0.45, wheel.radius * 0.45, 0.082, 12),
      hubMat,
    );
    hub.rotation.x = Math.PI / 2;
    group.add(hub);

    root.add(group);
    // The tyre is what spins; the group holds the position.
    wheels.push(tyre);
  }

  // --- Weapon ----------------------------------------------------------------
  const weapon = buildWeaponMesh(bot, design);

  // --- Team light ------------------------------------------------------------
  const teamColour = bot.side === 'a' ? 0xff2a1a : 0x2a7cff;
  const teamLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.05, 12, 8),
    new THREE.MeshStandardMaterial({
      color: teamColour,
      emissive: teamColour,
      emissiveIntensity: 3.5,
      toneMapped: false,
    }),
  );
  teamLight.position.set(
    -stats.chassis.length * 0.34,
    bot.hullCenterY + stats.chassis.height / 2 + 0.03,
    0,
  );
  root.add(teamLight);

  return {
    root,
    hull,
    wheels,
    weapon,
    teamLight,
    hullMaterials: [plainMaterial, hullMaterial],
    damageLevel: 0,
  };
}

/**
 * The weapon lives in its own group because it is a separate rigid body — the
 * renderer drives it from that body's world transform, not from the chassis.
 */
function buildWeaponMesh(bot: Bot, design: BotDesign): THREE.Group | null {
  const w = bot.stats.weapon;
  if (w.kind === 'none') return null;

  const group = new THREE.Group();
  group.name = `weapon-${bot.id}`;

  const steel = new THREE.MeshStandardMaterial({
    map: metalTexture(0xa8aeb6),
    roughness: 0.28,
    metalness: 1.0,
    envMapIntensity: 1.4,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: design.accentColor,
    emissive: design.accentColor,
    emissiveIntensity: 0.35,
    roughness: 0.35,
    metalness: 0.7,
  });

  switch (w.kind) {
    case 'horizontal-spinner': {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, w.radiusM * 2), steel);
      bar.castShadow = true;
      group.add(bar);
      // Teeth at each end.
      for (const sign of [-1, 1]) {
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.16), accent);
        tooth.position.set(0.03, 0, sign * (w.radiusM - 0.07));
        tooth.castShadow = true;
        group.add(tooth);
      }
      break;
    }
    case 'vertical-spinner': {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(w.radiusM, w.radiusM, 0.07, 32),
        steel,
      );
      disc.rotation.x = Math.PI / 2;
      disc.castShadow = true;
      group.add(disc);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.09), accent);
        tooth.position.set(Math.cos(a) * w.radiusM, Math.sin(a) * w.radiusM, 0);
        tooth.rotation.z = a;
        group.add(tooth);
      }
      break;
    }
    case 'drum': {
      const drum = new THREE.Mesh(
        new THREE.CylinderGeometry(w.radiusM, w.radiusM, bot.stats.chassis.width * 0.72, 20),
        steel,
      );
      drum.rotation.x = Math.PI / 2;
      drum.castShadow = true;
      group.add(drum);
      for (let i = 0; i < 2; i++) {
        const a = i * Math.PI;
        const tooth = new THREE.Mesh(
          new THREE.BoxGeometry(0.09, 0.07, bot.stats.chassis.width * 0.74),
          accent,
        );
        tooth.position.set(Math.cos(a) * w.radiusM, Math.sin(a) * w.radiusM, 0);
        tooth.rotation.z = a;
        group.add(tooth);
      }
      break;
    }
    case 'saw': {
      const blade = new THREE.Mesh(
        new THREE.CylinderGeometry(w.radiusM, w.radiusM, 0.02, 28),
        steel,
      );
      blade.rotation.x = Math.PI / 2;
      group.add(blade);
      const rim = new THREE.Mesh(new THREE.TorusGeometry(w.radiusM * 0.96, 0.014, 6, 22), accent);
      group.add(rim);
      break;
    }
    default: {
      // Arms: flipper, hammer, lifter, crusher.
      const armLength = w.radiusM;
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(armLength, 0.07, bot.stats.chassis.width * 0.72),
        steel,
      );
      arm.position.set(armLength / 2, 0, 0);
      arm.castShadow = true;
      group.add(arm);

      if (w.kind === 'hammer') {
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.3), accent);
        head.position.set(armLength, 0, 0);
        head.castShadow = true;
        group.add(head);
      } else if (w.kind === 'crusher') {
        const jaw = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.28, 4), accent);
        jaw.position.set(armLength, -0.1, 0);
        jaw.rotation.z = Math.PI;
        group.add(jaw);
      } else {
        // Flipper and lifter get a broad tip that can get under things.
        const tip = new THREE.Mesh(
          new THREE.BoxGeometry(0.16, 0.014, bot.stats.chassis.width * 0.8),
          accent,
        );
        tip.position.set(armLength + 0.06, -0.026, 0);
        group.add(tip);
      }
      break;
    }
  }

  return group;
}

/**
 * Push one frame of simulation state onto the meshes.
 *
 * Wheel spin, weapon transform and progressive battle damage all come from the
 * live simulation rather than from an animation.
 */
export function syncBotView(view: BotView, bot: Bot): void {
  const p = bot.position;
  const r = bot.rotation;
  view.root.position.set(p.x, p.y, p.z);
  view.root.quaternion.set(r.x, r.y, r.z, r.w);

  for (let i = 0; i < view.wheels.length; i++) {
    const mesh = view.wheels[i]!;
    const wheel = bot.wheels[i];
    if (!wheel) continue;
    // The tyre mesh is rotated onto its side, so its local Y is the axle.
    mesh.rotation.y = wheel.spin;
    // A destroyed wheel is gone.
    const alive = (bot.health.wheels[i] ?? 0) > 0;
    mesh.parent!.visible = alive;
  }

  if (view.weapon && bot.weaponBody) {
    const wp = bot.weaponBody.translation();
    const wr = bot.weaponBody.rotation();
    view.weapon.position.set(wp.x, wp.y, wp.z);
    view.weapon.quaternion.set(wr.x, wr.y, wr.z, wr.w);
    view.weapon.visible = !bot.weaponDead || bot.stats.weapon.burstJ > 0;
  }

  // Darken and dull the hull as its armour is beaten off.
  const armorMax = Object.values(bot.health.zoneMax).reduce((s, v) => s + v, 0);
  const armorNow = Object.values(bot.health.zone).reduce((s, v) => s + v, 0);
  const damage = armorMax > 0 ? clamp01(1 - armorNow / armorMax) : 0;
  if (Math.abs(damage - view.damageLevel) > 0.01) {
    view.damageLevel = damage;
    const shade = 1 - damage * 0.45;
    for (const material of view.hullMaterials) {
      material.color.setRGB(shade, shade * 0.98, shade * 0.96);
      material.roughness = Math.min(1, bot.stats.armor.roughness + damage * 0.4);
    }
  }

  // The team light dies with the robot.
  const light = view.teamLight.material as THREE.MeshStandardMaterial;
  light.emissiveIntensity = bot.destroyed ? 0 : 3.5;
}

/** Free the geometry and materials a robot view owns. */
export function disposeBotView(view: BotView): void {
  view.root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
    }
  });
  // The hull textures are owned by this view rather than the shared cache,
  // because they are unique to this robot's livery and name.
  for (const material of view.hullMaterials) {
    material.map?.dispose();
    material.dispose();
  }
}
