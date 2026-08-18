/**
 * A robot in the world.
 *
 * The chassis is a single convex hull whose front face is wedged according to
 * the chassis spec, so getting under the other robot is a genuine geometric
 * property rather than a scripted behaviour. Wheels are rigid cylinder
 * colliders bolted to that hull — combat robots have no suspension, so
 * modelling them rigidly is both simpler and more accurate — and the drive is
 * a friction model that applies motor force at each wheel's contact patch.
 * Applying force at the patch rather than the centre of mass is what produces
 * wheelies, weight transfer under acceleration, and the shove of a pushing
 * match for free.
 *
 * Weapons are always a second rigid body on a revolute joint. Spinners run the
 * joint motor at a velocity target; flippers, hammers, lifters and crushers use
 * the same joint with angular limits and a position target. Because the rotor
 * is a real body, its stored energy, its gyroscopic resistance to turning, and
 * the recoil it puts back into its own robot all fall out of the solver rather
 * than being faked.
 */

import { clamp, clamp01, rpmToRadPerSec } from '../core/math';
import type { Rng } from '../core/rng';
import {
  applyHit,
  createHealth,
  driveFraction,
  isImmobilised,
  isWeaponDead,
  type ArmorZone,
  type BotHealth,
  type DamageResult,
  type Hit,
} from './damage';
import { computeStats, type BotDesign, type BotStats } from './parts';
import {
  GROUPS,
  RAPIER,
  dot,
  length as vlen,
  normalize,
  pointVelocity,
  rotateVec,
  rotateVecInverse,
  scale,
  sub,
  type Physics,
  type Vec3,
} from './physics';

/** Driver inputs for one tick. */
export interface BotControl {
  /** Forward/reverse, -1..1. */
  throttle: number;
  /** Differential steering, -1..1. Positive turns right. */
  steer: number;
  /** Spinner throttle, 0..1. */
  weapon: number;
  /** Edge-triggered: fire a flipper, hammer, lifter or crusher. */
  fire: boolean;
  /** Edge-triggered: fire the self-righting mechanism. */
  selfRight: boolean;
}

export function neutralControl(): BotControl {
  return { throttle: 0, steer: 0, weapon: 0, fire: false, selfRight: false };
}

interface WheelRuntime {
  /** Position on the chassis, in chassis local space. */
  local: Vec3;
  radius: number;
  /** Positive Z is the left side of the robot. */
  side: 'left' | 'right';
  collider: RAPIER.Collider;
  // Per-step state, read by the renderer.
  grounded: boolean;
  contact: Vec3;
  /** Rolling angle for the wheel mesh, radians. */
  spin: number;
  /** Slip ratio 0..1, for tyre smoke. */
  slip: number;
}

/** Which way a weapon's rotor turns, in chassis local space. */
function spinAxisFor(stats: BotStats): Vec3 {
  switch (stats.weapon.mount) {
    case 'front-horizontal':
      return { x: 0, y: 1, z: 0 }; // sweeps the floor horizontally
    case 'front-vertical':
    case 'top':
      return { x: 0, y: 0, z: 1 }; // spins in the robot's vertical plane
    default:
      return { x: 0, y: 0, z: 1 };
  }
}

/** Where the weapon's pivot sits on the chassis, in chassis local space. */
function mountPointFor(stats: BotStats, hullCenterY: number): Vec3 {
  const c = stats.chassis;
  const halfL = c.length / 2;
  switch (stats.weapon.mount) {
    case 'front-horizontal':
      // A metre-long bar on a metre-long robot will always sweep back over its
      // own deck, which is exactly how real horizontal spinners are built. So
      // it sits just above the deck rather than buried in it, on a shaft
      // forward of centre.
      return { x: halfL * 0.5, y: hullCenterY + c.height / 2 + 0.055, z: 0 };
    case 'front-vertical':
      return { x: halfL * 0.82, y: hullCenterY - c.height * 0.3, z: 0 };
    case 'top':
      return { x: -halfL * 0.25, y: hullCenterY + c.height * 0.55, z: 0 };
    default:
      return { x: 0, y: hullCenterY, z: 0 };
  }
}

/** Angular travel limits for a burst weapon, radians. */
function burstLimits(stats: BotStats): { rest: number; extended: number } {
  switch (stats.weapon.kind) {
    case 'flipper':
      return { rest: 0, extended: -1.35 }; // sweeps up and forward
    case 'lifter':
      return { rest: 0, extended: -0.95 };
    case 'hammer':
      return { rest: 2.0, extended: -0.35 }; // cocked back, slams forward
    case 'crusher':
      return { rest: -0.05, extended: 0.85 }; // jaw closes downward
    default:
      return { rest: 0, extended: 0 };
  }
}

export class Bot {
  readonly id: string;
  readonly side: 'a' | 'b';
  readonly design: BotDesign;
  readonly stats: BotStats;
  health: BotHealth;

  readonly body: RAPIER.RigidBody;
  readonly hullCollider: RAPIER.Collider;
  readonly wheels: WheelRuntime[] = [];

  weaponBody: RAPIER.RigidBody | null = null;
  weaponJoint: RAPIER.RevoluteImpulseJoint | null = null;
  readonly weaponAxisLocal: Vec3;
  readonly weaponMountLocal: Vec3;

  control: BotControl = neutralControl();

  /** Signed rotor speed about its own axis, rad/s. */
  weaponOmega = 0;
  /** Rotor speed at the start of the current step, for the energy delta. */
  private weaponOmegaPrev = 0;
  /** Energy the rotor gave up this step, joules. Positive means it hit something. */
  weaponEnergyLostJ = 0;
  /** Set while a burst weapon is mid-stroke. */
  burstActive = false;
  private burstTimer = 0;
  private burstCooldown = 0;

  /** Height of the hull's centre above the body origin. */
  readonly hullCenterY: number;
  private readonly halfExtents: Vec3;

  /** Seconds since this robot last moved meaningfully. */
  stillTime = 0;
  /** Set for one tick when the self-righting mechanism fires. */
  justSelfRighted = false;

  constructor(
    private readonly physics: Physics,
    id: string,
    side: 'a' | 'b',
    design: BotDesign,
    spawn: Vec3,
    facing: number,
  ) {
    this.id = id;
    this.side = side;
    this.design = design;
    this.stats = computeStats(design);
    this.health = createHealth(this.stats);

    const { world } = physics;
    const c = this.stats.chassis;
    const wheelRadius = this.stats.drive.wheelRadiusM;

    // The body origin sits on the axle line so the hull can be positioned
    // relative to the wheels by ground clearance alone.
    this.hullCenterY = c.clearance - wheelRadius + c.height / 2;
    this.halfExtents = { x: c.length / 2, y: c.height / 2, z: c.width / 2 };

    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, spawn.y, spawn.z)
        .setRotation(quatY(facing))
        // Real robots on a steel floor coast a long way; a little damping keeps
        // the solver stable without making them feel sticky.
        .setLinearDamping(0.12)
        .setAngularDamping(0.35)
        .setCcdEnabled(true),
    );

    // --- Hull -----------------------------------------------------------------
    // The rotor is a separate body carrying only its own mass, so the weapon's
    // motor, mounting and armour stay with the hull. The two bodies together
    // must come to exactly the design weight.
    const rotorMass = this.stats.weapon.kind === 'none' ? 0 : Math.max(0.5, this.stats.weapon.rotorMassKg);
    const hullMass = Math.max(1, this.stats.totalMassKg - this.stats.wheel.massKg - rotorMass);
    const points = wedgeHullPoints(c.length, c.width, c.height, c.wedge, this.hullCenterY);
    const hullDesc =
      RAPIER.ColliderDesc.convexHull(points) ??
      RAPIER.ColliderDesc.cuboid(c.length / 2, c.height / 2, c.width / 2).setTranslation(
        0,
        this.hullCenterY,
        0,
      );
    hullDesc
      .setMass(hullMass)
      .setFriction(0.35)
      .setRestitution(0.12)
      .setCollisionGroups(GROUPS.hull)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(400);
    this.hullCollider = world.createCollider(hullDesc, this.body);
    physics.register(this.hullCollider, { kind: 'hull', botId: id });

    // --- Wheels ---------------------------------------------------------------
    const wheelCount = this.stats.drive.wheelCount;
    const perSide = wheelCount / 2;
    const wheelWidth = 0.09;
    const wheelMassEach = this.stats.wheel.massKg / wheelCount;
    const zOffset = c.width / 2 - wheelWidth / 2 + 0.015;

    for (let i = 0; i < wheelCount; i++) {
      const sideIndex = Math.floor(i / 2);
      const isLeft = i % 2 === 0;
      // Spread the axles along the wheelbase.
      const t = perSide === 1 ? 0.5 : sideIndex / (perSide - 1);
      const x = (t - 0.5) * c.length * 0.62;

      const local: Vec3 = { x, y: 0, z: isLeft ? zOffset : -zOffset };
      const desc = RAPIER.ColliderDesc.cylinder(wheelWidth / 2, wheelRadius)
        // Cylinders point along Y by default; lay it on its side so the axle
        // runs across the robot.
        .setRotation(quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2))
        .setTranslation(local.x, local.y, local.z)
        .setMass(wheelMassEach)
        // A wheel is a rolling element, not a skid. Contact friction here would
        // fight the drive model — grip is supplied by `applyDrive`, which knows
        // about slip, load transfer and the friction circle. Leaving contact
        // friction on as well would simply glue the robot to the floor.
        .setFriction(0.02)
        .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
        .setRestitution(0.05)
        .setCollisionGroups(GROUPS.hull)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(400);
      const collider = world.createCollider(desc, this.body);
      physics.register(collider, { kind: 'wheel', botId: id, index: i });

      this.wheels.push({
        local,
        radius: wheelRadius,
        side: isLeft ? 'left' : 'right',
        collider,
        grounded: false,
        contact: { x: 0, y: 0, z: 0 },
        spin: 0,
        slip: 0,
      });
    }

    // --- Weapon ---------------------------------------------------------------
    this.weaponAxisLocal = spinAxisFor(this.stats);
    this.weaponMountLocal = mountPointFor(this.stats, this.hullCenterY);
    if (this.stats.weapon.kind !== 'none') {
      this.buildWeapon(spawn, facing);
    }
  }

  private buildWeapon(spawn: Vec3, facing: number): void {
    const { world } = this.physics;
    const w = this.stats.weapon;
    const rot = quatY(facing);
    const mountWorld = rotateVec(rot, this.weaponMountLocal);

    this.weaponBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x + mountWorld.x, spawn.y + mountWorld.y, spawn.z + mountWorld.z)
        .setRotation(rot)
        .setAngularDamping(0.02)
        .setLinearDamping(0.0)
        .setCcdEnabled(true),
    );

    // Shape the rotor so it looks and collides like what it is.
    let desc: RAPIER.ColliderDesc;
    switch (w.kind) {
      case 'horizontal-spinner':
        // A bar lying across the robot, sweeping horizontally.
        desc = RAPIER.ColliderDesc.cuboid(0.055, 0.055, w.radiusM);
        break;
      case 'vertical-spinner':
        desc = RAPIER.ColliderDesc.cylinder(0.035, w.radiusM).setRotation(
          quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
        );
        break;
      case 'drum':
        desc = RAPIER.ColliderDesc.cylinder(this.stats.chassis.width * 0.36, w.radiusM).setRotation(
          quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
        );
        break;
      case 'saw':
        desc = RAPIER.ColliderDesc.cylinder(0.02, w.radiusM).setRotation(
          quatFromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI / 2),
        );
        break;
      default:
        // Arms: a plate reaching out from the pivot.
        desc = RAPIER.ColliderDesc.cuboid(w.radiusM / 2, 0.035, this.stats.chassis.width * 0.36)
          .setTranslation(w.radiusM / 2, 0, 0);
        break;
    }

    const rotorMass = Math.max(0.5, w.rotorMassKg);
    const inertia = this.stats.rotorInertia > 0 ? this.stats.rotorInertia : rotorMass * 0.05;
    // Pin the rotor's inertia to the figure the design maths quoted, so the
    // energy the HUD advertises is exactly the energy the solver stores.
    const principal = principalInertiaFor(this.weaponAxisLocal, inertia);
    desc
      .setMassProperties(rotorMass, { x: 0, y: 0, z: 0 }, principal, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.25)
      .setRestitution(0.35)
      .setCollisionGroups(GROUPS.weapon)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(250);

    const collider = world.createCollider(desc, this.weaponBody);
    this.physics.register(collider, { kind: 'weapon', botId: this.id });

    const jointData = RAPIER.JointData.revolute(
      this.weaponMountLocal,
      { x: 0, y: 0, z: 0 },
      this.weaponAxisLocal,
    );

    const isBurst = w.burstJ > 0;
    if (isBurst) {
      const { rest, extended } = burstLimits(this.stats);
      jointData.limitsEnabled = true;
      jointData.limits = [Math.min(rest, extended) - 0.05, Math.max(rest, extended) + 0.05];
    }

    const joint = world.createImpulseJoint(
      jointData,
      this.body,
      this.weaponBody,
      true,
    ) as RAPIER.RevoluteImpulseJoint;
    // The rotor lives inside the robot's own outline; without this the solver
    // fights itself trying to push them apart.
    joint.setContactsEnabled(false);
    joint.configureMotorModel(RAPIER.MotorModel.ForceBased);
    this.weaponJoint = joint;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  get position(): Vec3 {
    return this.body.translation() as Vec3;
  }

  get rotation(): RAPIER.Rotation {
    return this.body.rotation();
  }

  /** Ground speed in m/s. */
  get speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.z);
  }

  /** The chassis' own up axis, in world space. */
  get upVector(): Vec3 {
    return rotateVec(this.rotation, { x: 0, y: 1, z: 0 });
  }

  /** The chassis' forward axis, in world space. */
  get forwardVector(): Vec3 {
    return rotateVec(this.rotation, { x: 1, y: 0, z: 0 });
  }

  get isUpsideDown(): boolean {
    return this.upVector.y < -0.25;
  }

  get immobilised(): boolean {
    if (isImmobilised(this.health)) return true;
    // A robot that cannot get a wheel on the floor is just as stuck.
    if (this.isUpsideDown && !this.stats.invertible) return true;
    return false;
  }

  get destroyed(): boolean {
    return this.health.structure <= 0;
  }

  get weaponDead(): boolean {
    return isWeaponDead(this.health);
  }

  /** Rotor speed as a fraction of its rated maximum, 0..1. */
  get weaponSpinFraction(): number {
    const max = rpmToRadPerSec(this.stats.weapon.rpm);
    if (max <= 0) return this.burstActive ? 1 : 0;
    return clamp01(Math.abs(this.weaponOmega) / max);
  }

  /** Current stored energy in the rotor, joules. */
  get weaponStoredEnergyJ(): number {
    if (this.stats.weapon.burstJ > 0) return this.burstCooldown <= 0 ? this.stats.weapon.burstJ : 0;
    return 0.5 * this.stats.rotorInertia * this.weaponOmega * this.weaponOmega;
  }

  /** True when a burst weapon is charged and ready. */
  get burstReady(): boolean {
    return this.stats.weapon.burstJ > 0 && this.burstCooldown <= 0 && !this.burstActive;
  }

  /** Fraction of the burst weapon's recharge that has completed, 0..1. */
  get burstCharge(): number {
    if (this.stats.weapon.cycleTime <= 0) return 1;
    return clamp01(1 - this.burstCooldown / this.stats.weapon.cycleTime);
  }

  // -------------------------------------------------------------------------
  // Per-step simulation
  // -------------------------------------------------------------------------

  /** Called immediately before each physics step. */
  preStep(dt: number, live: boolean): void {
    this.justSelfRighted = false;
    this.weaponOmegaPrev = this.weaponOmega;

    // Rapier keeps forces applied until they are explicitly cleared, so every
    // step has to start from zero or the drive force compounds without bound.
    this.body.resetForces(false);
    this.body.resetTorques(false);

    if (!live) {
      // Between rounds the robots are inert but still solid.
      this.driveWeapon(dt, 0, false);
      return;
    }

    this.updateGroundContacts();
    this.applyDrive(dt);
    this.driveWeapon(dt, this.control.weapon, this.control.fire);
    this.applySelfRight();

    // Track how long it has been sitting still, for the referee's count.
    if (this.speed < 0.3 && Math.abs(this.body.angvel().y) < 0.5) this.stillTime += dt;
    else this.stillTime = 0;
  }

  /** Called immediately after each physics step. */
  postStep(): void {
    if (this.weaponBody && this.stats.weapon.kind !== 'none') {
      const axisWorld = rotateVec(this.rotation, this.weaponAxisLocal);
      const relative = sub(this.weaponBody.angvel() as Vec3, this.body.angvel() as Vec3);
      this.weaponOmega = dot(relative, axisWorld);

      // Energy the rotor shed this step. The solver takes it out of the rotor
      // when the rotor hits something, so this is a direct measurement of how
      // much of the weapon's stored energy went into the target.
      const before = 0.5 * this.stats.rotorInertia * this.weaponOmegaPrev * this.weaponOmegaPrev;
      const after = 0.5 * this.stats.rotorInertia * this.weaponOmega * this.weaponOmega;
      this.weaponEnergyLostJ = Math.max(0, before - after);
    } else {
      this.weaponEnergyLostJ = 0;
    }

    // Roll the wheel meshes at whatever speed the chassis is actually moving.
    const forward = this.forwardVector;
    const v = this.body.linvel() as Vec3;
    const forwardSpeed = dot(v, forward);
    for (const wheel of this.wheels) {
      wheel.spin += (forwardSpeed / wheel.radius) * (1 / 240);
    }
  }

  // -------------------------------------------------------------------------
  // Drivetrain
  // -------------------------------------------------------------------------

  private updateGroundContacts(): void {
    const rot = this.rotation;
    const pos = this.position;

    for (const wheel of this.wheels) {
      const world = rotateVec(rot, wheel.local);
      const origin = { x: pos.x + world.x, y: pos.y + world.y, z: pos.z + world.z };
      // Straight down in world space: a robot lying on its back still needs to
      // know whether its wheels can touch anything.
      const ray = new RAPIER.Ray(origin, { x: 0, y: -1, z: 0 });
      const maxToi = wheel.radius + 0.08;
      const hit = this.physics.world.castRay(
        ray,
        maxToi,
        true,
        undefined,
        undefined,
        undefined,
        this.body,
      );

      if (hit) {
        wheel.grounded = true;
        wheel.contact = { x: origin.x, y: origin.y - hit.timeOfImpact, z: origin.z };
      } else {
        wheel.grounded = false;
        wheel.slip = 0;
      }
    }
  }

  private applyDrive(dt: number): void {
    void dt;
    const grounded = this.wheels.filter((w, i) => w.grounded && (this.health.wheels[i] ?? 0) > 0);
    if (grounded.length === 0) return;

    const mass = this.body.mass();
    const normalLoadPerWheel = (mass * 9.81) / grounded.length;
    const grip = this.stats.wheel.grip;

    // Ground plane basis. Forward is the chassis' nose flattened onto the floor;
    // when the robot is upside down and invertible the driver flips the sticks,
    // so the controls stay intuitive either way.
    const flipped = this.isUpsideDown && this.stats.invertible;
    let forward = this.forwardVector;
    forward = normalize({ x: forward.x, y: 0, z: forward.z });
    if (vlen(forward) < 1e-4) forward = { x: 1, y: 0, z: 0 };
    const right = { x: -forward.z, y: 0, z: forward.x };

    const throttle = clamp(this.control.throttle, -1, 1);
    const steer = clamp(this.control.steer, -1, 1) * (flipped ? -1 : 1);

    // How much of the drive is still connected. Losing wheels costs real speed.
    const driveHealth = driveFraction(this.health);
    const maxForceTotal = this.stats.pushForceN * driveHealth;

    const v = this.body.linvel() as Vec3;
    const forwardSpeed = dot(v, forward);
    // Back the motors off as the robot approaches its top speed, the way a real
    // motor runs out of headroom against back-EMF.
    const speedFraction = clamp01(Math.abs(forwardSpeed) / Math.max(this.stats.topSpeedMps, 0.1));
    const governor = clamp01(1 - speedFraction * speedFraction * 0.92);

    for (const wheel of grounded) {
      const sideSign = wheel.side === 'left' ? 1 : -1;
      // Skid steer: one side speeds up, the other slows down.
      const sideThrottle = clamp(throttle - steer * sideSign * this.stats.drive.agility * 0.75, -1.4, 1.4);

      const contactVel = pointVelocity(this.body, wheel.contact);
      const lateralSpeed = dot(contactVel, right);
      const longSpeed = dot(contactVel, forward);

      let desiredLong: number;
      if (Math.abs(sideThrottle) < 0.05) {
        // Off the throttle, a combat robot is not coasting: the motors are
        // shorted through the controller and it brakes hard. Without this the
        // rolling wheels would let it slide forever.
        desiredLong = -longSpeed * normalLoadPerWheel * 0.5;
      } else {
        desiredLong = sideThrottle * (maxForceTotal / grounded.length) * governor;
      }

      // Lateral grip resists sideways scrub. Skid-steer robots need this to be
      // firm or they slide about like they are on ice.
      const desiredLat = -lateralSpeed * normalLoadPerWheel * 0.55;

      // Friction circle: the tyre only has so much to give in total.
      const capacity = grip * normalLoadPerWheel;
      let fLong = desiredLong;
      let fLat = clamp(desiredLat, -capacity, capacity);
      const magnitude = Math.hypot(fLong, fLat);
      if (magnitude > capacity && magnitude > 1e-6) {
        const k = capacity / magnitude;
        fLong *= k;
        fLat *= k;
        wheel.slip = clamp01((magnitude / capacity - 1) * 0.8);
      } else {
        wheel.slip = 0;
      }

      const force: Vec3 = {
        x: forward.x * fLong + right.x * fLat,
        y: 0,
        z: forward.z * fLong + right.z * fLat,
      };
      // Applying at the contact patch, not the centre of mass, is what gives
      // wheelies under power and weight transfer under braking.
      this.body.addForceAtPoint(force, wheel.contact, true);
    }
  }

  // -------------------------------------------------------------------------
  // Weapon
  // -------------------------------------------------------------------------

  private driveWeapon(dt: number, throttle: number, fire: boolean): void {
    const joint = this.weaponJoint;
    if (!joint || !this.weaponBody) return;

    const w = this.stats.weapon;
    const dead = this.weaponDead;

    if (this.burstCooldown > 0) this.burstCooldown = Math.max(0, this.burstCooldown - dt);

    if (w.burstJ > 0) {
      // --- Flipper / hammer / lifter / crusher --------------------------------
      const { rest, extended } = burstLimits(this.stats);

      if (fire && this.burstReady && !dead) {
        this.burstActive = true;
        this.burstTimer = 0;
      }

      if (this.burstActive) {
        this.burstTimer += dt;
        // Stroke out hard, then return under a gentler spring.
        const strokeTime = w.kind === 'hammer' ? 0.16 : 0.12;
        if (this.burstTimer <= strokeTime) {
          // Torque needed to deliver the rated energy over the stroke.
          const travel = Math.abs(extended - rest);
          const torque = travel > 1e-3 ? w.burstJ / travel : w.burstJ;
          joint.setMotorMaxForce(torque);
          joint.configureMotorPosition(extended, torque * 12, torque * 0.6);
        } else {
          joint.setMotorMaxForce(w.powerW * 0.9);
          joint.configureMotorPosition(rest, w.powerW * 1.4, w.powerW * 0.5);
          if (this.burstTimer >= strokeTime + w.cycleTime * 0.35) {
            this.burstActive = false;
            this.burstTimer = 0;
            this.burstCooldown = w.cycleTime;
          }
        }
      } else {
        // Hold the arm at rest.
        const hold = dead ? 220 : 2400;
        joint.setMotorMaxForce(hold);
        joint.configureMotorPosition(rest, hold, hold * 0.35);
      }
      return;
    }

    // --- Spinner ---------------------------------------------------------------
    const maxOmega = rpmToRadPerSec(w.rpm);
    if (maxOmega <= 0) return;

    const demand = dead ? 0 : clamp01(throttle);
    const target = maxOmega * demand;

    // Torque available from a real motor falls as it speeds up: T = P / omega,
    // clamped to a stall figure so it is finite at rest.
    const omega = Math.abs(this.weaponOmega);
    const stallOmega = Math.max(maxOmega * 0.12, 1);
    const torque = (w.powerW * 0.85) / Math.max(omega, stallOmega);

    joint.setMotorMaxForce(dead ? 0 : torque);
    // The second argument is the servo's gain, not a brake. It has to be large
    // enough that the motor asks for its full torque whenever the rotor is off
    // target; `setMotorMaxForce` above is what actually limits the output, and
    // that limit is where the real motor curve lives.
    joint.configureMotorVelocity(target, dead ? 0 : Math.max(torque, 1));
  }

  private applySelfRight(): void {
    if (!this.control.selfRight) return;
    if (!this.isUpsideDown) return;
    if (!this.design.srimech) return;

    // A stiff arm punching the floor. The impulse is sized from the energy
    // actually needed to roll the robot over its own edge — about m*g*h for a
    // half-width lift — rather than picked to look dramatic, which would fire
    // it across the arena.
    const axis = this.forwardVector;
    const strength = this.body.mass() * 0.7;
    this.body.applyTorqueImpulse(scale(axis, strength), true);
    this.body.applyImpulseAtPoint(
      { x: 0, y: this.body.mass() * 1.1, z: 0 },
      this.position,
      true,
    );
    this.justSelfRighted = true;
    this.control.selfRight = false;
  }

  // -------------------------------------------------------------------------
  // Damage
  // -------------------------------------------------------------------------

  /**
   * Work out which armour zone a world-space point lands on, by transforming it
   * into the chassis frame and finding the dominant face.
   */
  zoneAt(worldPoint: Vec3): ArmorZone {
    const local = rotateVecInverse(this.rotation, sub(worldPoint, this.position));
    const nx = local.x / Math.max(this.halfExtents.x, 1e-3);
    const ny = (local.y - this.hullCenterY) / Math.max(this.halfExtents.y, 1e-3);
    const nz = local.z / Math.max(this.halfExtents.z, 1e-3);

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    if (ax >= ay && ax >= az) return nx >= 0 ? 'front' : 'rear';
    if (az >= ay) return nz >= 0 ? 'left' : 'right';
    return ny >= 0 ? 'top' : 'bottom';
  }

  /** Index of the wheel nearest a world point, or -1 if none is close. */
  nearestWheel(worldPoint: Vec3): number {
    const local = rotateVecInverse(this.rotation, sub(worldPoint, this.position));
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const d = Math.hypot(local.x - w.local.x, local.y - w.local.y, local.z - w.local.z);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return bestDist < this.stats.drive.wheelRadiusM * 1.6 ? best : -1;
  }

  takeHit(hit: Hit, rng: Rng): DamageResult {
    return applyHit(this.health, this.stats, hit, rng);
  }

  /**
   * Move the robot to a new pose without touching its damage or its weapon.
   *
   * The rotor has to be moved to wherever the joint anchor now is, computed
   * from the *new* orientation. Translating it by the chassis' delta is not
   * enough — if the chassis also rotated, the anchor moves by a different
   * amount and the joint is left violated, which the solver corrects by firing
   * the robot across the arena.
   */
  teleport(position: Vec3, facing: number, keepWeaponSpin = true): void {
    const rot = quatY(facing);
    this.body.setTranslation(position, true);
    this.body.setRotation(rot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);

    if (this.weaponBody) {
      const anchor = rotateVec(rot, this.weaponMountLocal);
      const spin = keepWeaponSpin ? this.weaponBody.angvel() : { x: 0, y: 0, z: 0 };
      this.weaponBody.setTranslation(
        { x: position.x + anchor.x, y: position.y + anchor.y, z: position.z + anchor.z },
        true,
      );
      this.weaponBody.setRotation(rot, true);
      this.weaponBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.weaponBody.setAngvel(spin, true);
    }
  }

  /** Put the robot back in its starting square, undamaged. */
  reset(spawn: Vec3, facing: number): void {
    this.teleport(spawn, facing, false);
    this.health = createHealth(this.stats);
    this.control = neutralControl();
    this.weaponOmega = 0;
    this.weaponOmegaPrev = 0;
    this.weaponEnergyLostJ = 0;
    this.burstActive = false;
    this.burstTimer = 0;
    this.burstCooldown = 0;
    this.stillTime = 0;
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Quaternion for a yaw about the world Y axis. */
export function quatY(angle: number): RAPIER.Rotation {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}

export function quatFromAxisAngle(axis: Vec3, angle: number): RAPIER.Rotation {
  const h = angle / 2;
  const s = Math.sin(h);
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) };
}

/**
 * Eight points describing a box whose front face is cut back into a wedge.
 * `wedge` of 0 leaves a plain brick; 1 brings the front down to a thin lip.
 */
export function wedgeHullPoints(
  length: number,
  width: number,
  height: number,
  wedge: number,
  centerY: number,
): Float32Array {
  const hx = length / 2;
  const hz = width / 2;
  const bottom = centerY - height / 2;
  const top = centerY + height / 2;
  // The nose keeps at least a 15 mm lip so the hull never degenerates.
  const noseTop = bottom + Math.max(0.015, height * (1 - clamp01(wedge) * 0.9));

  const pts: number[] = [];
  const push = (x: number, y: number, z: number) => pts.push(x, y, z);

  // Rear face, full height.
  push(-hx, bottom, -hz);
  push(-hx, bottom, hz);
  push(-hx, top, -hz);
  push(-hx, top, hz);
  // Front face, cut down to the wedge.
  push(hx, bottom, -hz);
  push(hx, bottom, hz);
  push(hx, noseTop, -hz);
  push(hx, noseTop, hz);

  return new Float32Array(pts);
}

/**
 * Principal moments for a rotor, given which local axis it spins about and the
 * inertia the design maths expects about that axis.
 */
function principalInertiaFor(axis: Vec3, spinInertia: number): Vec3 {
  const cross = Math.max(spinInertia * 0.5, 1e-4);
  if (Math.abs(axis.y) > 0.5) return { x: cross, y: spinInertia, z: cross };
  if (Math.abs(axis.x) > 0.5) return { x: spinInertia, y: cross, z: cross };
  return { x: cross, y: cross, z: spinInertia };
}
