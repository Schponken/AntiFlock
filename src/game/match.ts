/**
 * One fight, start to finish.
 *
 * Owns the simulation and the presentation and keeps them in step: the show open,
 * the three-minute clock, the referee's count, the judges' decision, and all the
 * wiring that turns a solver contact into sparks, a bang, a camera shake and a
 * line of commentary.
 */

import * as THREE from 'three';
import { Emitter } from '../core/emitter.ts';
import { clamp, clamp01 } from '../core/mathx.ts';
import { PhysicsWorld } from '../physics/world.ts';
import { Combat, type ImpactEvent } from './combat.ts';
import { Bot, NEUTRAL_INPUT, type BotInput } from './bot.ts';
import { BotAI, type Difficulty } from './ai.ts';
import { scoreJudges, type JudgeCard } from './damage.ts';
import { StartSequence } from './startSequence.ts';
import type { BotDesign } from './design.ts';
import { LightRig } from '../render/lightRig.ts';
import { Fx } from '../render/fx.ts';
import { CameraDirector } from '../render/cameras.ts';
import type { Stage } from '../render/renderer.ts';
import { audio, type BotVoice } from '../audio/audio.ts';
import {
  announcer,
  bigHitLine,
  hazardLine,
  nearCountLine,
  partLossLine,
} from '../audio/announcer.ts';

/** Three minutes, same as the real thing. */
export const MATCH_DURATION = 180;

/**
 * Longest single frame the show is willing to advance by. Generous enough that a
 * slow renderer still runs the introductions and the clock at roughly real speed,
 * short enough that returning to a backgrounded tab does not skip the fight.
 */
const PRESENTATION_DT_CAP = 0.5;

export type MatchState = 'intro' | 'fighting' | 'knockout' | 'decision' | 'finished';

export type MatchOutcome =
  | { kind: 'ko'; winner: Bot; loser: Bot; reason: string }
  | { kind: 'decision'; winner: Bot; loser: Bot; card: JudgeCard }
  | { kind: 'draw'; card: JudgeCard };

export interface MatchEvents {
  state: { state: MatchState };
  /** Big centred card from the start sequence. */
  card: { text: string; sub?: string; kind: 'intro' | 'count' | 'go' };
  cardClear: Record<string, never>;
  caption: { text: string; emphasis: boolean };
  captionClear: Record<string, never>;
  tick: { remaining: number };
  outcome: MatchOutcome;
  /** A bot is being counted; drives the on-screen count. */
  count: { bot: Bot; seconds: number };
}

export interface MatchOptions {
  playerDesign: BotDesign;
  opponentDesign: BotDesign;
  difficulty: Difficulty;
  stage: Stage;
  /** The app owns one camera rig across every screen; the match borrows it. */
  camera: CameraDirector;
  /** Round length in seconds. Defaults to the full three minutes. */
  roundSeconds?: number;
  /** Skip the show open and start fighting immediately. */
  quickStart?: boolean;
  /**
   * Run the match logic with no meshes.
   *
   * The fight, the clock, the knockout hand-off and the judges' cards are all
   * plain bookkeeping, and none of it needs a GPU — but `Match` was reachable only
   * through a real `Stage`, so none of it was testable. `onKnockout`, the hand-off
   * from the primary win condition to the results screen, could be deleted with
   * every gate green.
   */
  headless?: boolean;
  seed?: number;
}

export class Match {
  readonly events = new Emitter<MatchEvents>();
  readonly world: PhysicsWorld;
  readonly combat: Combat;
  readonly lights: LightRig;
  readonly fx: Fx;
  readonly camera: CameraDirector;
  readonly player: Bot;
  readonly opponent: Bot;

  private stage: Stage;
  private headless: boolean;
  /** Set by `dispose`; every public entry point checks it. */
  private disposed = false;
  private ai: BotAI;
  private startSequence: StartSequence;
  private state: MatchState = 'intro';
  private remaining: number;
  private readonly roundSeconds: number;
  private outcome: MatchOutcome | null = null;
  private endTimer = 0;
  /** Pending hand-off to the results screen, so it can be cancelled. */
  private finishTimer: number | null = null;

  private voices = new Map<number, BotVoice>();
  private playerInput: BotInput = { ...NEUTRAL_INPUT };
  private hazardTimer = 24;
  private lastCommentary = 0;
  private elapsed = 0;
  private smoothExcitement = 0.35;

  private tmpVec = new THREE.Vector3();

  constructor(options: MatchOptions) {
    this.stage = options.stage;
    this.lights = new LightRig({ headless: options.headless ?? false });
    this.fx = new Fx({ headless: options.headless ?? false });
    this.roundSeconds = options.roundSeconds ?? MATCH_DURATION;
    this.remaining = this.roundSeconds;
    this.world = new PhysicsWorld();
    this.headless = options.headless ?? false;
    this.combat = new Combat(this.world, { headless: this.headless });
    this.camera = options.camera;

    this.player = this.combat.addBot(options.playerDesign, 0);
    this.opponent = this.combat.addBot(options.opponentDesign, 1);
    this.ai = new BotAI(
      this.opponent,
      this.combat.arena,
      options.difficulty,
      options.seed ?? 20240815,
    );

    if (!this.headless) {
      this.stage.scene.add(this.combat.group);
      this.stage.scene.add(this.lights.group);
      this.stage.scene.add(this.fx.group);
    }

    this.startSequence = new StartSequence({
      audio,
      announcer,
      lights: this.lights,
      camera: this.camera,
      stage: this.stage,
      red: this.player,
      blue: this.opponent,
    });

    this.wireEvents();

    if (options.quickStart) {
      this.lights.fullLights();
      this.camera.setMode('broadcast');
      this.camera.reset();
      this.startSequence.skip();
    } else {
      this.startSequence.start();
    }
  }

  // -------------------------------------------------------------------------

  /** Unsubscribers for listeners this match put on objects it does not own. */
  private subscriptions: (() => void)[] = [];

  private wireEvents(): void {
    this.startSequence.events.on('card', (card) => this.events.emit('card', card));
    this.startSequence.events.on('cardClear', () => this.events.emit('cardClear', {}));
    this.startSequence.events.on('fight', () => this.beginFight());

    /*
     * `announcer` is a module-level singleton that outlives every match, so these
     * two handlers have to come back off it. Discarding the unsubscribers meant a
     * disposed match stayed reachable from the announcer's listener list — and
     * kept emitting captions into its own dead emitter — for the lifetime of the
     * page, one more retained match (and its world, arena and meshes) per rematch.
     */
    this.subscriptions.push(
      announcer.events.on('line', ({ text, emphasis }) =>
        this.events.emit('caption', { text, emphasis }),
      ),
      announcer.events.on('lineEnd', () => this.events.emit('captionClear', {})),
    );

    this.combat.events.on('impact', (impact) => this.onImpact(impact));
    this.combat.events.on('partDestroyed', ({ bot, part, position }) => {
      this.fx.smokePuff(position, 1);
      this.fx.sparkBurst(position, new THREE.Vector3(0, 1, 0), 0.9);
      audio.impact(1, this.panFor(position));
      audio.crowdPop(1);
      this.lights.pulseWash(0.8);
      this.say(partLossLine(), true);
      // Losing your weapon or your drive is worth saying out loud.
      if (part.kind === 'weapon' || part.kind === 'wheel') {
        this.say(`${bot.name} is in trouble!`);
      }
    });

    this.combat.events.on('knockout', ({ bot, reason }) => this.onKnockout(bot, reason));

    // Continuous voices for both machines.
    for (const bot of this.combat.bots) {
      const voice = audio.createBotVoice();
      if (voice) this.voices.set(bot.id, voice);
    }
  }

  private beginFight(): void {
    if (this.state !== 'intro') return;
    this.setState('fighting');
    this.combat.start();
  }

  private setState(state: MatchState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.emit('state', { state });
  }

  getState(): MatchState {
    return this.state;
  }

  get timeRemaining(): number {
    return this.remaining;
  }

  get result(): MatchOutcome | null {
    return this.outcome;
  }

  setPlayerInput(input: BotInput): void {
    if (this.disposed) return;
    this.playerInput = input;
  }

  /** Let the player jump the show open. */
  skipIntro(): void {
    if (this.disposed) return;
    if (this.state !== 'intro') return;
    this.startSequence.skip();
  }

  // -------------------------------------------------------------------------
  // Frame update
  // -------------------------------------------------------------------------

  update(dt: number): void {
    if (this.disposed) return;
    /*
     * Two clocks, deliberately.
     *
     * The show open, the match clock and the lighting run on *wall* time, so a
     * three-minute round is three minutes and the introductions land on the beat
     * no matter what frame rate the machine manages. Only a pathological frame
     * (tab restored from the background) is clamped away.
     *
     * The physics world is handed the same figure but clamps it internally to a
     * fixed number of 480 Hz steps, so a slow frame costs simulation speed rather
     * than stability. Clamping the presentation clock as well — which is what an
     * earlier version of this did — puts the entire show into slow motion on a
     * slow renderer.
     */
    const frameDt = Math.min(dt, PRESENTATION_DT_CAP);
    this.elapsed += frameDt;

    /*
     * The cue list keeps running after the klaxon. Its last cue clears the
     * "ACTIVATE!" card a second and a half into the fight, so stopping the
     * timeline the moment the state flips to `fighting` leaves that card burned
     * onto the screen for the rest of the match.
     */
    if (this.startSequence.running) this.startSequence.update(frameDt);

    if (this.state === 'intro') {
      // Both machines sit dead in their squares until the klaxon.
      this.player.setInput(NEUTRAL_INPUT);
      this.opponent.setInput(NEUTRAL_INPUT);
    } else if (this.state === 'fighting') {
      this.player.setInput(this.playerInput);
      this.opponent.setInput(this.ai.update(frameDt, this.player));
      this.tickClock(frameDt);
      this.tickHazards(frameDt);
      this.tickCount();
    } else {
      this.player.setInput(NEUTRAL_INPUT);
      this.opponent.setInput(NEUTRAL_INPUT);
      this.endTimer += frameDt;
    }

    this.world.update(frameDt);
    this.combat.syncVisuals(frameDt);
    this.fx.update(frameDt);
    this.lights.update(frameDt);
    this.combat.arena.animateCrowd(this.elapsed);
    this.updateAudio(frameDt);
    this.updateCamera(frameDt);
  }

  private updateCamera(dt: number): void {
    const subjects =
      this.state === 'knockout' || this.state === 'decision' || this.state === 'finished'
        ? []
        : this.combat.bots;

    if (this.state === 'intro' && this.camera.getMode() === 'scripted') {
      this.camera.update(dt, subjects, this.player, this.fx.shakeAmount);
      return;
    }
    this.camera.update(
      dt,
      subjects.length > 0 ? subjects : this.combat.bots,
      this.player,
      this.fx.shakeAmount,
    );
  }

  private tickClock(dt: number): void {
    this.remaining = Math.max(0, this.remaining - dt);
    this.events.emit('tick', { remaining: this.remaining });

    if (this.remaining <= 0) this.goToDecision();
    else if (this.remaining < 10.5 && this.remaining + dt >= 10.5) {
      this.say('Ten seconds! Ten seconds left in this fight!', true);
      audio.setMusicIntensity(1);
    }
  }

  /** The box fires its own hazards on a rhythm, as the real one does. */
  private tickHazards(dt: number): void {
    this.hazardTimer -= dt;
    if (this.hazardTimer > 0) return;
    this.hazardTimer = 16 + Math.random() * 12;

    // Only fire the saws when somebody is actually near them.
    const nearCentre = this.combat.bots.some(
      (bot) => bot.position(this.tmpVec).length() < 3.4,
    );
    if (nearCentre) {
      this.combat.arena.triggerKillsaws(5);
      this.say('Killsaws are up!');
    } else {
      this.combat.arena.triggerPulverizer(Math.random() < 0.5 ? -1 : 1);
    }
  }

  /** Surface the referee's count while a machine is not moving. */
  private tickCount(): void {
    for (const bot of this.combat.bots) {
      const counting = bot.damage.immobileFor;
      if (counting > 2.5 && !bot.damage.countedOut) {
        this.events.emit('count', { bot, seconds: counting });
        if (counting > 6 && this.elapsed - this.lastCommentary > 5) {
          this.lastCommentary = this.elapsed;
          this.say(nearCountLine(), true);
        }
      }
    }
  }

  private updateAudio(dt: number): void {
    for (const bot of this.combat.bots) {
      const voice = this.voices.get(bot.id);
      if (!voice) continue;
      const pan = this.panFor(bot.position(this.tmpVec));
      if (this.state === 'fighting') {
        voice.setDrive(bot.speed, bot.speed / Math.max(1, bot.stats.topSpeed), pan);
        voice.setWeapon(
          bot.omega,
          bot.stats.weaponMaxOmega,
          bot.stats.parts.weapon.rotor?.teeth ?? 2,
        );
      } else {
        voice.silence();
      }
    }

    // Crowd noise tracks how close and how violent the fight is.
    if (this.state === 'fighting' && this.combat.bots.length >= 2) {
      const separation = this.combat.bots[0]!
        .position(this.tmpVec)
        .distanceTo(this.combat.bots[1]!.position(new THREE.Vector3()));
      const proximity = clamp01(1 - separation / 9);
      const target = 0.45 + proximity * 0.35 + this.fx.shakeAmount * 0.3;
      this.smoothExcitement += (target - this.smoothExcitement) * Math.min(1, dt * 1.5);
      audio.setCrowd(this.smoothExcitement);
      audio.setMusicIntensity(clamp(0.45 + proximity * 0.5, 0, 1));
    }
  }

  /** Stereo position of a world point, relative to where the camera is looking. */
  private panFor(position: THREE.Vector3): number {
    const view = this.camera.camera.worldToLocal(position.clone());
    return clamp(view.x / 6, -1, 1);
  }

  private onImpact(impact: ImpactEvent): void {
    const severity = clamp01(impact.severity);
    const pan = this.panFor(impact.position);

    if (impact.kind === 'weapon' || impact.kind === 'hazard') {
      this.fx.sparkBurst(impact.position, impact.normal, 0.35 + severity);
      this.lights.flashAt(impact.position, 0.4 + severity);
      audio.impact(0.4 + severity * 0.6, pan);
    } else {
      this.fx.sparkBurst(impact.position, impact.normal, severity * 0.6);
      audio.impact(0.15 + severity * 0.5, pan);
    }

    if (severity > 0.45) {
      this.fx.smokePuff(impact.position, severity);
      this.fx.scorch(impact.position, 0.5 + severity);
    }

    // Commentary, rate-limited so it never talks over itself.
    if (this.elapsed - this.lastCommentary > 3.5) {
      if (impact.kind === 'hazard') {
        this.lastCommentary = this.elapsed;
        this.say(hazardLine(), true);
      } else if (severity > 0.55) {
        this.lastCommentary = this.elapsed;
        this.say(bigHitLine(), true);
      }
    }
  }

  private onKnockout(bot: Bot, reason: 'counted-out' | 'out-of-bounds' | 'destroyed'): void {
    if (this.state !== 'fighting') return;

    const winner = this.combat.bots.find((b) => b !== bot) ?? bot;
    const reasonText =
      reason === 'out-of-bounds'
        ? 'out of the arena'
        : reason === 'destroyed'
          ? 'destroyed'
          : 'counted out';

    this.outcome = { kind: 'ko', winner, loser: bot, reason: reasonText };
    this.setState('knockout');
    this.combat.stop();

    audio.klaxon(2.2);
    audio.boom(0.6);
    audio.crowdPop(1);
    audio.setMusicIntensity(0.35);
    this.lights.pulseWash(1);
    this.lights.strobe(0.6, 1.6);
    this.fx.addShake(0.8);
    this.camera.orbitAround(bot);

    this.say(
      `${bot.name} is ${reasonText}! Winner by knockout — ${winner.name}!`,
      true,
    );
    this.events.emit('outcome', this.outcome);
    this.finishSoon();
  }

  private goToDecision(): void {
    if (this.state !== 'fighting') return;
    this.combat.stop();
    this.setState('decision');

    audio.klaxon(2);
    audio.setMusicIntensity(0.3);

    const card = scoreJudges(
      {
        damage: this.player.damageDealt,
        aggression: this.player.aggression,
        control: this.player.control,
      },
      {
        damage: this.opponent.damageDealt,
        aggression: this.opponent.aggression,
        control: this.opponent.control,
      },
    );

    if (card.draw) {
      /*
       * Nothing separated them — usually two machines that never got going. The
       * `draw` outcome exists for exactly this and was previously unreachable.
       * It carries the card too: the results screen promised "a card and a
       * report" for a draw and then had nothing to print, because the level
       * scorecard was being thrown away here.
       */
      this.outcome = { kind: 'draw', card };
      this.camera.orbitAround(this.player);
      this.say("Time! And the judges can't split them — this one is a draw!", true);
      this.events.emit('outcome', this.outcome);
      this.finishSoon();
      return;
    }

    const winner = card.winner === 0 ? this.player : this.opponent;
    const loser = card.winner === 0 ? this.opponent : this.player;
    this.outcome = { kind: 'decision', winner, loser, card };

    this.camera.orbitAround(winner);
    this.say(
      `Time! We go to the judges... and the winner by ${card.unanimous ? 'unanimous' : 'split'} decision — ${winner.name}!`,
      true,
    );
    this.events.emit('outcome', this.outcome);
    this.finishSoon();
  }

  private finishSoon(): void {
    this.endTimer = 0;
    if (this.finishTimer !== null) clearTimeout(this.finishTimer);
    // Held so quitting to the menu inside the five seconds does not leave a timer
    // that wakes up and drives a state change on a match that has been torn down.
    this.finishTimer = globalThis.setTimeout(() => {
      this.finishTimer = null;
      this.setState('finished');
    }, 5200) as unknown as number;
  }

  private say(text: string, emphasis = false): void {
    announcer.say(text, { emphasis });
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return;
    /*
     * Everything below frees WASM allocations, and Rapier answers a call on a
     * freed world with "null pointer passed to rust" rather than a JavaScript
     * error — so one stray frame from a loop that had not been told to stop took
     * the whole page down.
     */
    this.disposed = true;
    if (this.finishTimer !== null) {
      clearTimeout(this.finishTimer);
      this.finishTimer = null;
    }
    for (const off of this.subscriptions) off();
    this.subscriptions.length = 0;
    announcer.cancel();
    audio.stopMusic();
    audio.setCrowd(0);
    for (const voice of this.voices.values()) voice.stop();
    this.voices.clear();

    if (!this.headless) {
      this.stage.scene.remove(this.combat.group);
      this.stage.scene.remove(this.lights.group);
      this.stage.scene.remove(this.fx.group);
    }

    // The camera holds whichever machine it was orbiting; let it go with the rest.
    this.camera.setMode('broadcast');
    this.combat.dispose();
    this.fx.dispose();
    this.lights.dispose();
    this.events.clear();
    this.world.free();
  }
}
