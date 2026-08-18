/**
 * The garage turntable.
 *
 * Shows the robot currently being designed, built through exactly the same code
 * path a fighting robot uses: a real Rapier body with real colliders, real
 * mass, and its weapon on a real joint. It sits on a small patch of floor and
 * idles its weapon so you can see what you have built before you take it out.
 *
 * Reusing the fight's own construction means the preview cannot drift out of
 * step with what actually turns up in the arena.
 */

import * as THREE from 'three';
import { Bot } from '../sim/bot';
import { Physics, RAPIER, GROUPS } from '../sim/physics';
import type { BotDesign } from '../sim/parts';
import { buildBotView, disposeBotView, syncBotView, type BotView } from './botMesh';

export class GaragePreview {
  private physics: Physics | null = null;
  private bot: Bot | null = null;
  private view: BotView | null = null;
  private settleTime = 0;

  constructor(private readonly scene: THREE.Scene) {}

  /** True when a robot is currently on the turntable. */
  get active(): boolean {
    return this.bot !== null;
  }

  /**
   * Replace whatever is on the turntable with this design.
   *
   * Rebuilding from scratch on every change is affordable — one body and a
   * handful of colliders — and it means a change of chassis or weapon is
   * reflected exactly, including the collision shape.
   */
  show(design: BotDesign): void {
    this.clear();

    this.physics = new Physics();

    // A small platform for it to stand on. The arena's own floor is part of a
    // different physics world, so the preview needs its own.
    const ground = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0),
    );
    const groundCollider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(4, 0.5, 4).setFriction(0.9).setCollisionGroups(GROUPS.arena),
      ground,
    );
    this.physics.register(groundCollider, { kind: 'floor' });

    this.bot = new Bot(this.physics, 'preview', 'a', design, { x: 0, y: 0.4, z: 0 }, 0);
    this.view = buildBotView(this.bot, design);

    this.scene.add(this.view.root);
    if (this.view.weapon) this.scene.add(this.view.weapon);

    this.settleTime = 0;
  }

  /** Step the preview and push it onto the meshes. */
  update(dt: number): void {
    const { physics, bot, view } = this;
    if (!physics || !bot || !view) return;

    this.settleTime += dt;

    // Idle the weapon once the robot has settled onto its wheels, so a spinner
    // turns over slowly instead of sitting dead.
    bot.control = {
      throttle: 0,
      steer: 0,
      weapon: this.settleTime > 1 ? 0.16 : 0,
      fire: false,
      selfRight: false,
    };

    physics.advance({
      frameTime: dt,
      preStep: (step) => bot.preStep(step, true),
      postStep: () => bot.postStep(),
    });

    syncBotView(view, bot);
  }

  /** Remove the robot and release its physics world. */
  clear(): void {
    if (this.view) {
      this.scene.remove(this.view.root);
      if (this.view.weapon) this.scene.remove(this.view.weapon);
      disposeBotView(this.view);
      this.view = null;
    }
    this.bot = null;
    if (this.physics) {
      this.physics.dispose();
      this.physics = null;
    }
  }
}
