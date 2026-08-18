/**
 * The show director.
 *
 * This is the piece that makes the start of a match feel like the start of a
 * match. The cue list lives in `sim/match` so it can be tested without a
 * browser; this module is what those cues actually *do* — the blackout, the
 * crowd swelling, the spotlights picking out each robot as it is introduced,
 * the lights slamming back up, the safety light going red, the three beeps and
 * the horn.
 *
 * Every cue drives lighting, audio and camera together from one place, which is
 * why they stay in sync.
 */

import * as THREE from 'three';
import { START_POSITIONS } from '../sim/arena';
import type { Cue, MatchEvent } from '../sim/match';
import { formatLine } from '../sim/match';
import type { GameRenderer } from '../render/renderer';
import { flash } from '../render/lighting';
import type { AudioEngine } from './audio';
import type { Announcer } from './announcer';

export interface ShowContext {
  renderer: GameRenderer;
  audio: AudioEngine;
  announcer: Announcer;
  redName: string;
  blueName: string;
}

export class ShowDirector {
  /** True while the spotlights should be sweeping. */
  sweeping = false;
  /** Set on `activate`, so the caller knows the fight is on. */
  fightLive = false;

  constructor(private readonly ctx: ShowContext) {}

  /** Put the arena into its pre-show state. */
  reset(): void {
    const { renderer, audio } = this.ctx;
    renderer.lightState.house = 1;
    renderer.lightState.spot = 0;
    renderer.lightState.accent = 0.55;
    renderer.setSafetyLight(false);
    this.sweeping = false;
    this.fightLive = false;
    audio.setCrowd(0.18);
  }

  /** Handle one cue from the match's opening sequence. */
  handleCue(cue: Cue): void {
    const { renderer, audio, announcer, redName, blueName } = this.ctx;
    const lights = renderer.lightState;

    switch (cue.kind) {
      case 'house-lights-down':
        // The hall drops to near black, leaving only the coloured uplights.
        lights.house = 0.04;
        lights.accent = 1;
        audio.lightClunk();
        audio.boom(0.5);
        renderer.director.mode = 'orbit';
        break;

      case 'crowd-swell':
        audio.setCrowd(0.72, 1.2);
        break;

      case 'spotlight-sweep':
        lights.spot = 1;
        this.sweeping = true;
        lights.spotTargets[0].set(START_POSITIONS.red.x, 0.25, START_POSITIONS.red.z);
        lights.spotTargets[1].set(START_POSITIONS.blue.x, 0.25, START_POSITIONS.blue.z);
        break;

      case 'introduce-red': {
        // Both spots converge on the red square and the camera holds on it.
        this.sweeping = false;
        const target = new THREE.Vector3(START_POSITIONS.red.x, 0.25, START_POSITIONS.red.z);
        lights.spotTargets[0].copy(target);
        lights.spotTargets[1].copy(target);
        lights.accent = 1;
        renderer.director.mode = 'intro-red';
        announcer.say(formatLine(cue.line ?? '', redName, blueName), 0.65);
        audio.crowdReaction(0.55);
        break;
      }

      case 'introduce-blue': {
        const target = new THREE.Vector3(START_POSITIONS.blue.x, 0.25, START_POSITIONS.blue.z);
        lights.spotTargets[0].copy(target);
        lights.spotTargets[1].copy(target);
        renderer.director.mode = 'intro-blue';
        announcer.say(formatLine(cue.line ?? '', redName, blueName), 0.65);
        audio.crowdReaction(0.55);
        break;
      }

      case 'lights-full':
        // Everything comes up at once, with the relays banging over.
        lights.house = 1;
        lights.spot = 0;
        lights.accent = 0.75;
        this.sweeping = false;
        audio.lightClunk();
        audio.riser(2.6);
        audio.setCrowd(0.85, 0.8);
        flash(renderer.lightState, 0.55);
        renderer.director.mode = 'broadcast';
        break;

      case 'safety-light-red':
        renderer.setSafetyLight(false);
        break;

      case 'drivers-ready':
        announcer.say(cue.line ?? 'Drivers, take your positions.', 0.4);
        break;

      case 'count-3':
        announcer.say('Three', 0.6);
        audio.beep(520, 0.2, 0.34);
        break;

      case 'count-2':
        announcer.say('Two', 0.7);
        audio.beep(520, 0.2, 0.34);
        break;

      case 'count-1':
        announcer.say('One', 0.8);
        audio.beep(520, 0.2, 0.34);
        break;

      case 'activate':
        // The moment: horn, strobe, green light, crowd up.
        announcer.say('Activate!', 1);
        audio.beep(1040, 0.5, 0.4);
        audio.horn(1.5, 146);
        audio.setCrowd(1, 0.4);
        renderer.setSafetyLight(true);
        flash(renderer.lightState, 1);
        renderer.director.addShake(0.35);
        this.fightLive = true;
        break;
    }
  }

  /** Handle the non-cue match events: the count, the finish. */
  handleMatchEvent(event: MatchEvent): void {
    const { renderer, audio, announcer, redName, blueName } = this.ctx;

    switch (event.kind) {
      case 'cue':
        if (event.cue) this.handleCue(event.cue);
        break;

      case 'fight-start':
        this.fightLive = true;
        break;

      case 'ko-start': {
        const name = event.side === 'a' ? redName : blueName;
        announcer.say(`${name} is not moving. The count is on.`, 0.8);
        audio.setCrowd(0.9, 0.5);
        break;
      }

      case 'ko-tick':
        audio.countTick();
        if (event.count && event.count >= 8) audio.crowdReaction(0.5);
        break;

      case 'ko-reset': {
        const name = event.side === 'a' ? redName : blueName;
        announcer.say(`${name} is moving! The count is off.`, 0.9);
        audio.crowdReaction(0.7);
        break;
      }

      case 'ko-complete': {
        const loser = event.side === 'a' ? redName : blueName;
        const winner = event.side === 'a' ? blueName : redName;
        announcer.say(`That is a knockout. ${winner} beats ${loser}.`, 1);
        audio.horn(2.4, 118);
        audio.boom(0.75);
        audio.setCrowd(1, 0.3);
        flash(renderer.lightState, 1);
        renderer.director.addShake(0.5);
        renderer.setSafetyLight(false);
        this.fightLive = false;
        break;
      }

      case 'time-expired':
        announcer.say('Time! The match goes to the judges.', 0.9);
        audio.horn(2.2, 118);
        renderer.setSafetyLight(false);
        this.fightLive = false;
        break;

      case 'match-over':
        audio.setCrowd(0.95, 1.5);
        break;
    }
  }

  /** Announce the judges' verdict. */
  announceDecision(winnerName: string, summary: string): void {
    const { announcer, audio } = this.ctx;
    announcer.say(`${summary} The winner is ${winnerName}.`, 1);
    audio.crowdReaction(1);
  }
}
