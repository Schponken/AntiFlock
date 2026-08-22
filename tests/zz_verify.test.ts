import { beforeAll, describe, expect, it } from 'vitest';
import { FIXED_DT, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { computeStats, makeDefaultDesign, presetById, type BotDesign } from '../src/game/design.ts';
import type { Bot } from '../src/game/bot.ts';

beforeAll(async () => { await initRapier(); });
const run = (w: PhysicsWorld, s: number) => { for (let i = 0; i < Math.round(s / FIXED_DT); i++) w.step(); };
function solo(design: BotDesign) {
  const world = new PhysicsWorld();
  const combat = new Combat(world, { headless: true });
  const bot = combat.addBot(design, 0);
  combat.start();
  return { world, bot };
}

describe('finding scenario: drop inverted from 1m, roll 180 about Z', () => {
  for (const chassisId of ['brick', 'discshell']) {
    it(chassisId, () => {
      const design = makeDefaultDesign();
      design.chassisId = chassisId;
      const stats = computeStats(design);
      console.log(chassisId, 'invertible=', stats.invertible);
      const { world, bot } = solo(design);
      const chassis = (bot as any).chassis;
      // roll 180 deg about Z: quat (0,0,1,0)
      chassis.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
      chassis.setTranslation({ x: 0, y: 1.0, z: 0 }, true);
      chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      run(world, 1.5);
      console.log('after settle: inverted=', bot.inverted, 'up.y=', bot.up().y.toFixed(3));
      const start = bot.position().clone();
      bot.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
      run(world, 8);
      const dist = bot.position().distanceTo(start);
      const veh = (bot as any).vehicle;
      const contacts = [0,1,2,3].map(i => { try { return veh.wheelIsInContact(i); } catch { return 'n/a'; } });
      console.log(chassisId, 'travelled', dist.toFixed(3), 'm; contacts', JSON.stringify(contacts),
        'immobileFor', (bot.damage as any).immobileFor);
      expect(dist).toBeGreaterThan(0.5);
      world.free();
    });
  }

  it('trySelfRight is NOT skipped for invertible frames', () => {
    const design = presetById('anvilhead').design;
    const stats = computeStats(design);
    console.log('anvilhead chassis', design.chassisId, 'invertible', stats.invertible, 'srimech?', design.accessories);
  });
});
