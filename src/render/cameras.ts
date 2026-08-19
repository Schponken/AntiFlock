/**
 * Camera work.
 *
 * The fight camera is written as a broadcast operator rather than a follow cam:
 * it frames both machines, keeps a consistent side of the action so the picture
 * never crosses the line, pulls back when they separate, and pushes in when they
 * close. Scripted moves for the introductions and the knockout replay ride on
 * top of the same rig.
 */

import * as THREE from 'three';
import { clamp, damp, smoothstep } from '../core/mathx.ts';
import { fxRng } from '../core/rng.ts';
import { ARENA_HALF } from '../game/arena.ts';

export type CameraMode = 'broadcast' | 'chase' | 'orbit' | 'scripted' | 'knockout';

export interface CameraSubject {
  position(target?: THREE.Vector3): THREE.Vector3;
  forward(target?: THREE.Vector3): THREE.Vector3;
}

interface ScriptedMove {
  from: THREE.Vector3;
  to: THREE.Vector3;
  lookFrom: THREE.Vector3;
  lookTo: THREE.Vector3;
  duration: number;
  elapsed: number;
  /** Eased for a smooth crane, linear for a mechanical dolly. */
  ease: boolean;
}

export class CameraDirector {
  readonly camera: THREE.PerspectiveCamera;

  private mode: CameraMode = 'broadcast';
  private desiredPosition = new THREE.Vector3(0, 6, 12);
  private desiredTarget = new THREE.Vector3(0, 0.4, 0);
  private smoothedTarget = new THREE.Vector3(0, 0.4, 0);
  private script: ScriptedMove | null = null;

  /** Which side of the action the operator is standing on. */
  private azimuth = Math.PI * 0.25;
  private orbitAngle = 0;
  private knockoutSubject: CameraSubject | null = null;
  private shakeOffset = new THREE.Vector3();

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(aspect = 16 / 9) {
    this.camera = new THREE.PerspectiveCamera(52, aspect, 0.08, 220);
    this.camera.position.copy(this.desiredPosition);
    this.camera.lookAt(this.desiredTarget);
  }

  setMode(mode: CameraMode): void {
    this.mode = mode;
    if (mode !== 'scripted') this.script = null;
  }

  getMode(): CameraMode {
    return this.mode;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Run a scripted crane or dolly move. Switches the director into scripted mode. */
  playMove(move: {
    from: [number, number, number];
    to: [number, number, number];
    lookFrom: [number, number, number];
    lookTo: [number, number, number];
    duration: number;
    ease?: boolean;
  }): void {
    this.script = {
      from: new THREE.Vector3(...move.from),
      to: new THREE.Vector3(...move.to),
      lookFrom: new THREE.Vector3(...move.lookFrom),
      lookTo: new THREE.Vector3(...move.lookTo),
      duration: move.duration,
      elapsed: 0,
      ease: move.ease ?? true,
    };
    this.mode = 'scripted';
    this.camera.position.copy(this.script.from);
    this.smoothedTarget.copy(this.script.lookFrom);
  }

  get scriptFinished(): boolean {
    return this.script === null || this.script.elapsed >= this.script.duration;
  }

  /** Slow orbit around one machine, for the knockout and the winner's shot. */
  orbitAround(subject: CameraSubject): void {
    this.knockoutSubject = subject;
    this.mode = 'knockout';
    this.orbitAngle = this.azimuth;
  }

  /**
   * @param subjects the machines still in the fight
   * @param player the machine the local player is driving, for chase mode
   * @param shake 0-1 from the effects system
   */
  update(dt: number, subjects: CameraSubject[], player: CameraSubject | null, shake: number): void {
    switch (this.mode) {
      case 'scripted':
        this.updateScripted(dt);
        break;
      case 'knockout':
        this.updateKnockout(dt);
        break;
      case 'chase':
        this.updateChase(dt, player ?? subjects[0] ?? null);
        break;
      case 'orbit':
        this.updateOrbit(dt);
        break;
      case 'broadcast':
      default:
        this.updateBroadcast(dt, subjects);
        break;
    }

    this.containWithinArena();

    // Shake is applied after framing so it never fights the smoothing.
    const magnitude = shake * 0.16;
    if (magnitude > 0.0005) {
      this.shakeOffset.set(
        fxRng.spread(magnitude),
        fxRng.spread(magnitude),
        fxRng.spread(magnitude),
      );
      this.camera.position.add(this.shakeOffset);
    }

    this.camera.lookAt(this.smoothedTarget);
  }

  /**
   * Keep the camera inside the box.
   *
   * Every mode ends up here, because there is no shot worth having from inside a
   * wall: the near plane slices through the polycarbonate, the corner posts and
   * the crowd stands, and the picture fills with black geometry. Cheaper and far
   * more reliable than trying to make each mode individually well behaved.
   */
  private containWithinArena(): void {
    const limit = ARENA_HALF - 0.55;
    this.camera.position.x = clamp(this.camera.position.x, -limit, limit);
    this.camera.position.z = clamp(this.camera.position.z, -limit, limit);
    this.camera.position.y = clamp(this.camera.position.y, 0.32, 8.4);
  }

  private updateScripted(dt: number): void {
    const script = this.script;
    if (!script) return;
    script.elapsed = Math.min(script.duration, script.elapsed + dt);
    const raw = script.duration > 0 ? script.elapsed / script.duration : 1;
    const t = script.ease ? smoothstep(0, 1, raw) : raw;
    this.camera.position.lerpVectors(script.from, script.to, t);
    this.smoothedTarget.lerpVectors(script.lookFrom, script.lookTo, t);
  }

  private updateKnockout(dt: number): void {
    const subject = this.knockoutSubject;
    if (!subject) return;
    this.orbitAngle += dt * 0.32;
    const focus = subject.position(this.tmpA);
    const radius = 3.1;
    this.desiredPosition.set(
      focus.x + Math.sin(this.orbitAngle) * radius,
      focus.y + 1.5,
      focus.z + Math.cos(this.orbitAngle) * radius,
    );
    this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-4 * dt));
    this.smoothedTarget.lerp(focus, 1 - Math.exp(-5 * dt));
  }

  private updateOrbit(dt: number): void {
    this.orbitAngle += dt * 0.25;
    const radius = 3.4;
    this.camera.position.set(
      Math.sin(this.orbitAngle) * radius,
      1.5,
      Math.cos(this.orbitAngle) * radius,
    );
    this.smoothedTarget.set(0, 0.35, 0);
  }

  private updateChase(dt: number, subject: CameraSubject | null): void {
    if (!subject) return;
    const position = subject.position(this.tmpA);
    const forward = subject.forward(this.tmpB);
    // Flatten so the camera never rolls when the machine is thrown.
    forward.y = 0;
    if (forward.lengthSq() < 1e-4) forward.set(0, 0, 1);
    forward.normalize();

    this.desiredPosition
      .copy(position)
      .addScaledVector(forward, -2.5)
      .add(new THREE.Vector3(0, 1.35, 0));

    this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-7 * dt));
    this.desiredTarget.copy(position).addScaledVector(forward, 2).setY(position.y + 0.25);
    this.smoothedTarget.lerp(this.desiredTarget, 1 - Math.exp(-9 * dt));
  }

  private updateBroadcast(dt: number, subjects: CameraSubject[]): void {
    if (subjects.length === 0) return;

    // Frame the midpoint of everything still fighting.
    const midpoint = this.tmpA.set(0, 0, 0);
    for (const subject of subjects) midpoint.add(subject.position(this.tmpB));
    midpoint.divideScalar(subjects.length);
    midpoint.y = Math.max(0.2, midpoint.y);

    let separation = 1.5;
    if (subjects.length >= 2) {
      separation = subjects[0]!.position(this.tmpB).distanceTo(
        subjects[1]!.position(new THREE.Vector3()),
      );
    }

    /*
     * Close quarters gets a tight, low shot. When the machines separate the shot
     * has to widen — but a 15 m box cannot be covered by backing up, because the
     * distance needed to fit two bots ten metres apart puts the camera outside the
     * wall. So the pull-back is capped and the shortfall is converted into height:
     * the operator climbs and looks down, exactly as the hard cameras above a real
     * arena do. Both machines stay in frame and the camera stays in the building.
     */
    const distance = clamp(3.4 + separation * 0.5, 3.6, 7.2);
    const halfAngle = Math.tan((this.camera.fov * Math.PI) / 360);
    const neededForFraming = (separation * 0.62) / Math.max(0.1, halfAngle);
    const shortfall = Math.max(0, neededForFraming - distance);
    const height = clamp(1.4 + separation * 0.28 + shortfall * 0.85, 1.5, 7.6);

    // Prefer the side the action is drifting away from, so nothing is occluded by
    // the near wall, and drift slowly so the picture never snaps.
    const preferred = Math.atan2(midpoint.x, midpoint.z) + Math.PI;
    this.azimuth = dampAngle(this.azimuth, preferred, 0.35, dt);

    this.desiredPosition.set(
      midpoint.x + Math.sin(this.azimuth) * distance,
      height,
      midpoint.z + Math.cos(this.azimuth) * distance,
    );

    this.camera.position.lerp(this.desiredPosition, 1 - Math.exp(-3.4 * dt));
    this.desiredTarget.copy(midpoint).setY(midpoint.y + 0.25);
    this.smoothedTarget.lerp(this.desiredTarget, 1 - Math.exp(-4.2 * dt));
  }

  /** Snap the rig to a sensible fight position with no interpolation. */
  reset(): void {
    this.azimuth = Math.PI * 0.25;
    this.camera.position.set(6, 4.2, 6);
    this.smoothedTarget.set(0, 0.4, 0);
    this.camera.lookAt(this.smoothedTarget);
  }
}

/** Damp an angle the short way around the circle. */
function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return damp(current, current + delta, rate, dt);
}
