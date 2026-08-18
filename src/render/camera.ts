/**
 * The camera director.
 *
 * Broadcast coverage of a robot fight is not a chase cam. The operator holds
 * both robots in frame, pulls back when they separate and pushes in when they
 * engage, and stays on the far side of the action so neither robot is hidden
 * behind the other. That is what `broadcast` does: it frames the pair, not one
 * of them.
 *
 * The intro modes are separate: a slow orbit of the cage while the robots are
 * introduced, and a hold on each robot as its name is called.
 */

import * as THREE from 'three';
import { clamp, damp, smoothstep } from '../core/math';
import { ARENA_HALF, CEILING_HEIGHT } from '../sim/arena';
import type { Vec3 } from '../sim/physics';

export type CameraMode = 'broadcast' | 'chase' | 'orbit' | 'intro-red' | 'intro-blue' | 'garage';

export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'broadcast';
  /** Which robot `chase` follows. */
  chaseSide: 'a' | 'b' = 'a';

  private position = new THREE.Vector3(0, 6, 12);
  private lookAt = new THREE.Vector3(0, 0.4, 0);
  private desiredPosition = new THREE.Vector3(0, 6, 12);
  private desiredLookAt = new THREE.Vector3(0, 0.4, 0);
  private orbitAngle = 0;
  /** Camera shake, decays on its own. */
  private shake = 0;
  private shakeSeed = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.08, 220);
    this.camera.position.copy(this.position);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Kick the camera, scaled by how big the hit was. */
  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  /**
   * Aim the camera for this frame.
   *
   * `red` and `blue` are the robots' positions; `dt` drives the smoothing so
   * the motion is frame-rate independent.
   */
  update(
    dt: number,
    time: number,
    red: Vec3,
    blue: Vec3,
    redForward: Vec3,
    options: { fov?: number } = {},
  ): void {
    const a = new THREE.Vector3(red.x, red.y, red.z);
    const b = new THREE.Vector3(blue.x, blue.y, blue.z);

    switch (this.mode) {
      case 'broadcast':
        this.frameBoth(a, b);
        break;
      case 'chase':
        this.chase(this.chaseSide === 'a' ? a : b, redForward);
        break;
      case 'orbit':
        this.orbitAngle += dt * 0.16;
        this.orbitCage(this.orbitAngle, 0.62);
        break;
      case 'intro-red':
        this.orbitAngle += dt * 0.35;
        this.holdOn(a, this.orbitAngle);
        break;
      case 'intro-blue':
        this.orbitAngle += dt * 0.35;
        this.holdOn(b, this.orbitAngle);
        break;
      case 'garage':
        this.orbitAngle += dt * 0.25;
        this.garageTurntable(this.orbitAngle);
        break;
    }

    // Ease toward the target. Position lags a little more than the aim, which
    // is what makes it feel like a human on a camera rather than a rig.
    const posHalfLife = this.mode === 'broadcast' ? 0.22 : 0.3;
    this.position.x = damp(this.position.x, this.desiredPosition.x, posHalfLife, dt);
    this.position.y = damp(this.position.y, this.desiredPosition.y, posHalfLife, dt);
    this.position.z = damp(this.position.z, this.desiredPosition.z, posHalfLife, dt);
    this.lookAt.x = damp(this.lookAt.x, this.desiredLookAt.x, 0.12, dt);
    this.lookAt.y = damp(this.lookAt.y, this.desiredLookAt.y, 0.12, dt);
    this.lookAt.z = damp(this.lookAt.z, this.desiredLookAt.z, 0.12, dt);

    this.camera.position.copy(this.position);

    // Shake: a fast decaying wobble applied after the smoothing, so it never
    // fights the easing.
    if (this.shake > 0.001) {
      this.shakeSeed += dt * 47;
      const s = this.shake * this.shake * 0.34;
      this.camera.position.x += Math.sin(this.shakeSeed * 1.7) * s;
      this.camera.position.y += Math.sin(this.shakeSeed * 2.3 + 1.1) * s;
      this.camera.position.z += Math.sin(this.shakeSeed * 1.3 + 2.7) * s;
      this.shake = Math.max(0, this.shake - dt * 2.6);
    }

    this.camera.lookAt(this.lookAt);

    const targetFov = options.fov ?? (this.mode === 'broadcast' ? 52 : 46);
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov = damp(this.camera.fov, targetFov, 0.2, dt);
      this.camera.updateProjectionMatrix();
    }

    void time;
  }

  /** Hold both robots in frame from a consistent side of the action. */
  private frameBoth(a: THREE.Vector3, b: THREE.Vector3): void {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const separation = a.distanceTo(b);

    // Look along the line between them, and sit off to one side of it.
    const axis = b.clone().sub(a);
    axis.y = 0;
    if (axis.lengthSq() < 1e-4) axis.set(1, 0, 0);
    axis.normalize();
    // Perpendicular, always chosen so the camera stays on the same side.
    const side = new THREE.Vector3(-axis.z, 0, axis.x);
    if (side.z < 0) side.negate();

    // Back off as they separate so both stay in shot.
    const distance = clamp(4.6 + separation * 0.95, 5.2, 12.5);
    const height = clamp(2.3 + separation * 0.28, 2.3, 5.4);

    this.desiredPosition.copy(mid).addScaledVector(side, distance);
    this.desiredPosition.y = height;

    // Keep the camera inside the hall.
    const limit = ARENA_HALF + 3.2;
    this.desiredPosition.x = clamp(this.desiredPosition.x, -limit, limit);
    this.desiredPosition.z = clamp(this.desiredPosition.z, -limit, limit);
    this.desiredPosition.y = clamp(this.desiredPosition.y, 1.5, CEILING_HEIGHT + 2.5);

    this.desiredLookAt.copy(mid);
    this.desiredLookAt.y = 0.35 + smoothstep(0, 8, separation) * 0.4;
  }

  private chase(target: THREE.Vector3, forward: Vec3): void {
    const dir = new THREE.Vector3(forward.x, 0, forward.z);
    if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
    dir.normalize();
    this.desiredPosition.copy(target).addScaledVector(dir, -3.4);
    this.desiredPosition.y = target.y + 1.5;
    this.desiredLookAt.copy(target).addScaledVector(dir, 1.6);
    this.desiredLookAt.y = target.y + 0.25;
  }

  private orbitCage(angle: number, heightFactor: number): void {
    const radius = ARENA_HALF + 4.5;
    this.desiredPosition.set(
      Math.cos(angle) * radius,
      3.2 + Math.sin(angle * 0.7) * 1.4 * heightFactor,
      Math.sin(angle) * radius,
    );
    this.desiredLookAt.set(0, 0.7, 0);
  }

  private holdOn(target: THREE.Vector3, angle: number): void {
    const radius = 3.4;
    this.desiredPosition.set(
      target.x + Math.cos(angle) * radius,
      target.y + 1.35,
      target.z + Math.sin(angle) * radius,
    );
    this.desiredLookAt.copy(target);
    this.desiredLookAt.y += 0.18;
  }

  private garageTurntable(angle: number): void {
    const radius = 2.6;
    this.desiredPosition.set(Math.cos(angle) * radius, 1.15, Math.sin(angle) * radius);
    this.desiredLookAt.set(0, 0.28, 0);
  }

  /** Jump straight to the current target, with no easing. Used on mode changes. */
  snap(): void {
    this.position.copy(this.desiredPosition);
    this.lookAt.copy(this.desiredLookAt);
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.lookAt);
  }
}
