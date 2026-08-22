/**
 * A fighting machine: a Rapier rig, a Three.js machine, and the control logic
 * that ties them together.
 *
 * Design notes that matter for how this feels:
 *
 * - The drivetrain is a raycast vehicle with no steering angle. Both sides get
 *   independent engine force, which is exactly how a real combat robot skid-steers.
 * - The weapon is a genuine rigid body on a motorised revolute joint, not an
 *   animation. Its angular momentum, its gyroscopic resistance to turning, the
 *   way a hit slows it down and throws both machines apart — all of that falls
 *   out of the solver rather than being scripted.
 * - Losing a wheel really removes its engine force and collapses its suspension,
 *   so a damaged bot drags itself around a circle the way a damaged bot should.
 */

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { MAX_SIMULABLE_OMEGA, type PhysicsWorld } from '../physics/world.ts';
import { bodyGroups, weaponGroups } from '../physics/groups.ts';
import { buildBotVisual, wedgeDimensions, type BotVisual } from '../render/botMesh.ts';
import { BotDamage, type ArmorFace } from './damage.ts';
import { computeStats, type BotDesign, type DerivedStats } from './design.ts';
import { DRIVETRAIN_EFFICIENCY } from './design.ts';
import { driveLayout, rotorInertiaTensor, type WeaponSpec } from './parts.ts';
import { clamp, clamp01, damp } from '../core/mathx.ts';

export interface BotInput {
  /** -1 (reverse) to +1 (forward). */
  throttle: number;
  /** -1 (left) to +1 (right). */
  steer: number;
  /** Weapon spun up / actuator held. */
  weapon: boolean;
  /** Rising edge: fire a flipper, swing a hammer, close a jaw. */
  fire: boolean;
  /** Rising edge: deploy the self-righting arm. */
  selfRight: boolean;
}

export const NEUTRAL_INPUT: BotInput = {
  throttle: 0,
  steer: 0,
  weapon: false,
  fire: false,
  selfRight: false,
};

/** How far the wheel hangs below its hard point at rest. */
const SUSPENSION_REST = 0.04;
const SUSPENSION_TRAVEL = 0.03;

/**
 * How far the suspension is allowed to settle under the machine's own weight.
 *
 * Rapier's raycast suspension produces a static compression of `g / (n * k)`,
 * where `n` is the number of wheels sharing the load and `k` the per-wheel
 * stiffness. That expression has no mass in it, so a single hard-coded `k` gives
 * a two-wheel machine twice the sag of a four-wheel one — and at k = 90 that sag
 * (54 mm on two wheels) is larger than any chassis' ground clearance, which
 * parks every frame on its belly with the wheels hanging in the air. Solving for
 * `k` from the sag we actually want keeps the ride height correct on 2, 4 and 6
 * wheels alike, exactly as a real builder picks springs to suit the corner load.
 */
const SUSPENSION_SAG = 0.005;

/** How close counts as being in a position to use your weapon, metres. */
const CONTROL_RANGE = 2.6;

/** Hard ceiling on how fast the frame itself may tumble, rad/s. */
const MAX_CHASSIS_OMEGA = 30;

/** Lateral grip of a driven wheel, as a fraction of its forward grip. */
const SIDE_FRICTION = 0.06;


/**
 * A torn-off wheel leaves its hub behind. The corner drops a little and skids on
 * bare metal — it must NOT collapse onto the frame, or the chassis grounds out on
 * the floor and the whole machine is anchored in place instead of limping.
 */
const DEAD_WHEEL_RADIUS_SCALE = 0.72;
/** Bare hub on steel: almost no grip, which is what makes a damaged bot circle. */
const DEAD_WHEEL_GRIP = 0.12;

export interface PartRef {
  bot: Bot;
  partId: string;
  face?: ArmorFace;
  /** True for the weapon's own colliders — these deal damage rather than take it. */
  isWeapon: boolean;
}

let nextBotId = 1;

export class Bot {
  readonly id = nextBotId++;
  readonly design: BotDesign;
  readonly stats: DerivedStats;
  readonly team: 0 | 1;
  readonly damage: BotDamage;
  /** Null when the bot is built headless, e.g. inside a physics test. */
  readonly visual: BotVisual | null;

  readonly chassis: RAPIER.RigidBody;
  readonly weaponBody: RAPIER.RigidBody | null = null;
  private weaponJoint: RAPIER.ImpulseJoint | null = null;
  private vehicle: RAPIER.DynamicRayCastVehicleController;

  /** Every collider this bot owns, so impacts can be attributed to a part. */
  readonly colliderParts = new Map<number, PartRef>();

  private input: BotInput = { ...NEUTRAL_INPUT };
  private prevFire = false;
  private prevSelfRight = false;

  private world: PhysicsWorld;
  private wheelDead: boolean[] = [];
  private wheelRestRadius: number[] = [];
  private wheelSpin: number[] = [];
  /** Body-frame height of the suspension hard points the right way up. */
  private hardPointY = 0;

  /** Live weapon spin, radians per second, signed. */
  private _omega = 0;
  private _inverted = false;
  private invertedDriveSign = 1;

  private actuatorTimer = 0;
  private actuatorShotsLeft: number;
  private actuatorTarget = 0;
  private srimechCooldown = 0;

  /** Running match statistics, consumed by the judges. */
  aggression = 0;
  control = 0;
  damageDealt = 0;
  /**
   * The machine on the other side of the box, set by `Combat` when it joins.
   *
   * Judging needs it: aggression and control are both about what you are doing to
   * *them*, and without a reference they could only ever measure what the driver
   * was doing on their own.
   */
  opponent: Bot | null = null;

  private tmpVec = new THREE.Vector3();
  private tmpVec2 = new THREE.Vector3();
  private tmpVec3 = new THREE.Vector3();
  private tmpQuat = new THREE.Quaternion();

  constructor(options: {
    world: PhysicsWorld;
    design: BotDesign;
    team: 0 | 1;
    position: { x: number; y: number; z: number };
    facing: number;
    /** Skip all Three.js construction — for physics tests and server-side sims. */
    headless?: boolean;
  }) {
    const { world, design, team, position, facing } = options;
    this.world = world;
    this.design = design;
    this.team = team;
    this.stats = computeStats(design);
    this.damage = new BotDamage(this.stats);
    this.visual = options.headless ? null : buildBotVisual(design, this.stats, team);

    const { chassis: chassisSpec, weapon, wheel } = this.stats.parts;
    this.actuatorShotsLeft = weapon.actuator?.shots ?? 0;

    const rapierWorld = world.world;

    // --- Chassis body ----------------------------------------------------
    const spawnY = position.y + chassisSpec.height / 2 + chassisSpec.groundClearance;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, spawnY, position.z)
      .setRotation(quatFromYaw(facing))
      .setLinearDamping(0.08)
      .setAngularDamping(0.22)
      .setCcdEnabled(true);
    this.chassis = rapierWorld.createRigidBody(bodyDesc);

    const groups = bodyGroups(team);
    const hasWedge =
      weapon.kind === 'wedge' || this.stats.parts.accessories.includes('forks');
    /*
     * The frame plus its armour: most of the mass, centred on the body.
     *
     * Everything that is modelled as its own collider or its own rigid body has to
     * come *out* of here, or the machine the solver simulates is heavier than the
     * machine the builder weighed against the 250 lb limit — by up to 9.7 kg for
     * an actuator weapon with a wedge, which is a whole armour package of cheating.
     * `computeStats().totalMass` is the contract; these deductions are what keep
     * the sum of every collider equal to it. (The rotor's mass is not deducted:
     * `stats.rotorMassKg` is a separate line in the builder's total and lives on
     * the weapon body.)
     */
    const wedgeletMass = this.stats.parts.accessories.includes('wedgelets') ? 1.2 : 0;
    const hullMass = Math.max(
      1,
      chassisSpec.frameMass +
        this.stats.armorMass +
        weapon.mountMass -
        actuatorMovingMass(weapon) -
        wedgeletMass -
        (hasWedge ? WEDGE_COLLIDER_MASS : 0),
    );
    const hull = RAPIER.ColliderDesc.roundCuboid(
      chassisSpec.width / 2 - 0.01,
      chassisSpec.height / 2 - 0.01,
      chassisSpec.length / 2 - 0.01,
      0.01,
    )
      .setMass(hullMass)
      .setFriction(this.stats.parts.armor.friction)
      .setRestitution(this.stats.parts.armor.restitution)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Average)
      .setCollisionGroups(groups)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(900);
    const hullCollider = rapierWorld.createCollider(hull, this.chassis);
    this.colliderParts.set(hullCollider.handle, {
      bot: this,
      partId: 'frame',
      isWeapon: false,
    });

    // Batteries, motors and gearboxes all live on the floor of a real bot. Putting
    // that mass in a low, flat collider drops the centre of gravity where it belongs.
    const ballastMass = this.stats.driveMass + this.stats.electronicsMass + this.stats.accessoryMass;
    const ballast = RAPIER.ColliderDesc.cuboid(
      chassisSpec.width * 0.4,
      0.022,
      chassisSpec.length * 0.4,
    )
      .setTranslation(0, -chassisSpec.height / 2 + 0.03, 0)
      .setMass(Math.max(0.5, ballastMass))
      .setFriction(0.5)
      .setCollisionGroups(groups);
    const ballastCollider = rapierWorld.createCollider(ballast, this.chassis);
    this.colliderParts.set(ballastCollider.handle, {
      bot: this,
      partId: 'frame',
      isWeapon: false,
    });

    // A front wedge is a real, load-bearing part of the machine.
    if (hasWedge) {
      const wedgeDesc = RAPIER.ColliderDesc.convexHull(wedgeHullPoints(chassisSpec))!;
      if (wedgeDesc) {
        wedgeDesc
          /*
           * Lifted clear of the wheel contact line at rest.
           *
           * A wedge is a third rigid contact point *ahead* of the front wheels, so
           * sitting it flush with the chassis floor levered the machine's weight
           * off its tyres: measured, Doorstop's wheels carried 0% of its weight
           * and Trebuchet's 37%, which left both with no traction to drive or turn
           * with. Set so the lip skims a few millimetres above the floor and only
           * bites when the machine pitches into it or rides up on something —
           * which is when a wedge is supposed to be doing its work.
           */
          .setTranslation(
            0,
            -chassisSpec.height / 2 + chassisSpec.groundClearance * 0.8,
            chassisSpec.length / 2 - 0.01,
          )
          .setMass(WEDGE_COLLIDER_MASS)
          // Ground-scraping forks are polished titanium sliding on steel. They have
          // to be genuinely slippery: give them tyre-like grip and the machine
          // anchors itself on its own wedge and can barely turn.
          .setFriction(0.08)
          .setRestitution(0.15)
          .setCollisionGroups(groups)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(900);
        const wedgeCollider = rapierWorld.createCollider(wedgeDesc, this.chassis);
        this.colliderParts.set(wedgeCollider.handle, {
          bot: this,
          partId: 'armor-front',
          face: 'front',
          isWeapon: false,
        });
      }
    }

    /*
     * Hinged wedgelets: two low ramps at the front corners.
     *
     * These were drawn and never built. The accessory added 4.6 kg and a pair of
     * meshes, and the solver saw nothing at all — so the part that exists to stop
     * an opponent getting under your corners did not stop anything. Slippery for
     * the same reason the main wedge is: a ground-scraping ramp with tyre grip
     * anchors the machine on its own hardware.
     */
    if (this.stats.parts.accessories.includes('wedgelets')) {
      const rampWidth = chassisSpec.width * 0.26;
      const rampLength = chassisSpec.length * 0.16;
      for (const side of [-1, 1]) {
        const ramp = RAPIER.ColliderDesc.cuboid(rampWidth / 2, 0.006, rampLength / 2)
          .setTranslation(
            side * (chassisSpec.width / 2 - rampWidth / 2),
            -chassisSpec.height / 2 - chassisSpec.groundClearance * 0.45,
            chassisSpec.length / 2 - rampLength / 2,
          )
          .setRotation(quatFromAxisAngle(1, 0, 0, -0.28))
          .setMass(0.6)
          .setFriction(0.1)
          .setRestitution(0.12)
          .setCollisionGroups(groups)
          .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
          .setContactForceEventThreshold(900);
        const rampCollider = rapierWorld.createCollider(ramp, this.chassis);
        this.colliderParts.set(rampCollider.handle, {
          bot: this,
          partId: 'armor-front',
          face: 'front',
          isWeapon: false,
        });
      }
    }

    // --- Drivetrain ------------------------------------------------------
    this.vehicle = rapierWorld.createVehicleController(this.chassis);
    this.vehicle.indexUpAxis = 1;
    this.vehicle.setIndexForwardAxis = 2;

    const { halfTrack, wheelLocalY, rowZ } = driveLayout(chassisSpec, wheel);
    const hardPointY = wheelLocalY + SUSPENSION_REST;
    this.hardPointY = hardPointY;
    // Springs sized for the corner load, not a magic number. See SUSPENSION_SAG.
    const suspensionStiffness = 9.81 / (chassisSpec.wheelCount * SUSPENSION_SAG);

    for (let i = 0; i < chassisSpec.wheelCount; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const z = rowZ[Math.floor(i / 2)]!;
      this.vehicle.addWheel(
        { x: side * halfTrack, y: hardPointY, z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        SUSPENSION_REST,
        wheel.radius,
      );
      // Combat robots run essentially rigid: stiff springs, almost no travel.
      this.vehicle.setWheelSuspensionStiffness(i, suspensionStiffness);
      this.vehicle.setWheelSuspensionCompression(i, 3.6);
      this.vehicle.setWheelSuspensionRelaxation(i, 2.8);
      this.vehicle.setWheelMaxSuspensionTravel(i, SUSPENSION_TRAVEL);
      this.vehicle.setWheelMaxSuspensionForce(i, 60_000);
      this.vehicle.setWheelFrictionSlip(i, wheel.grip);
      // Skid steer lives or dies on lateral scrub. A polished steel floor gives a
      // rubber wheel very little sideways bite, and that is exactly what lets a
      // four-wheel bot spin on the spot instead of ploughing forward.
      this.vehicle.setWheelSideFrictionStiffness(i, SIDE_FRICTION);
      this.wheelDead.push(false);
      this.wheelRestRadius.push(wheel.radius);
      this.wheelSpin.push(0);
    }

    // --- Weapon ----------------------------------------------------------
    if (weapon.rotor || weapon.actuator || weapon.clamp) {
      const mount = chassisSpec.weaponMount;
      const world0 = new THREE.Vector3(mount.x, mount.y, mount.z)
        .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing))
        .add(new THREE.Vector3(position.x, spawnY, position.z));

      const weaponDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(world0.x, world0.y, world0.z)
        .setRotation(quatFromYaw(facing))
        .setAngularDamping(weapon.rotor ? 0.02 : 0.6)
        .setCcdEnabled(true);
      this.weaponBody = rapierWorld.createRigidBody(weaponDesc);

      const wGroups = weaponGroups(team);
      const weaponColliders = weaponColliderDescs(this.stats);
      for (const desc of weaponColliders) {
        desc
          .setCollisionGroups(wGroups)
          .setFriction(this.stats.parts.weaponMaterial.friction)
          .setRestitution(this.stats.parts.weaponMaterial.restitution)
          .setActiveEvents(
            RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS,
          )
          .setContactForceEventThreshold(600);
        const collider = rapierWorld.createCollider(desc, this.weaponBody);
        this.colliderParts.set(collider.handle, {
          bot: this,
          partId: 'weapon',
          isWeapon: true,
        });
      }

      const axis = weapon.rotor?.axis ?? 'x';
      const axisVec =
        axis === 'y' ? { x: 0, y: 1, z: 0 } : axis === 'z' ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const jointData = RAPIER.JointData.revolute(mount, { x: 0, y: 0, z: 0 }, axisVec);
      this.weaponJoint = rapierWorld.createImpulseJoint(
        jointData,
        this.chassis,
        this.weaponBody,
        true,
      );
      const revolute = this.weaponJoint as RAPIER.RevoluteImpulseJoint;
      revolute.configureMotorModel(RAPIER.MotorModel.ForceBased);
      if (weapon.actuator || weapon.clamp) {
        // Arms have end stops; rotors do not.
        revolute.setLimits(-0.05, weapon.actuator?.sweep ?? 1.2);
      }
    }

    if (this.visual) {
      this.visual.root.position.set(position.x, spawnY, position.z);
      this.visual.root.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), facing);
    }
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  get name(): string {
    return this.design.name;
  }

  get omega(): number {
    return this._omega;
  }

  get inverted(): boolean {
    return this._inverted;
  }

  /**
   * Moment of inertia the solver is actually using about the spin axis, kg·m².
   *
   * `principalInertia()` is expressed in the body's *principal* frame, which is
   * not the body frame whenever a collider is rotated. Projecting the spin axis
   * into that frame first is the difference between reading a disc's real
   * inertia and reading its transverse inertia — a factor of two in every
   * energy number downstream.
   */
  get weaponInertia(): number {
    if (!this.weaponBody) return 0;
    const axis = this.stats.parts.weapon.rotor?.axis ?? 'x';
    const inertia = this.weaponBody.principalInertia();
    const frame = this.weaponBody.principalInertiaLocalFrame();

    const local = this.tmpVec.set(
      axis === 'x' ? 1 : 0,
      axis === 'y' ? 1 : 0,
      axis === 'z' ? 1 : 0,
    );
    this.tmpQuat.set(frame.x, frame.y, frame.z, frame.w).invert();
    local.applyQuaternion(this.tmpQuat);

    return (
      inertia.x * local.x * local.x +
      inertia.y * local.y * local.y +
      inertia.z * local.z * local.z
    );
  }

  /** Live stored energy in the weapon, joules. */
  get weaponEnergy(): number {
    return 0.5 * this.weaponInertia * this._omega * this._omega;
  }

  get weaponTipSpeed(): number {
    return Math.abs(this._omega) * (this.stats.parts.weapon.rotor?.radius ?? 0);
  }

  /** Fraction of redline the weapon is currently turning at. */
  get weaponCharge(): number {
    const max = this.stats.weaponMaxOmega;
    return max > 0 ? clamp01(Math.abs(this._omega) / max) : 0;
  }

  get actuatorShots(): number {
    return this.actuatorShotsLeft;
  }

  /**
   * Energy this machine's actuator or clamp can put into a target *right now*.
   *
   * Zero unless the arm is genuinely doing something. Previously the damage path
   * simply read `stats.actuatorEnergy` off the spec sheet, which meant a flipper
   * dealt its full rated charge to anything it brushed against — with the gas
   * bottle empty, with the arm parked, with the driver never having pressed fire.
   * A hammer that has not swung has delivered no work, and a jaw that is not
   * closing is a bracket.
   */
  get actuatorStrikeEnergy(): number {
    const weapon = this.stats.parts.weapon;
    const condition = this.damage.weaponCondition;
    if (condition <= 0.05) return 0;
    if (weapon.clamp) {
      // A crusher bites for as long as the driver holds the jaw shut.
      return this.input.weapon ? this.stats.actuatorEnergy * condition : 0;
    }
    if (!weapon.actuator) return 0;
    // Only while the arm is being driven out: the return stroke is not a strike.
    return this.actuatorTarget > 0 && this.actuatorTimer > 0
      ? this.stats.actuatorEnergy * condition
      : 0;
  }

  get speed(): number {
    const v = this.chassis.linvel();
    return Math.hypot(v.x, v.z);
  }

  position(target = new THREE.Vector3()): THREE.Vector3 {
    const t = this.chassis.translation();
    return target.set(t.x, t.y, t.z);
  }

  /** Unit vector the bot is currently pointing, on the ground plane. */
  forward(target = new THREE.Vector3()): THREE.Vector3 {
    const r = this.chassis.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    return target.set(0, 0, 1).applyQuaternion(this.tmpQuat);
  }

  up(target = new THREE.Vector3()): THREE.Vector3 {
    const r = this.chassis.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    return target.set(0, 1, 0).applyQuaternion(this.tmpQuat);
  }

  setInput(input: Partial<BotInput>): void {
    this.input = { ...this.input, ...input };
  }

  // -------------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------------

  /** Runs inside the fixed step, before the solver. */
  preStep(dt: number): void {
    this.updateInversion();
    this.updateDrive();
    this.updateWeapon(dt);
    /*
     * The suspension rays must not be able to see this machine's own weapon.
     *
     * They are cast straight down from the hard points, and a horizontal rotor
     * spans wider than the wheel track — so as soon as the bar sits at or below
     * the hard point, every wheel starts measuring the ground at the *top of its
     * own blade*. The suspension then reads fully compressed, pushes back at four
     * times the machine's weight, and the whole thing levitates: measured, a
     * discshell climbed steadily to ten metres with both wheels reporting contact.
     * Filtering the ray is the fix; the collision groups already keep the rotor
     * and the frame apart, but a query filter is a separate thing.
     */
    this.vehicle.updateVehicle(dt, undefined, undefined, (collider) =>
      collider.parent()?.handle !== this.weaponBody?.handle,
    );
    this.applyGyroCompensation(dt);

    if (this.srimechCooldown > 0) this.srimechCooldown -= dt;

    this.prevFire = this.input.fire;
    this.prevSelfRight = this.input.selfRight;
  }

  /** Runs inside the fixed step, after the solver. */
  postStep(dt: number): void {
    // Read back the weapon's true angular velocity about its own spin axis.
    if (this.weaponBody && this.stats.parts.weapon.rotor) {
      const axis = this.stats.parts.weapon.rotor.axis;
      const w = this.weaponBody.angvel();
      const r = this.weaponBody.rotation();
      this.tmpQuat.set(r.x, r.y, r.z, r.w);
      const axisWorld = this.tmpVec
        .set(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0)
        .applyQuaternion(this.tmpQuat);
      this._omega = w.x * axisWorld.x + w.y * axisWorld.y + w.z * axisWorld.z;

      // Hard clamp at redline. Without it, a bad contact can inject energy the
      // real machine could never store and the solver never gets it back.
      const limit = this.stats.weaponMaxOmega * 1.08;
      if (Math.abs(this._omega) > limit) {
        const scale = limit / Math.abs(this._omega);
        this.weaponBody.setAngvel({ x: w.x * scale, y: w.y * scale, z: w.z * scale }, false);
        this._omega *= scale;
      }
    }

    // Same guard on the chassis: nothing in a 250 lb fight legitimately travels
    // at 40 m/s, and letting it try is how a solver blows up.
    const v = this.chassis.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed > 32) {
      const s = 32 / speed;
      // Wake it: writing a velocity onto a sleeping body without waking it is how
      // a runaway gets pinned in place instead of corrected.
      this.chassis.setLinvel({ x: v.x * s, y: v.y * s, z: v.z * s }, true);
    }

    /*
     * Same guard on the frame's own rotation.
     *
     * A big horizontal rotor catching an arena wall is a real and spectacular way
     * to get thrown, but the tip is doing 108 m/s and moves 225 mm per step, so it
     * tunnels into the wall and the solver's penetration recovery — not the
     * bounce — decides what happens next. Measured, that reached 143 rad/s on the
     * frame. This is a ceiling, not a shaper: normal play tops out around 29, so
     * it only ever binds on the pathological case. (Rapier's CCD is driven by
     * linear motion, so it cannot help here: the rotor's centre barely moves.)
     */
    const w = this.chassis.angvel();
    const spin = Math.hypot(w.x, w.y, w.z);
    if (spin > MAX_CHASSIS_OMEGA) {
      const s = MAX_CHASSIS_OMEGA / spin;
      this.chassis.setAngvel({ x: w.x * s, y: w.y * s, z: w.z * s }, true);
    }

    const weaponMoving = Math.abs(this._omega) > 3 || this.actuatorTimer > 0;
    this.damage.tickMobility(dt, this.speed, weaponMoving);

    this.tickJudging(dt);
  }

  /**
   * The two judged categories that are not damage.
   *
   * Both used to be free money. Aggression was `throttle * speed`, with no
   * opponent anywhere in the expression — so a machine fleeing at full throttle
   * scored for fleeing, and a machine circling alone at the far end of an empty
   * box banked 1.33 over a round without ever meeting anybody. Control was
   * `dt * 0.05` whenever the machine was upright, which is a constant: two
   * machines that both stayed on their wheels for three minutes came out at
   * exactly 3.000 each, a guaranteed dead heat in a category worth three points.
   *
   * Aggression is now how much of the machine's velocity is pointed at the
   * opponent, and control is how much of the fight it spent in a position to use
   * its weapon — close, facing them, and the right way up. Both are things a
   * driver can actually win, and both are zero for a machine hiding in a corner.
   */
  private tickJudging(dt: number): void {
    const opponent = this.opponent;
    if (!opponent) return;

    const toOpponent = opponent.position(this.tmpVec).sub(this.position(this.tmpVec2));
    toOpponent.y = 0;
    const range = toOpponent.length();
    if (range < 1e-3) return;
    toOpponent.divideScalar(range);

    // Aggression: closing speed, and only while the driver is asking to close.
    const v = this.chassis.linvel();
    const closing = v.x * toOpponent.x + v.z * toOpponent.z;
    if (this.input.throttle > 0.05 && closing > 0) {
      this.aggression += closing * dt * 0.1;
    }

    // Control: upright, inside weapon range, and pointed at them.
    if (this._inverted) return;
    const facing = this.forward(this.tmpVec3);
    const alignment = facing.x * toOpponent.x + facing.z * toOpponent.z;
    if (range < CONTROL_RANGE && alignment > 0.4) {
      this.control += dt * 0.05 * alignment;
    }
  }

  private updateInversion(): void {
    const up = this.up(this.tmpVec);
    const wasInverted = this._inverted;
    this._inverted = up.y < -0.15;

    if (this._inverted !== wasInverted) {
      /*
       * An invertible frame simply drives the other way up: the wheels stick out
       * past both faces, so the suspension raycast has to flip with it.
       *
       * Flipping the ray direction alone is not enough, and that was the bug.
       * The hard point stays where it was — below the deck in body coordinates —
       * so an upside-down machine casts its suspension rays *upwards from a point
       * that is now above the chassis*, every ray misses the floor, and the bot
       * sits on its armour with all four wheels reporting no contact. Rolling the
       * frame 180 degrees about its long axis maps body y to -y, so the mirrored
       * hard point is simply -hardPointY; the wheel centre then lands at the same
       * height above the floor it had the right way up.
       */
      const canRunInverted = this.stats.invertible;
      const runningInverted = this._inverted && canRunInverted;
      const dir = runningInverted ? 1 : -1;
      for (let i = 0; i < this.wheelDead.length; i++) {
        this.vehicle.setWheelDirectionCs(i, { x: 0, y: dir, z: 0 });
        const connection = this.vehicle.wheelChassisConnectionPointCs(i);
        if (connection) {
          this.vehicle.setWheelChassisConnectionPointCs(i, {
            x: connection.x,
            y: runningInverted ? -this.hardPointY : this.hardPointY,
            z: connection.z,
          });
        }
      }
      this.invertedDriveSign = runningInverted ? -1 : 1;
    }
  }

  private updateDrive(): void {
    const { motor, wheel } = this.stats.parts;
    const gearRatio = clamp(this.design.gearRatio, 6, 40);
    const perWheelForce = (motor.stallTorque * gearRatio * DRIVETRAIN_EFFICIENCY) / wheel.radius;

    const mobility = this.damage.mobility;
    /*
     * Only the throttle flips when the machine is running upside-down.
     *
     * Two things reverse when the frame rolls over: the suspension ray direction
     * (so Rapier's wheel forward, and with it the sign of the engine force), and
     * which side of the *world* each wheel is on. The first reverses the yaw a
     * given wheel produces; the second reverses which wheel you want to slow
     * down. They cancel, so the steering sign is unchanged — negating it too made
     * an inverted machine turn left when the driver asked for right.
     */
    const throttle = clamp(this.input.throttle, -1, 1) * this.invertedDriveSign;
    const steer = clamp(this.input.steer, -1, 1);

    /*
     * Back-EMF, measured at each wheel rather than at the chassis.
     *
     * A brushed DC motor makes tau = tau_stall * (1 - w/w_free), and `w` is the
     * speed of *that motor's own wheel* over the ground — not the speed of the
     * machine. Using `currentVehicleSpeed()` got that right only while driving in
     * a straight line, and was badly wrong in the case that matters most: during a
     * pivot the chassis barely translates, so the term read ~0 and every motor
     * delivered full stall torque forever. Two-wheel frames spun up to 45 rad/s —
     * seven revolutions a second, with a wheel rim doing 16 m/s, twice the free
     * speed of the motor turning it.
     *
     * Taking the velocity of the contact patch (`v + w x r`) and projecting it on
     * the wheel's forward direction is what the motor actually sees, so it loads
     * up in a pivot exactly as it does in a straight line. It also removes the
     * need to special-case an inverted machine: the wheel's forward reverses with
     * the suspension ray, and that factor is already in `wheelForward`.
     *
     * Driving *against* the motion gets more than stall torque, which is both what
     * a real motor does and what makes a skid-steer pivot crisply. The 1.35
     * ceiling is the current limit every real speed controller has.
     */
    const freeSpeed = Math.max(0.5, this.stats.topSpeed);
    const linvel = this.chassis.linvel();
    const angvel = this.chassis.angvel();
    const bodyRotation = this.chassis.rotation();
    this.tmpQuat.set(bodyRotation.x, bodyRotation.y, bodyRotation.z, bodyRotation.w);
    const wheelForward = this.forward(this.tmpVec)
      .normalize()
      .multiplyScalar(this.invertedDriveSign);

    /*
     * Rapier's vehicle controller writes velocity onto the chassis without waking
     * it, and a machine that has been still for a couple of seconds is asleep. It
     * then accumulates velocity it never acts on: measured, a settled inverted bot
     * stayed at the same coordinates for six seconds while its reported speed
     * climbed to 64 mph. Asking for drive has to wake the body.
     */
    if (Math.abs(throttle) > 0.02 || Math.abs(steer) > 0.02) this.chassis.wakeUp();

    // With +Z forward and +Y up, the machine's own right-hand side is body -X —
    // which is where the even-indexed wheels sit (`side = -1` at construction).
    // Steering right therefore has to slow *those* wheels down; feeding them
    // `throttle + steer` steered every machine in the game the wrong way.
    const leftSideDrive = clamp(throttle + steer, -1, 1);
    const rightSideDrive = clamp(throttle - steer, -1, 1);
    const braking = Math.abs(throttle) < 0.02 && Math.abs(steer) < 0.02;

    /*
     * Cap the command at the friction circle, rather than trusting the solver to.
     *
     * Rapier's raycast vehicle is the Bullet `btRaycastVehicle` port, and that
     * weights the forward impulse by 0.5 in its own friction check — so the
     * effective longitudinal mu comes out at about twice `frictionSlip`, and a
     * 250 lb machine launched at up to 2.8 g. The builder panel quotes
     * `min(driveForce, tractionLimit) / mass`, i.e. mu*g, so the number on the
     * panel was half what the machine actually did.
     *
     * The budget is the machine's, not the corner's: a tyre can pass mu times the
     * load on it, and load transfer moves that load between wheels without
     * changing the total, which is `mu * m * g` for as long as the machine is on
     * the ground. Sharing that across the wheels actually touching is both what
     * `tractionLimit` in `computeStats` means and the only formulation that
     * survives the two cases a per-corner reading gets wrong: a settled machine,
     * whose reported suspension force is zero because the body is asleep, and a
     * frame pitched onto two wheels, which would otherwise lose the grip its other
     * two are still entitled to as they come back down.
     */
    let wheelsDown = 0;
    for (let i = 0; i < this.wheelDead.length; i++) {
      if (!this.wheelDead[i] && this.vehicle.wheelIsInContact(i)) wheelsDown += 1;
    }
    const tractionPerWheel =
      (wheel.grip * this.stats.totalMass * 9.81) / Math.max(1, wheelsDown);

    for (let i = 0; i < this.wheelDead.length; i++) {
      if (this.wheelDead[i]) {
        this.vehicle.setWheelEngineForce(i, 0);
        this.vehicle.setWheelBrake(i, 0);
        continue;
      }
      const demand = i % 2 === 0 ? rightSideDrive : leftSideDrive;

      // Ground speed of this wheel's contact patch, along the wheel's forward.
      let wheelSpeed = 0;
      const connection = this.vehicle.wheelChassisConnectionPointCs(i);
      if (connection) {
        const arm = this.tmpVec3
          .set(connection.x, connection.y, connection.z)
          .applyQuaternion(this.tmpQuat);
        wheelSpeed =
          (linvel.x + angvel.y * arm.z - angvel.z * arm.y) * wheelForward.x +
          (linvel.y + angvel.z * arm.x - angvel.x * arm.z) * wheelForward.y +
          (linvel.z + angvel.x * arm.y - angvel.y * arm.x) * wheelForward.z;
      }
      const ratio = demand === 0 ? 0 : clamp((wheelSpeed * Math.sign(demand)) / freeSpeed, -1, 1);
      const availableForce = perWheelForce * clamp(1 - ratio, 0, 1.35);

      // See `tractionPerWheel` above.
      const commanded = Math.min(availableForce * mobility, tractionPerWheel);
      this.vehicle.setWheelEngineForce(i, demand * commanded);
      this.vehicle.setWheelBrake(i, braking ? this.stats.totalMass * 1.4 : 0);
    }

    // Self-righting.
    if (this.input.selfRight && !this.prevSelfRight) this.trySelfRight();
  }

  private trySelfRight(): void {
    // An invertible frame does not *need* a srimech, but fitting one is legal and
    // it still has to work: a machine wedged on its side, or pinned nose-down
    // against a wall, is in a pose no amount of upside-down driving recovers from.
    if (!this.damage.srimechWorks) return;
    if (!this._inverted || this.srimechCooldown > 0) return;

    // A srimech arm pushes off the floor and rolls the machine about its long axis.
    const forward = this.forward(this.tmpVec).normalize();
    const impulse = this.stats.totalMass * 1.15;
    this.chassis.applyTorqueImpulse(
      { x: forward.x * impulse, y: forward.y * impulse, z: forward.z * impulse },
      true,
    );
    this.chassis.applyImpulse({ x: 0, y: this.stats.totalMass * 1.6, z: 0 }, true);
    this.srimechCooldown = 2.4;
  }

  /**
   * Cancel part of the rotor's gyroscopic reaction on the frame.
   *
   * A spinning rotor of angular momentum L makes the machine lean whenever it
   * turns: the reaction on the chassis is `w x L`, and it is why a big horizontal
   * bar tips a bot onto two wheels in every corner. The Gyro Compensator is a
   * counter-rotating mass that cancels most of that, and modelling it as a torque
   * that removes a fraction of exactly that cross product is both what the part
   * does and the only way the accessory can have any effect at all — the lean
   * comes out of the rotor's inertia tensor, which knows nothing about
   * accessories, so scaling a number in the stats could never reach it.
   */
  private applyGyroCompensation(dt: number): void {
    const fraction = this.stats.gyroCompensation;
    if (fraction <= 0 || !this.weaponBody) return;
    if (Math.abs(this._omega) < 1) return;

    const w = this.chassis.angvel();
    const L = this.weaponBody.angvel();
    const inertia = this.weaponInertia;
    // L is the rotor's angular momentum; w x L is the reaction it puts on the frame.
    const lx = L.x * inertia;
    const ly = L.y * inertia;
    const lz = L.z * inertia;
    const tx = w.y * lz - w.z * ly;
    const ty = w.z * lx - w.x * lz;
    const tz = w.x * ly - w.y * lx;

    // The reaction the frame feels is -(w x L), so cancelling a fraction of it
    // means applying +(w x L) back. Getting this sign backwards doubles the lean
    // instead of removing it, which is exactly what it did.
    this.chassis.applyTorqueImpulse(
      { x: tx * fraction * dt, y: ty * fraction * dt, z: tz * fraction * dt },
      true,
    );
  }

  private updateWeapon(dt: number): void {
    if (!this.weaponJoint || !this.weaponBody) return;
    const joint = this.weaponJoint as RAPIER.RevoluteImpulseJoint;
    const weapon = this.stats.parts.weapon;
    const condition = this.damage.weaponCondition;

    if (weapon.rotor) {
      // Never ask for more spin than the integrator can represent; above the
      // ceiling the body silently saturates and the motor fights a wall.
      const maxOmega = Math.min(weapon.rotor.maxOmega, MAX_SIMULABLE_OMEGA * 0.97);
      const power = weapon.rotor.motorWatts * (this.stats.parts.accessories.includes('bigbattery') ? 1.28 : 1);
      // Model a real motor curve: torque falls linearly from stall to free speed.
      // Choosing the damping factor this way makes peak power land where it should.
      const factor = (4 * power) / (maxOmega * maxOmega);
      const spinDirection = weapon.rotor.axis === 'y' ? 1 : -1;

      if (this.input.weapon && condition > 0.05) {
        joint.configureMotorVelocity(spinDirection * maxOmega, factor * condition);
      } else {
        // Freewheel down on bearing drag rather than braking hard.
        joint.configureMotorVelocity(0, factor * 0.06);
      }
      return;
    }

    // Actuators: flippers, hammers and crushers are all a powered arm.
    const sweep = weapon.actuator?.sweep ?? 1.1;
    const reach = weapon.actuator?.reach ?? weapon.clamp?.reach ?? 0.4;
    const armInertia = Math.max(0.05, this.weaponInertia);

    if (this.actuatorTimer > 0) {
      this.actuatorTimer -= dt;
      if (this.actuatorTimer <= 0) this.actuatorTarget = 0;
    }

    const firing = this.input.fire && !this.prevFire;
    if (weapon.clamp) {
      // A crusher simply holds wherever the driver puts it.
      this.actuatorTarget = this.input.weapon ? sweep : 0;
      const stiffness = (weapon.clamp.force * reach) / Math.max(0.15, sweep);
      joint.configureMotorPosition(this.actuatorTarget, stiffness * condition, stiffness * 0.14);
      return;
    }

    if (firing && this.actuatorTimer <= 0 && this.actuatorShotsLeft > 0 && condition > 0.05) {
      this.actuatorShotsLeft--;
      this.actuatorTimer = weapon.actuator?.cycleTime ?? 1.5;
      this.actuatorTarget = sweep;
    }

    // Stiffness sized so the arm delivers roughly its rated energy over the sweep.
    const energy = this.stats.actuatorEnergy;
    const stiffness = (2 * energy) / Math.max(0.05, sweep * sweep) / Math.max(0.4, armInertia * 4);
    const damping = Math.sqrt(stiffness * armInertia) * 0.5;
    joint.configureMotorPosition(
      this.actuatorTarget,
      stiffness * Math.max(0.05, condition),
      damping,
    );
  }

  // -------------------------------------------------------------------------
  // Damage plumbing
  // -------------------------------------------------------------------------

  /** Work out which armour face a world-space contact landed on. */
  faceForContact(worldPoint: THREE.Vector3): ArmorFace {
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    this.tmpQuat.set(r.x, r.y, r.z, r.w);
    const local = this.tmpVec
      .copy(worldPoint)
      .sub(this.tmpVec.clone().set(t.x, t.y, t.z))
      .applyQuaternion(this.tmpQuat.clone().invert());

    const { width, height, length } = this.stats.parts.chassis;
    const nx = local.x / (width / 2);
    const ny = local.y / (height / 2);
    const nz = local.z / (length / 2);
    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);

    if (az >= ax && az >= ay) return nz > 0 ? 'front' : 'rear';
    if (ax >= ay) return nx > 0 ? 'right' : 'left';
    return ny > 0 ? 'top' : 'bottom';
  }

  /**
   * Take energy out of the rotor after a hit.
   *
   * The rigid-body solver only knows about elastic and frictional exchange; the
   * joules that actually went into bending someone's armour have to be removed
   * by hand, which is also what makes a big bite visibly stall the weapon.
   */
  bleedWeaponEnergy(joules: number): void {
    if (!this.weaponBody || joules <= 0) return;
    const inertia = this.weaponInertia;
    if (inertia <= 1e-6) return;

    const current = 0.5 * inertia * this._omega * this._omega;
    const remaining = Math.max(0, current - joules);
    const newOmega = Math.sqrt((2 * remaining) / inertia) * Math.sign(this._omega || 1);
    const scale = Math.abs(this._omega) > 1e-6 ? newOmega / this._omega : 0;

    const w = this.weaponBody.angvel();
    this.weaponBody.setAngvel({ x: w.x * scale, y: w.y * scale, z: w.z * scale }, true);
    this._omega = newOmega;
  }

  /** Called by the combat system when a part is destroyed. */
  onPartDestroyed(partId: string): void {
    if (partId.startsWith('wheel-')) {
      const index = Number(partId.slice('wheel-'.length));
      if (Number.isInteger(index) && index < this.wheelDead.length) {
        this.wheelDead[index] = true;
        this.vehicle.setWheelEngineForce(index, 0);
        this.vehicle.setWheelRadius(index, this.wheelRestRadius[index]! * DEAD_WHEEL_RADIUS_SCALE);
        this.vehicle.setWheelFrictionSlip(index, DEAD_WHEEL_GRIP);
        this.vehicle.setWheelSideFrictionStiffness(index, SIDE_FRICTION * 0.4);
        const mesh = this.visual?.wheels[index];
        if (mesh) mesh.visible = false;
      }
      return;
    }

    if (partId === 'weapon' && this.weaponJoint) {
      const joint = this.weaponJoint as RAPIER.RevoluteImpulseJoint;
      joint.configureMotorVelocity(0, 4);
      return;
    }

    if (partId.startsWith('armor-')) {
      const face = partId.slice('armor-'.length) as ArmorFace;
      const panel = this.visual?.armorPanels.get(face);
      if (panel) panel.visible = false;
    }
  }

  /** Kill everything: used when a bot is counted out or leaves the box. */
  disable(): void {
    for (let i = 0; i < this.wheelDead.length; i++) {
      this.vehicle.setWheelEngineForce(i, 0);
      this.vehicle.setWheelBrake(i, this.stats.totalMass * 2);
    }
    if (this.weaponJoint) {
      (this.weaponJoint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(0, 8);
    }
    this.input = { ...NEUTRAL_INPUT };
  }

  // -------------------------------------------------------------------------
  // Presentation
  // -------------------------------------------------------------------------

  /** Copy physics state onto the meshes. Called once per rendered frame. */
  syncVisual(dt: number): void {
    if (!this.visual) return;
    const t = this.chassis.translation();
    const r = this.chassis.rotation();
    this.visual.root.position.set(t.x, t.y, t.z);
    this.visual.root.quaternion.set(r.x, r.y, r.z, r.w);

    /*
     * Wheels ride their suspension and spin at their true rolling rate.
     *
     * The wheel groups are children of `root`, and `root` has just been given the
     * chassis' world transform — so everything written here must be in *chassis*
     * coordinates. Rapier hands back the connection point and ray direction in
     * exactly that frame already, which is the whole point of the `Cs` suffix, so
     * the hanging position drops straight in. (Composing them into world space
     * first and assigning that to a child applied the body transform twice and
     * flung the wheels out to roughly double the machine's distance from the
     * origin, trailing behind it like a shed axle.)
     */
    for (let i = 0; i < this.visual.wheels.length; i++) {
      const mesh = this.visual.wheels[i];
      if (!mesh || !mesh.visible) continue;
      const connection = this.vehicle.wheelChassisConnectionPointCs(i);
      const direction = this.vehicle.wheelDirectionCs(i);
      const length = this.vehicle.wheelSuspensionLength(i) ?? SUSPENSION_REST;
      if (!connection || !direction) continue;
      mesh.position.set(
        connection.x + direction.x * length,
        connection.y + direction.y * length,
        connection.z + direction.z * length,
      );
      mesh.quaternion.identity();

      const rotation = this.vehicle.wheelRotation(i);
      if (rotation !== null) {
        this.wheelSpin[i] = rotation;
        mesh.rotateX(rotation);
      }
    }

    if (this.visual.weaponPivot && this.weaponBody) {
      // Same trap, one level worse: the weapon is a *separate* rigid body, so its
      // pose is genuinely in world space and has to be pulled back into the
      // chassis frame before it can be assigned to a child of `root`.
      const wt = this.weaponBody.translation();
      const wr = this.weaponBody.rotation();
      this.tmpQuat.copy(this.visual.root.quaternion).invert();
      this.tmpVec
        .set(wt.x - t.x, wt.y - t.y, wt.z - t.z)
        .applyQuaternion(this.tmpQuat);
      this.visual.weaponPivot.position.copy(this.tmpVec);
      this.visual.weaponPivot.quaternion
        .set(wr.x, wr.y, wr.z, wr.w)
        .premultiply(this.tmpQuat);
    }

    // Underglow brightens with weapon charge — a cheap, readable "it is armed" cue.
    const target = 0.5 + this.weaponCharge * 4.5;
    this.visual.underglow.intensity = damp(this.visual.underglow.intensity, target, 6, dt);

    // Panels darken and dull as they absorb energy.
    for (const [face, panel] of this.visual.armorPanels) {
      const part = this.damage.get(`armor-${face}`);
      if (!part || !panel.visible) continue;
      const material = panel.material as THREE.MeshPhysicalMaterial;
      const wear = clamp01(1 - part.hp / Math.max(1, part.maxHp));
      // Modulate from the finish the player chose, not from a fixed gloss.
      const base = (panel.userData.baseRoughness as number | undefined) ?? 0.18;
      material.roughness = clamp(base + wear * 0.65, 0.05, 1);
      const baseColor = panel.userData.baseColor as THREE.Color | undefined;
      if (baseColor) material.color.copy(baseColor).multiplyScalar(1 - wear * 0.45);
      else material.color.setScalar(1 - wear * 0.45);
    }
  }

  dispose(): void {
    this.visual?.dispose();
    this.visual?.root.removeFromParent();
    const rapierWorld = this.world.world;
    if (this.weaponJoint) rapierWorld.removeImpulseJoint(this.weaponJoint, false);
    if (this.weaponBody) rapierWorld.removeRigidBody(this.weaponBody);
    rapierWorld.removeVehicleController(this.vehicle);
    rapierWorld.removeRigidBody(this.chassis);
    this.colliderParts.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Quaternion from an axis and an angle, for collider-local orientations. */
function quatFromAxisAngle(
  x: number,
  y: number,
  z: number,
  angle: number,
): { x: number; y: number; z: number; w: number } {
  const s = Math.sin(angle / 2);
  return { x: x * s, y: y * s, z: z * s, w: Math.cos(angle / 2) };
}

function quatFromYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/**
 * Convex hull for the front wedge, from the same `wedgeDimensions` the visible
 * ramp is built from — so the wedge opponents ride up is the wedge you can see.
 * An earlier version of this ran the ramp along -Z, which put the collider inside
 * the chassis pointing backwards while the mesh pointed forwards.
 */
function wedgeHullPoints(chassis: { width: number; height: number }): Float32Array {
  const { hw, rise, depth } = wedgeDimensions(chassis);
  return new Float32Array([
    -hw, 0, depth,
    hw, 0, depth,
    -hw, 0, 0,
    hw, 0, 0,
    -hw, rise, 0,
    hw, rise, 0,
  ]);
}

/**
 * How much of an actuator or clamp weapon's mount mass is on the moving part.
 *
 * The builder quotes one number for the whole weapon assembly, and the solver has
 * to spend exactly that number and no more. Splitting it here — rather than
 * inventing a mass for each collider — is what keeps a machine's simulated weight
 * equal to the weight the player was told they were within the limit with. (The
 * arm, ram or paddle is the part that swings; the bottle, valves, regulator and
 * mounting plates stay bolted to the frame, which is roughly this split on a real
 * pneumatic flipper.)
 */
export function actuatorMovingMass(weapon: WeaponSpec): number {
  if (weapon.rotor) return 0;
  if (!weapon.actuator && !weapon.clamp) return 0;
  return weapon.mountMass * 0.45;
}

/** Mass of the fixed front wedge / fork collider, when the build has one. */
export const WEDGE_COLLIDER_MASS = 2.5;

/**
 * Physics shapes matching the weapon that was drawn in botMesh.
 *
 * Rotor mass and inertia are stated explicitly from the catalogue rather than
 * derived from the shapes, so the energy the builder quotes is the energy the
 * solver carries. Two details make that work:
 *
 * - `setAdditionalMassProperties` on the body is a no-op in this Rapier build, so
 *   the properties have to go on a collider.
 * - A collider's `principalAngularInertia` is read in the *collider's* frame.
 *   Passing the inverse of the collider's own rotation as the inertia frame
 *   cancels that out, so the tensor can be written in plain body coordinates.
 */
function weaponColliderDescs(stats: DerivedStats): RAPIER.ColliderDesc[] {
  const weapon = stats.parts.weapon;
  const descs: RAPIER.ColliderDesc[] = [];

  if (weapon.rotor) {
    const { shape, radius, thickness, span, axis } = weapon.rotor;

    switch (shape) {
      case 'disc': {
        const desc = RAPIER.ColliderDesc.cylinder(thickness / 2, radius);
        // Cylinders stand on Y; rotate to lie on the weapon's spin axis.
        if (axis === 'x') desc.setRotation(axisQuat('z', Math.PI / 2));
        descs.push(desc);
        break;
      }
      case 'bar': {
        const depth = radius * 0.24;
        descs.push(
          axis === 'y'
            ? RAPIER.ColliderDesc.cuboid(span / 2, thickness / 2, depth / 2)
            : RAPIER.ColliderDesc.cuboid(thickness / 2, span / 2, depth / 2),
        );
        break;
      }
      case 'drum': {
        const desc = RAPIER.ColliderDesc.cylinder(span / 2, radius);
        desc.setRotation(axisQuat('z', Math.PI / 2));
        descs.push(desc);
        break;
      }
      case 'ring': {
        /*
         * A cage rotor is modelled by its swept envelope rather than by its
         * individual bars. At 330 rad/s a bar crosses any given point every few
         * milliseconds, so anything inside the envelope is going to be hit — and a
         * single convex shape cannot let a thin opponent slip between the bars the
         * way four separate boxes can. It also keeps the rotor's mass on one
         * collider, which is the only arrangement whose inertia tensor survives
         * Rapier's re-diagonalisation with its spin axis intact.
         */
        const desc = RAPIER.ColliderDesc.cylinder(span / 2, radius);
        desc.setRotation(axisQuat('z', Math.PI / 2));
        descs.push(desc);
        break;
      }
    }

    applyRotorMassProperties(descs, stats);
    return descs;
  }

  const reach = weapon.actuator?.reach ?? weapon.clamp?.reach ?? 0.4;
  const width = stats.parts.chassis.width * 0.7;
  const moving = actuatorMovingMass(weapon);
  if (weapon.kind === 'flipper') {
    const desc = RAPIER.ColliderDesc.cuboid(width / 2, 0.012, reach / 2);
    desc.setTranslation(0, 0, reach / 2);
    desc.setMass(moving);
    descs.push(desc);
  } else {
    // An arm is mostly tip: the head carries the striking mass, the shaft carries
    // the rest, and together they come to exactly `moving`.
    const shaft = RAPIER.ColliderDesc.cuboid(0.03, 0.03, reach / 2);
    shaft.setTranslation(0, 0, reach / 2);
    shaft.setMass(moving * 0.4);
    descs.push(shaft);
    const head = RAPIER.ColliderDesc.cuboid(0.07, 0.06, 0.08);
    head.setTranslation(0, 0, reach);
    head.setMass(moving * 0.6);
    descs.push(head);
  }
  return descs;
}

/**
 * Put the catalogue's mass and inertia tensor onto the first rotor collider and
 * make the rest pure collision geometry, so the body's centre of mass sits on the
 * spin axis and its inertia is exactly what the parts list promised.
 */
function applyRotorMassProperties(descs: RAPIER.ColliderDesc[], stats: DerivedStats): void {
  if (descs.length === 0) return;
  const tensor = rotorInertiaTensor(stats.parts.weapon, stats.parts.weaponMaterial);
  const mass = Math.max(0.5, stats.rotorMassKg);

  const primary = descs[0]!;
  const rotation = primary.rotation;
  const inverse = new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w).invert();

  // Cancel the collider's own offset so the rotor spins about the joint, not
  // about a point out at the rim.
  const offset = new THREE.Vector3(
    -primary.translation.x,
    -primary.translation.y,
    -primary.translation.z,
  ).applyQuaternion(inverse);

  primary.setMassProperties(
    mass,
    { x: offset.x, y: offset.y, z: offset.z },
    tensor,
    { x: inverse.x, y: inverse.y, z: inverse.z, w: inverse.w },
  );

  for (let i = 1; i < descs.length; i++) {
    // Shape only: no mass, no inertia, no shifted centre of gravity.
    descs[i]!.setMassProperties(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
    });
  }
}

function axisQuat(axis: 'x' | 'y' | 'z', angle: number): RAPIER.Rotation {
  const s = Math.sin(angle / 2);
  return {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w: Math.cos(angle / 2),
  };
}
