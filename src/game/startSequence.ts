/**
 * The show open.
 *
 * House lights down, a drone under a dark box, searchlights sweeping the crowd,
 * both machines introduced in their squares, then the arena lights slam on
 * together, the countdown runs, and the klaxon starts the fight.
 *
 * Every beat is a cue on one timeline so lighting, audio, camera and announcer
 * stay locked to each other regardless of frame rate. The whole thing is
 * skippable — nobody wants to sit through it on the twentieth fight.
 */

import * as THREE from 'three';
import { Timeline } from '../core/timeline.ts';
import { Emitter } from '../core/emitter.ts';
import type { AudioEngine } from '../audio/audio.ts';
import type { Announcer } from '../audio/announcer.ts';
import type { LightRig } from '../render/lightRig.ts';
import type { CameraDirector } from '../render/cameras.ts';
import type { Stage } from '../render/renderer.ts';
import type { Bot } from './bot.ts';
import { ARENA_HALF } from './arena.ts';
import { kgToLb } from '../core/mathx.ts';

export interface StartSequenceEvents {
  /** Big centred text: bot names during introductions, numbers during the countdown. */
  card: { text: string; sub?: string; kind: 'intro' | 'count' | 'go' };
  cardClear: Record<string, never>;
  /** The fight is live. */
  fight: Record<string, never>;
}

export interface StartSequenceContext {
  audio: AudioEngine;
  announcer: Announcer;
  lights: LightRig;
  camera: CameraDirector;
  stage: Stage;
  red: Bot;
  blue: Bot;
}

export class StartSequence {
  readonly events = new Emitter<StartSequenceEvents>();

  private timeline = new Timeline();
  private ctx: StartSequenceContext;
  private done = false;

  constructor(ctx: StartSequenceContext) {
    this.ctx = ctx;
    this.build();
  }

  /** True while cues are still pending, including the ones after the klaxon. */
  get running(): boolean {
    return this.timeline.running;
  }

  get finished(): boolean {
    return this.done;
  }

  private build(): void {
    const { audio, announcer, lights, camera, stage, red, blue } = this.ctx;

    const weightOf = (bot: Bot) => `${Math.round(kgToLb(bot.stats.totalMass))} pounds`;
    /*
     * "with a undercutter blade" is the sort of thing a real announcer never says.
     * The article follows the name, and the one weapon whose name is an
     * abbreviation gets spelled out so the speech synthesiser does not read "CO2"
     * as a word.
     */
    const weaponOf = (bot: Bot) => {
      const name = bot.stats.parts.weapon.name;
      const spoken = name.replace(/^CO2\b/, 'C O 2').toLowerCase();
      return `${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${spoken}`;
    };

    this.timeline
      // --- Blackout -------------------------------------------------------
      .add(0, 'blackout', () => {
        lights.blackout();
        audio.setCrowd(0.35);
        audio.stopMusic();
        camera.playMove({
          from: [0, 13, ARENA_HALF + 9],
          to: [0, 5.5, ARENA_HALF + 3.4],
          lookFrom: [0, 1, 0],
          lookTo: [0, 0.5, 0],
          duration: 6,
        });
      })
      .add(0.35, 'drone', () => {
        audio.boom(0.35);
        audio.riser(6.5);
      })
      .add(0.9, 'searchlights', () => {
        lights.setSweeping(true);
        audio.setCrowd(0.55);
        /*
         * The music bed runs under the whole open, not just the fight.
         *
         * `startMusic` was not called until the ACTIVATE cue at 23.6 s, which left
         * thirteen seconds between the riser dying and the countdown starting with
         * nothing under them but a two-second loop of filtered noise. A live show
         * never has a hole like that in it. Starting the bed low and lifting it
         * cue by cue gives the introductions something to sit on and makes the
         * lights-up land as a swell rather than as a sound appearing from nowhere.
         */
        audio.setMusicIntensity(0.16);
        audio.startMusic();
      })

      // --- Welcome --------------------------------------------------------
      .add(1.8, 'welcome', () => {
        announcer.say('Ladies and gentlemen — welcome to the AntiFlock Robot Combat League!', {
          emphasis: true,
        });
        audio.crowdPop(0.8);
      })

      // --- Red corner -----------------------------------------------------
      .add(5.4, 'red-intro', () => {
        lights.pulseWash(1);
        this.events.emit('card', {
          text: red.name.toUpperCase(),
          sub: `RED SQUARE · ${Math.round(kgToLb(red.stats.totalMass))} LB · ${red.stats.parts.weapon.name.toUpperCase()}`,
          kind: 'intro',
        });
        announcer.say(
          `In the red square, weighing in at ${weightOf(red)}, with ${weaponOf(red)} — ${red.name}!`,
        );
        this.spotlight(red);
        audio.crowdPop(0.7);
      })

      // --- Blue corner ----------------------------------------------------
      .add(10.2, 'blue-intro', () => {
        lights.pulseWash(1);
        this.events.emit('card', {
          text: blue.name.toUpperCase(),
          sub: `BLUE SQUARE · ${Math.round(kgToLb(blue.stats.totalMass))} LB · ${blue.stats.parts.weapon.name.toUpperCase()}`,
          kind: 'intro',
        });
        announcer.say(
          `And in the blue square, at ${weightOf(blue)}, with ${weaponOf(blue)} — ${blue.name}!`,
        );
        this.spotlight(blue);
        audio.crowdPop(0.7);
      })

      .add(14.6, 'clear-cards', () => {
        this.events.emit('cardClear', {});
        camera.playMove({
          from: [ARENA_HALF - 1.5, 2.4, ARENA_HALF - 1.5],
          to: [5.6, 3.9, 5.6],
          lookFrom: [0, 0.4, 0],
          lookTo: [0, 0.4, 0],
          duration: 4.4,
        });
      })

      // --- Are you ready --------------------------------------------------
      .add(15.1, 'ready', () => {
        announcer.say('Drivers — are you ready?', { emphasis: true });
        audio.setCrowd(0.75);
        audio.setMusicIntensity(0.34);
      })
      .add(17.4, 'robot-fighting-time', () => {
        announcer.say("It's robot fighting time!", { emphasis: true, rate: 0.9 });
        lights.strobe(0.85, 2.2);
        audio.crowdPop(1);
        audio.setMusicIntensity(0.5);
      })

      // --- Lights up ------------------------------------------------------
      .add(19.6, 'lights-up', () => {
        lights.setSweeping(false);
        lights.setArena(1, true);
        lights.setHouse(0.5);
        audio.lightThunk();
        audio.setCrowd(0.9);
        // Snap up — the lights genuinely do slam on — then ease back down.
        stage.setBloomBoost(0.55, true);
        audio.setMusicIntensity(0.6);
        camera.setMode('broadcast');
      })
      .add(20.1, 'bloom-settle', () => {
        stage.setBloomBoost(0);
      })

      // --- Countdown ------------------------------------------------------
      .add(20.6, 'count-3', () => {
        this.events.emit('card', { text: '3', kind: 'count' });
        audio.countdownBeep();
      })
      .add(21.6, 'count-2', () => {
        this.events.emit('card', { text: '2', kind: 'count' });
        audio.countdownBeep();
      })
      .add(22.6, 'count-1', () => {
        this.events.emit('card', { text: '1', kind: 'count' });
        audio.countdownBeep();
      })
      .add(23.6, 'activate', () => {
        this.events.emit('card', { text: 'ACTIVATE!', kind: 'go' });
        audio.countdownBeep(true);
        audio.klaxon(1.8);
        audio.stopRiser();
        audio.startMusic();
        audio.setMusicIntensity(0.75);
        announcer.say('Activate!', { emphasis: true });
        this.finish();
      })
      .add(25.1, 'clear-go', () => {
        this.events.emit('cardClear', {});
      });
  }

  /** Point the broadcast camera at one machine in its square. */
  private spotlight(bot: Bot): void {
    const position = bot.position(new THREE.Vector3());
    const behind = bot.forward(new THREE.Vector3()).multiplyScalar(-2.1);
    this.ctx.camera.playMove({
      from: [position.x + behind.x * 1.6, 1.9, position.z + behind.z * 1.6],
      to: [position.x + behind.x * 0.7, 0.95, position.z + behind.z * 0.7],
      lookFrom: [position.x, 0.4, position.z],
      lookTo: [position.x, 0.3, position.z],
      duration: 4.2,
    });
  }

  start(): void {
    this.done = false;
    this.timeline.start();
  }

  update(dt: number): void {
    this.timeline.update(dt);
  }

  /** Jump straight to a lit arena and a live fight. */
  skip(): void {
    if (this.done) return;
    this.timeline.skip();

    const { audio, announcer, lights, camera, stage } = this.ctx;
    announcer.cancel();
    lights.setSweeping(false);
    // Both of these are fire-and-forget effects with their own lifetimes, and
    // neither was being cleaned up: skipping the open used to drop the player
    // into a live fight with a seven-second drone still rising over it and the
    // arena strobing at 12 Hz until the cue happened to time out.
    lights.stopStrobe();
    audio.stopRiser();
    lights.setArena(1, true);
    lights.setHouse(0.5, true);
    stage.setBloomBoost(0, true);
    camera.setMode('broadcast');
    camera.reset();
    audio.setCrowd(0.85);
    audio.klaxon(1.2);
    audio.startMusic();
    audio.setMusicIntensity(0.75);
    this.events.emit('cardClear', {});
    this.finish();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    this.events.emit('fight', {});
  }
}
