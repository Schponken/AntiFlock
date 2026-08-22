import { beforeAll, describe, expect, it } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT, MAX_SIMULABLE_OMEGA, PhysicsWorld, initRapier } from '../src/physics/world.ts';
import { Combat } from '../src/game/combat.ts';
import { Arena, ARENA_HALF } from '../src/game/arena.ts';
import { makeDefaultDesign, presetById, cloneDesign } from '../src/game/design.ts';
import { rotorInertia, weaponById, materialById } from '../src/game/parts.ts';

beforeAll(async () => { await initRapier(); });

const run = (world: PhysicsWorld, seconds: number) => {
  const n = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < n; i++) world.step();
};

describe('probe', () => {
  it('A: does rapier clamp angular velocity at PI/4/dt?', () => {
    const w = new PhysicsWorld({ x: 0, y: 0, z: 0 });
    const b = w.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setAngularDamping(0));
    w.world.createCollider(RAPIER.ColliderDesc.cylinder(0.01, 0.2).setMass(5), b);
    const target = 500; // above MAX_SIMULABLE_OMEGA (377)
    b.setAngvel({ x: 0, y: target, z: 0 }, true);
    // Integrate 100 steps, measure actual angle advanced
    let prev = 0;
    let total = 0;
    const angle = () => { const r = b.rotation(); return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z) * Math.sign(r.y || 1), r.w); };
    prev = angle();
    for (let i = 0; i < 100; i++) {
      w.step();
      const a = angle();
      let d = a - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      total += d; prev = a;
    }
    const measured = total / (100 * FIXED_DT);
    console.log('PROBE_A target=', target, 'measured omega=', measured.toFixed(2), 'angvel after=', b.angvel().y.toFixed(2), 'MAX_SIMULABLE_OMEGA=', MAX_SIMULABLE_OMEGA.toFixed(1));
    expect(Number.isFinite(measured)).toBe(true);
  });

  it('B: vehicle API surface', () => {
    const w = new PhysicsWorld();
    const c = new Combat(w, { headless: true });
    const bot = c.addBot(makeDefaultDesign(), 0);
    c.start();
    run(w, 1.0);
    const v: any = (bot as any).vehicle;
    console.log('PROBE_B has wheelForwardImpulse=', typeof v.wheelForwardImpulse);
    bot.setInput({ throttle: 1, steer: 0, weapon: false, fire: false, selfRight: false });
    run(w, 0.2);
    const imps = [];
    for (let i = 0; i < 4; i++) imps.push(v.wheelForwardImpulse(i));
    console.log('PROBE_B forwardImpulses=', JSON.stringify(imps), 'inContact=', [0,1,2,3].map(i=>v.wheelIsInContact(i)));
  });

  it('C: pulverizer can reach a bot', () => {
    const w = new PhysicsWorld();
    const c = new Combat(w, { headless: true });
    const bot = c.addBot(presetById('doorstop').design, 0);
    c.start();
    run(w, 1.0);
    // park the bot directly under the near pulverizer (z = -(ARENA_HALF-0.45))
    const z = -(ARENA_HALF - 0.45);
    const hazardHits: any[] = [];
    c.events.on('impact', (e) => { if (e.kind === 'hazard') hazardHits.push(e); });
    for (let sweep = 0; sweep < 8; sweep++) {
      const zz = z + (sweep - 4) * 0.12;
      bot.chassis.setTranslation({ x: 0, y: 0.2, z: zz }, true);
      bot.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
      bot.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
      c.arena.triggerPulverizer(-1);
      run(w, 4.0);
    }
    console.log('PROBE_C pulverizer hazard impacts=', hazardHits.length, 'chassis top y=', (0.2 + presetById('doorstop').design ? '' : ''));
  });

  it('D: killsaw can reach a bot', () => {
    const w = new PhysicsWorld();
    const c = new Combat(w, { headless: true });
    const bot = c.addBot(presetById('doorstop').design, 0);
    c.start();
    run(w, 1.0);
    const hits: any[] = [];
    c.events.on('impact', (e) => { if (e.kind === 'hazard') hits.push(e); });
    bot.chassis.setTranslation({ x: -0.95, y: 0.2, z: -1.25 }, true);
    bot.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    c.arena.triggerKillsaws(5);
    run(w, 3.0);
    console.log('PROBE_D killsaw hazard impacts=', hits.length, 'kinds=', hits.slice(0,3).map(h=>h.partId));
  });

  it('E: weapon inertia matches catalogue', () => {
    const w = new PhysicsWorld();
    const c = new Combat(w, { headless: true });
    for (const id of ['vert-disc', 'horiz-bar', 'undercutter', 'drum', 'vert-eggbeater', 'saw']) {
      const d = cloneDesign(makeDefaultDesign());
      d.weaponId = id;
      const bot = new (Object.getPrototypeOf(c.addBot(d, 0)).constructor)({
        world: w, design: d, team: 0, position: { x: 0, y: 0, z: 0 }, facing: 0, headless: true,
      });
      const spec = weaponById(id)!;
      const mat = materialById(d.weaponMaterialId ?? 'steel') ?? materialById('steel')!;
      console.log('PROBE_E', id, 'solverInertia=', bot.weaponInertia.toFixed(5), 'catalogue=', rotorInertia(spec, mat).toFixed(5));
    }
  });
});
