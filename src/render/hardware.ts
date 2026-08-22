/**
 * Fabricated hardware.
 *
 * A combat robot is not a painted box — it is plate bolted to a welded frame,
 * with motor cans, pulleys, a belt, bearing blocks and a few hundred fasteners
 * holding it together. These are the parts that make it read as a *machine*
 * rather than as geometry, and they are the details the eye picks up first:
 * bolt heads catching the arena lights, a chamfer on a leading edge, a belt
 * running from a motor to a weapon hub.
 *
 * Everything here is built to real proportions and shared through a per-bot
 * registry so a machine can be torn down without leaking GPU memory.
 */

import * as THREE from 'three';

/**
 * Collects everything a single machine allocates so it can all be freed when
 * that machine is discarded. The workshop rebuilds its preview on every click,
 * so this is the difference between a steady heap and an unbounded one.
 */
export class GeometryRegistry {
  private geometries = new Set<THREE.BufferGeometry>();
  private materials = new Set<THREE.Material>();

  geometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.add(geometry);
    return geometry;
  }

  material<T extends THREE.Material>(material: T): T {
    this.materials.add(material);
    return material;
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.geometries.clear();
    this.materials.clear();
  }
}


/**
 * Replace a geometry's UVs with a flat projection onto one plane.
 *
 * `ExtrudeGeometry` generates UVs in *object units* rather than 0-1, so a plate
 * two thirds of a metre wide samples the first two thirds of a texel and the
 * whole livery collapses to one flat colour. Hand-built geometry often has no
 * UVs at all, which is worse. Projecting the bounding box onto the face plane
 * gives every one of these parts a sane, predictable unwrap.
 */
export function applyPlanarUV(
  geometry: THREE.BufferGeometry,
  uAxis: 'x' | 'y' | 'z' = 'x',
  vAxis: 'x' | 'y' | 'z' = 'y',
): THREE.BufferGeometry {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const position = geometry.getAttribute('position');
  if (!box || !position) return geometry;

  const size = new THREE.Vector3();
  box.getSize(size);
  const spanU = Math.max(1e-5, size[uAxis]);
  const spanV = Math.max(1e-5, size[vAxis]);

  const uvs = new Float32Array(position.count * 2);
  for (let i = 0; i < position.count; i++) {
    const u = (position[`get${uAxis.toUpperCase()}` as 'getX'](i) - box.min[uAxis]) / spanU;
    const v = (position[`get${vAxis.toUpperCase()}` as 'getY'](i) - box.min[vAxis]) / spanV;
    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
}

// ---------------------------------------------------------------------------
// Fasteners
// ---------------------------------------------------------------------------

/** A hex-head bolt: head, washer face, and a hint of thread below. */
export function hexBoltGeometry(registry: GeometryRegistry, size: number): THREE.BufferGeometry {
  const head = new THREE.CylinderGeometry(size, size, size * 0.62, 6);
  head.translate(0, size * 0.31, 0);
  const washer = new THREE.CylinderGeometry(size * 1.25, size * 1.25, size * 0.14, 10);
  washer.translate(0, size * 0.07, 0);
  const merged = mergeGeometries([head, washer]);
  head.dispose();
  washer.dispose();
  // Bolts point up the +Y axis; callers orient them.
  return registry.geometry(merged);
}

/** A countersunk socket-cap fastener, for armour that must stay flush. */
export function flushBoltGeometry(registry: GeometryRegistry, size: number): THREE.BufferGeometry {
  const head = new THREE.CylinderGeometry(size * 1.15, size * 0.72, size * 0.5, 10);
  head.translate(0, size * 0.16, 0);
  const socket = new THREE.CylinderGeometry(size * 0.5, size * 0.5, size * 0.24, 6);
  socket.translate(0, size * 0.36, 0);
  const merged = mergeGeometries([head, socket]);
  head.dispose();
  socket.dispose();
  return registry.geometry(merged);
}

export interface BoltPlacement {
  position: THREE.Vector3;
  /** Surface normal the bolt head sits on. */
  normal: THREE.Vector3;
}

/**
 * One instanced draw call for an arbitrary number of fasteners. Bolts are the
 * single highest-value detail on the machine and there are a lot of them, so
 * they must not cost a draw call each.
 */
export function boltCluster(
  registry: GeometryRegistry,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  placements: readonly BoltPlacement[],
): THREE.InstancedMesh | null {
  if (placements.length === 0) return null;

  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3(1, 1, 1);

  placements.forEach((placement, index) => {
    quaternion.setFromUnitVectors(up, placement.normal.clone().normalize());
    matrix.compose(placement.position, quaternion, scale);
    mesh.setMatrixAt(index, matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  // Instances are scattered over the whole machine; let the parent cull it.
  mesh.frustumCulled = false;
  registry.geometry(mesh.geometry);
  return mesh;
}

/** Bolt positions evenly spaced around a circle on a plane. */
export function ringPlacements(options: {
  count: number;
  radius: number;
  /** 'x' | 'y' | 'z' — the axis the circle is normal to. */
  axis: 'x' | 'y' | 'z';
  offset: number;
  /** Which way the heads face along that axis. */
  facing: 1 | -1;
  phase?: number;
}): BoltPlacement[] {
  const { count, radius, axis, offset, facing, phase = 0 } = options;
  const out: BoltPlacement[] = [];
  const normal = new THREE.Vector3(
    axis === 'x' ? facing : 0,
    axis === 'y' ? facing : 0,
    axis === 'z' ? facing : 0,
  );
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * Math.PI * 2;
    const u = Math.cos(a) * radius;
    const v = Math.sin(a) * radius;
    const position =
      axis === 'x'
        ? new THREE.Vector3(offset, u, v)
        : axis === 'y'
          ? new THREE.Vector3(u, offset, v)
          : new THREE.Vector3(u, v, offset);
    out.push({ position, normal: normal.clone() });
  }
  return out;
}

/** Bolts in a straight run, as along the edge of an armour plate. */
export function rowPlacements(options: {
  count: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  normal: THREE.Vector3;
}): BoltPlacement[] {
  const { count, from, to, normal } = options;
  const out: BoltPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({
      position: from.clone().lerp(to, t),
      normal: normal.clone(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Drive hardware
// ---------------------------------------------------------------------------

/** A brushless motor can: body, end bell, and an output shaft. */
export function motorCan(
  registry: GeometryRegistry,
  material: THREE.Material,
  options: { radius: number; length: number },
): THREE.Group {
  const { radius, length } = options;
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(radius, radius, length, 16, 1)),
    material,
  );
  body.rotation.z = Math.PI / 2;
  body.castShadow = true;
  group.add(body);

  // End bell: slightly smaller, at the drive end.
  const bell = new THREE.Mesh(
    registry.geometry(
      new THREE.CylinderGeometry(radius * 0.86, radius * 0.72, length * 0.22, 14),
    ),
    material,
  );
  bell.rotation.z = Math.PI / 2;
  bell.position.x = length * 0.58;
  group.add(bell);

  const shaft = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(radius * 0.16, radius * 0.16, length * 0.4, 8)),
    material,
  );
  shaft.rotation.z = Math.PI / 2;
  shaft.position.x = length * 0.76;
  group.add(shaft);

  return group;
}

/** A flanged toothed pulley. */
export function pulley(
  registry: GeometryRegistry,
  material: THREE.Material,
  options: { radius: number; width: number },
): THREE.Group {
  const { radius, width } = options;
  const group = new THREE.Group();

  const core = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(radius, radius, width, 20, 1)),
    material,
  );
  core.rotation.z = Math.PI / 2;
  core.castShadow = true;
  group.add(core);

  const flangeGeom = registry.geometry(
    new THREE.CylinderGeometry(radius * 1.12, radius * 1.12, width * 0.16, 20),
  );
  for (const sign of [-1, 1]) {
    const flange = new THREE.Mesh(flangeGeom, material);
    flange.rotation.z = Math.PI / 2;
    flange.position.x = (sign * width) / 2;
    group.add(flange);
  }
  return group;
}

/**
 * A belt wrapped around two pulleys, as a flat band in the XY plane.
 *
 * Built from the real tangent construction — the two outer tangent lines plus
 * the arcs they meet — so the belt actually hugs both pulleys instead of being
 * a rectangle stretched between them.
 */
export function beltBand(
  registry: GeometryRegistry,
  material: THREE.Material,
  options: {
    centerA: THREE.Vector2;
    radiusA: number;
    centerB: THREE.Vector2;
    radiusB: number;
    width: number;
    thickness: number;
  },
): THREE.Mesh | null {
  const { centerA, radiusA, centerB, radiusB, width, thickness } = options;
  const delta = centerB.clone().sub(centerA);
  const distance = delta.length();
  // Degenerate layouts (one pulley inside the other) have no external belt.
  if (distance < Math.abs(radiusA - radiusB) + 1e-4) return null;

  const baseAngle = Math.atan2(delta.y, delta.x);
  const alpha = Math.acos(Math.min(1, Math.max(-1, (radiusA - radiusB) / distance)));

  const contour = (rA: number, rB: number): THREE.Vector2[] => {
    const points: THREE.Vector2[] = [];
    const steps = 20;
    // Wrap around A the long way, then around B.
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle + alpha + (i / steps) * (2 * Math.PI - 2 * alpha);
      points.push(
        new THREE.Vector2(centerA.x + Math.cos(a) * rA, centerA.y + Math.sin(a) * rA),
      );
    }
    for (let i = 0; i <= steps; i++) {
      const a = baseAngle - alpha + (i / steps) * (2 * alpha);
      points.push(
        new THREE.Vector2(centerB.x + Math.cos(a) * rB, centerB.y + Math.sin(a) * rB),
      );
    }
    return points;
  };

  const shape = new THREE.Shape(contour(radiusA, radiusB));
  const inner = contour(Math.max(0.002, radiusA - thickness), Math.max(0.002, radiusB - thickness));
  shape.holes.push(new THREE.Path(inner.reverse()));

  const geometry = registry.geometry(
    new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false, curveSegments: 2 }),
  );
  geometry.translate(0, 0, -width / 2);
  geometry.computeVertexNormals();
  applyPlanarUV(geometry, 'x', 'y');

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

/** A pillow-block bearing carrying a weapon shaft. */
export function pillowBlock(
  registry: GeometryRegistry,
  material: THREE.Material,
  options: { bore: number; width: number },
): THREE.Group {
  const { bore, width } = options;
  const group = new THREE.Group();

  const housing = new THREE.Mesh(
    registry.geometry(new THREE.CylinderGeometry(bore * 1.9, bore * 1.9, width, 14)),
    material,
  );
  housing.rotation.z = Math.PI / 2;
  housing.castShadow = true;
  group.add(housing);

  // The foot that bolts it to the frame.
  const foot = new THREE.Mesh(
    registry.geometry(new THREE.BoxGeometry(width * 1.1, bore * 1.1, bore * 4.4)),
    material,
  );
  foot.position.y = -bore * 2.2;
  foot.castShadow = true;
  group.add(foot);

  return group;
}

/** A drive sprocket, for chain-driven wheels. */
export function sprocketGeometry(
  registry: GeometryRegistry,
  options: { radius: number; teeth: number; thickness: number },
): THREE.BufferGeometry {
  const { radius, teeth, thickness } = options;
  const shape = new THREE.Shape();
  const toothDepth = radius * 0.14;
  for (let i = 0; i < teeth * 2; i++) {
    const a = (i / (teeth * 2)) * Math.PI * 2;
    const r = i % 2 === 0 ? radius : radius - toothDepth;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  shape.holes.push(new THREE.Path(circlePoints(radius * 0.3, 12).reverse()));

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: false,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -thickness / 2);
  geometry.rotateY(Math.PI / 2);
  geometry.computeVertexNormals();
  applyPlanarUV(geometry, 'z', 'y');
  return registry.geometry(geometry);
}

function circlePoints(radius: number, segments: number): THREE.Vector2[] {
  const points: THREE.Vector2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius));
  }
  return points;
}

// ---------------------------------------------------------------------------
// Plate
// ---------------------------------------------------------------------------

/**
 * An armour plate with chamfered edges.
 *
 * Real plate is never a sharp-cornered slab: the edges are broken so nothing
 * catches, and that chamfer is what catches the light and tells you it is a
 * thick piece of steel rather than a texture on a box.
 */
export function chamferedPlate(
  registry: GeometryRegistry,
  options: { width: number; height: number; thickness: number; chamfer?: number },
): THREE.BufferGeometry {
  const { width, height, thickness } = options;
  const chamfer = Math.min(
    options.chamfer ?? thickness * 0.45,
    width * 0.2,
    height * 0.2,
    thickness * 0.49,
  );

  const hw = width / 2 - chamfer;
  const hh = height / 2 - chamfer;
  const shape = new THREE.Shape();
  shape.moveTo(-hw, -height / 2 + chamfer * 0);
  shape.lineTo(hw, -hh - chamfer * 0);
  shape.lineTo(width / 2, -hh);
  shape.lineTo(width / 2, hh);
  shape.lineTo(hw, height / 2);
  shape.lineTo(-hw, height / 2);
  shape.lineTo(-width / 2, hh);
  shape.lineTo(-width / 2, -hh);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: thickness - chamfer * 2,
    bevelEnabled: true,
    bevelThickness: chamfer,
    bevelSize: chamfer,
    bevelSegments: 1,
    curveSegments: 1,
  });
  geometry.translate(0, 0, -(thickness - chamfer * 2) / 2);
  geometry.computeVertexNormals();
  applyPlanarUV(geometry, 'x', 'y');
  return registry.geometry(geometry);
}

// ---------------------------------------------------------------------------

/**
 * Merge a handful of small geometries into one. Only handles the non-indexed
 * position/normal/uv case these helpers produce, which keeps it far smaller
 * than pulling in the full BufferGeometryUtils example module.
 */
export function mergeGeometries(sources: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = sources.map((geometry) =>
    geometry.index ? geometry.toNonIndexed() : geometry.clone(),
  );

  let vertexCount = 0;
  for (const part of parts) vertexCount += part.getAttribute('position').count;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);

  let vertexOffset = 0;
  for (const part of parts) {
    const position = part.getAttribute('position');
    const normal = part.getAttribute('normal');
    const uv = part.getAttribute('uv');
    positions.set(position.array as Float32Array, vertexOffset * 3);
    if (normal) normals.set(normal.array as Float32Array, vertexOffset * 3);
    if (uv) uvs.set(uv.array as Float32Array, vertexOffset * 2);
    vertexOffset += position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.computeVertexNormals();

  for (const part of parts) part.dispose();
  return merged;
}
