/**
 * The game: screen flow, the frame loop, and the wiring between the simulation
 * and everything that presents it.
 *
 * The simulation is the source of truth. Rendering, audio and UI all read from
 * it; nothing here ever reaches back and changes the outcome of a fight.
 */

import { clamp01, mpsToMph } from './core/math';
import { Rng } from './core/rng';
import { OpponentDriver, type Difficulty } from './ai/opponent';
import { AudioEngine } from './audio/audio';
import { Announcer } from './audio/announcer';
import { ShowDirector } from './audio/showSequence';
import { InputManager } from './input/input';
import { GameRenderer, emitTyreSmoke } from './render/renderer';
import { GaragePreview } from './render/preview';
import { flash } from './render/lighting';
import { Fight } from './sim/fight';
import { MAX_FRAME_TIME, Physics, initPhysics } from './sim/physics';
import { neutralControl } from './sim/bot';
import { cloneDesign, computeStats, defaultDesign, type BotDesign } from './sim/parts';
import { pickOpponent, randomDesign } from './sim/roster';
import { Garage } from './ui/garage';
import { Hud, ResultCard } from './ui/hud';
import { LoadingScreen, TitleScreen } from './ui/menus';

export type Screen = 'loading' | 'title' | 'garage' | 'fight' | 'result';

const STORAGE_KEY = 'antiflock.design.v1';

export class Game {
  private renderer: GameRenderer;
  private input = new InputManager();
  private audio = new AudioEngine();
  private announcer: Announcer;
  private show: ShowDirector | null = null;

  private physics: Physics | null = null;
  private fight: Fight | null = null;
  private opponent = new OpponentDriver('veteran');
  private preview: GaragePreview;
  /** Seconds until the garage turntable is rebuilt, or 0 when it is current. */
  private previewDirty = 0;
  private rng = new Rng(0x5eed1e);

  private loading: LoadingScreen;
  private title: TitleScreen;
  private garage: Garage;
  private hud: Hud;
  private result: ResultCard;

  private playerDesign: BotDesign;
  private opponentDesign: BotDesign;
  private difficulty: Difficulty = 'veteran';

  screen: Screen = 'loading';
  private paused = false;
  private lastTime = 0;
  private running = false;
  private resultShown = false;
  /** Wall-clock seconds since the match ended, before the card appears. */
  private resultDelay = 0;

  /** Exposed for the end-to-end tests to drive and inspect the game. */
  readonly debugApi: Record<string, unknown>;

  constructor(private readonly container: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.id = 'scene';
    container.appendChild(canvas);

    this.renderer = new GameRenderer(canvas);
    this.preview = new GaragePreview(this.renderer.scene);
    this.announcer = new Announcer(this.audio);

    this.playerDesign = this.loadDesign();
    this.opponentDesign = pickOpponent(this.rng, this.playerDesign.name);

    this.loading = new LoadingScreen();
    this.title = new TitleScreen({
      onFight: () => void this.startFight(),
      onGarage: () => void this.openGarage(),
      onDifficulty: (level) => {
        this.difficulty = level;
        this.opponent.setDifficulty(level);
      },
    });
    this.garage = new Garage(cloneDesign(this.playerDesign), {
      onChange: (design) => this.onDesignChanged(design),
      onFight: () => void this.startFight(),
      onBack: () => this.openTitle(),
      onRandomise: () => {
        const design = randomDesign(this.rng);
        this.garage.setDesign(design);
        this.onDesignChanged(design);
      },
    });
    this.hud = new Hud();
    this.result = new ResultCard({
      onRematch: () => void this.startFight(),
      onGarage: () => void this.openGarage(),
      onTitle: () => this.openTitle(),
    });

    container.append(
      this.title.root,
      this.garage.root,
      this.hud.root,
      this.result.root,
      this.loading.root,
    );

    this.announcer.onLine((text, duration) => this.hud.showCaption(text, duration));

    this.input.onAction = (action) => this.handleAction(action);

    this.debugApi = {
      game: this,
      getScreen: () => this.screen,
      getFight: () => this.fight,
      startFight: () => this.startFight(),
      skipIntro: () => this.fight?.match.skipIntro(),
      setPlayerDesign: (design: BotDesign) => {
        this.playerDesign = design;
        this.garage.setDesign(cloneDesign(design));
      },
      setOpponentDesign: (design: BotDesign) => {
        this.opponentDesign = design;
      },
      getState: () => this.snapshot(),
      openGarage: () => this.openGarage(),
      openTitle: () => this.openTitle(),
    };
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  async boot(): Promise<void> {
    this.loading.setStatus('Loading physics');
    await initPhysics();

    this.loading.setStatus('Building the arena');
    // Yield so the loading screen actually paints before the texture work.
    await new Promise((resolve) => setTimeout(resolve, 16));
    this.renderer.buildArena();

    this.loading.setStatus('Ready');
    this.input.attach();
    window.addEventListener('resize', this.onResize);
    this.onResize();

    this.loading.hide();
    this.openTitle();

    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.frame);
  }

  private onResize = (): void => {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.renderer.resize(width, height);
  };

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  private openTitle(): void {
    this.screen = 'title';
    this.title.show();
    this.garage.hide();
    this.hud.hide();
    this.result.hide();
    this.renderer.director.mode = 'orbit';
    this.renderer.lightState.inspection = 0;
    this.renderer.lightState.house = 1;
    this.renderer.lightState.accent = 0.6;
    this.renderer.lightState.spot = 0;
    this.preview.clear();
    this.teardownFight();
  }

  private openGarage(): void {
    this.screen = 'garage';
    this.title.hide();
    this.hud.hide();
    this.result.hide();
    this.garage.show();
    this.garage.setDesign(cloneDesign(this.playerDesign));
    this.renderer.director.mode = 'garage';
    this.renderer.director.snap();
    // Light the turntable and drop the arena's fight lighting back, so the
    // robot being designed is the brightest thing on screen.
    this.renderer.lightState.inspection = 1;
    this.renderer.lightState.house = 0.45;
    this.renderer.lightState.accent = 0.5;
    this.renderer.lightState.spot = 0;
    this.teardownFight();
    this.previewDirty = 0;
    this.preview.show(this.playerDesign);
  }

  private onDesignChanged(design: BotDesign): void {
    const previous = this.playerDesign;
    this.playerDesign = cloneDesign(design);
    this.saveDesign(this.playerDesign);

    if (this.screen !== 'garage') return;
    // Only rebuild the turntable when something structural changed. Dragging
    // the armour slider or typing a name should not re-create a rigid body
    // sixty times a second.
    const rebuild =
      previous.chassisId !== design.chassisId ||
      previous.weaponId !== design.weaponId ||
      previous.driveId !== design.driveId ||
      previous.wheelId !== design.wheelId ||
      previous.armorId !== design.armorId ||
      previous.livery !== design.livery ||
      previous.name !== design.name ||
      previous.primaryColor !== design.primaryColor ||
      previous.secondaryColor !== design.secondaryColor ||
      previous.accentColor !== design.accentColor ||
      Math.abs(previous.armorThicknessMm - design.armorThicknessMm) > 0.01;
    // Debounced: typing a name or dragging a colour picker fires this on every
    // input event, and rebuilding a rigid body and a 1024px texture each time
    // would be wasteful.
    if (rebuild) this.previewDirty = 0.28;
  }

  /** Build a fresh fight and run the opening sequence. */
  async startFight(): Promise<void> {
    // Audio can only start from a user gesture, and every route into a fight
    // comes from a click or a key press.
    await this.audio.start().catch(() => {});

    this.teardownFight();
    this.preview.clear();
    this.renderer.lightState.inspection = 0;

    const stats = computeStats(this.playerDesign);
    if (!stats.legal) {
      // Should not be reachable from the UI, but never start an illegal fight.
      this.openGarage();
      return;
    }

    this.opponentDesign = pickOpponent(this.rng, this.playerDesign.name);

    this.physics = new Physics();
    this.fight = new Fight(this.physics, {
      redDesign: cloneDesign(this.playerDesign),
      blueDesign: cloneDesign(this.opponentDesign),
      hazards: true,
      seed: this.rng.int(1, 1 << 24),
    });

    this.renderer.buildBots(this.fight);
    this.opponent.reset();
    this.opponent.setDifficulty(this.difficulty);
    this.input.reset();

    this.show = new ShowDirector({
      renderer: this.renderer,
      audio: this.audio,
      announcer: this.announcer,
      redName: this.playerDesign.name,
      blueName: this.opponentDesign.name,
    });
    this.show.reset();

    this.hud.setNames(this.playerDesign.name, this.opponentDesign.name);
    this.hud.show();
    this.title.hide();
    this.garage.hide();
    this.result.hide();

    this.screen = 'fight';
    this.resultShown = false;
    this.resultDelay = 0;
    this.paused = false;

    this.fight.start();
    this.renderer.director.snap();
  }

  private teardownFight(): void {
    this.audio.stopMachines();
    this.announcer.cancel();
    this.renderer.clearBots();
    this.fight = null;
    this.show = null;
    if (this.physics) {
      this.physics.dispose();
      this.physics = null;
    }
  }

  // -------------------------------------------------------------------------
  // Input actions
  // -------------------------------------------------------------------------

  private handleAction(action: string): void {
    switch (action) {
      case 'escape':
        if (this.screen === 'fight') this.openTitle();
        else if (this.screen === 'garage') this.openTitle();
        break;
      case 'enter':
        // Enter skips the opening sequence.
        if (this.screen === 'fight' && this.fight && !this.fight.match.live) {
          this.announcer.cancel();
          this.fight.match.skipIntro();
        }
        break;
      case 'camera':
        this.cycleCamera();
        break;
      case 'mute':
        this.audio.setEnabled(!this.audio.isEnabled);
        break;
      case 'pause':
        if (this.screen === 'fight') this.paused = !this.paused;
        break;
      case 'debug':
        this.hud.toggleDebug();
        break;
    }
  }

  private cycleCamera(): void {
    const order = ['broadcast', 'chase', 'orbit'] as const;
    const current = order.indexOf(this.renderer.director.mode as (typeof order)[number]);
    this.renderer.director.mode = order[(current + 1) % order.length]!;
  }

  // -------------------------------------------------------------------------
  // Frame loop
  // -------------------------------------------------------------------------

  private frame = (now: number): void => {
    if (!this.running) return;
    // Clamp so a background tab does not fast-forward the fight on return.
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;

    this.step(dt);

    requestAnimationFrame(this.frame);
  };

  /** One frame of simulation and presentation. Exposed for the e2e tests. */
  step(dt: number): void {
    if (this.screen === 'fight' && this.fight && !this.paused) {
      this.updateFight(this.fight, dt);
    } else if (this.screen === 'garage') {
      if (this.previewDirty > 0) {
        this.previewDirty -= dt;
        if (this.previewDirty <= 0) {
          this.previewDirty = 0;
          this.preview.show(this.playerDesign);
        }
      }
      this.preview.update(dt);
    }

    this.renderer.render(this.fight, dt, this.show?.sweeping ?? false);
  }

  private updateFight(fight: Fight, dt: number): void {
    const live = fight.match.live;

    // --- Controls -------------------------------------------------------------
    // Control timing is clamped to the same ceiling the physics uses. The
    // weapon throttle ramp and the opponent's reaction lag are both measured in
    // seconds, and on a machine that cannot keep up they would otherwise run
    // ahead of the simulation they are steering.
    const controlDt = Math.min(dt, MAX_FRAME_TIME);
    const playerControl = live ? this.input.read(controlDt) : neutralControl();
    fight.setControl('a', playerControl);
    fight.setControl('b', this.opponent.drive(fight.blue, fight.red, controlDt, live));

    // --- Simulate -------------------------------------------------------------
    fight.update(dt);

    // --- Events ---------------------------------------------------------------
    for (const event of fight.drainMatchEvents()) {
      this.show?.handleMatchEvent(event);
      this.onMatchEvent(event);
    }
    for (const event of fight.drainEvents()) {
      this.onFightEvent(event);
    }

    // --- Continuous audio -----------------------------------------------------
    if (this.audio.ready) {
      for (const bot of [fight.red, fight.blue]) {
        const w = bot.stats.weapon;
        // Motor whine sits a couple of octaves above the shaft rate; dividing
        // the rated rpm down lands a 1400 rpm bar around 54 Hz at full speed,
        // which is about where a real drive whine sits.
        const voiceHz = w.rpm > 0 ? w.rpm / 26 : 60;
        this.audio.updateWeaponVoice(bot.id, bot.weaponSpinFraction, voiceHz, w.kind);
        const speedFraction = clamp01(bot.speed / Math.max(bot.stats.topSpeedMps, 0.1));
        // Load is high when the throttle is down but the robot is not moving —
        // that is a pushing match, and it should sound like one.
        const load = clamp01(Math.abs(bot.control.throttle) - speedFraction);
        this.audio.updateDriveVoice(bot.id, bot.control.throttle, speedFraction, load);
      }
    }

    // --- Tyre smoke -----------------------------------------------------------
    if (live) {
      emitTyreSmoke(this.renderer.effects, fight.red);
      emitTyreSmoke(this.renderer.effects, fight.blue);
    }

    // --- HUD ------------------------------------------------------------------
    this.hud.update(fight, dt);
    this.hud.setControlsHintVisible(live);
    if (this.hud.debugVisible) this.hud.setDebugText(this.debugText(fight));

    // --- Result ---------------------------------------------------------------
    if (fight.match.result && !this.resultShown) {
      this.resultDelay += dt;
      // Let the knockout land before covering the screen with a card.
      if (this.resultDelay > 3.4) {
        this.showResult(fight);
      }
    }
  }

  private onMatchEvent(event: ReturnType<Fight['drainMatchEvents']>[number]): void {
    if (event.kind !== 'cue' || !event.cue || !this.fight) return;

    switch (event.cue.kind) {
      case 'introduce-red':
        this.hud.showLowerThird('red', this.playerDesign.name, computeStats(this.playerDesign));
        break;
      case 'introduce-blue':
        this.hud.showLowerThird('blue', this.opponentDesign.name, computeStats(this.opponentDesign));
        break;
      case 'count-3':
        this.hud.showCountdown('3', false);
        break;
      case 'count-2':
        this.hud.showCountdown('2', false);
        break;
      case 'count-1':
        this.hud.showCountdown('1', false);
        break;
      case 'activate':
        this.hud.showCountdown('ACTIVATE', true);
        this.hud.hideLowerThird();
        break;
    }
  }

  private onFightEvent(event: ReturnType<Fight['drainEvents']>[number]): void {
    const { renderer, audio } = this;

    switch (event.kind) {
      case 'weapon-hit':
      case 'weapon-clash':
      case 'pulveriser-hit':
      case 'ram':
      case 'wall-hit': {
        renderer.effects.sparkBurst(event.point, event.intensity);
        audio.impact(event.energyJ, event.intensity);
        // Shake the camera in proportion to how big the hit was.
        renderer.director.addShake(clamp01(event.energyJ / 8000) * 0.55);
        if (event.energyJ > 2500) {
          audio.crowdReaction(clamp01(event.energyJ / 12000));
          flash(renderer.lightState, clamp01(event.energyJ / 20000) * 0.4);
        }
        break;
      }

      case 'saw-hit':
        renderer.effects.sparkBurst(event.point, event.intensity);
        audio.grind(event.intensity);
        break;

      case 'penetration':
        renderer.effects.debrisBurst(event.point, 1);
        renderer.effects.smokePuff(event.point, 0.8);
        audio.crowdReaction(0.8);
        break;

      case 'wheel-lost':
        renderer.effects.debrisBurst(event.point, 0.8);
        renderer.effects.smokePuff(event.point, 1);
        audio.crowdReaction(0.7);
        break;

      case 'weapon-dead':
        renderer.effects.smokePuff(event.point, 1);
        audio.crowdReaction(0.6);
        break;

      case 'self-right':
        audio.pneumatic();
        break;
    }
  }

  private showResult(fight: Fight): void {
    this.resultShown = true;
    const result = fight.match.result;
    if (!result) return;

    const winnerName =
      result.winner === 'a'
        ? this.playerDesign.name
        : result.winner === 'b'
          ? this.opponentDesign.name
          : 'Draw';

    if (fight.decision) {
      this.show?.announceDecision(winnerName, fight.decision.summary);
    }

    this.result.show(
      winnerName,
      result.reason,
      fight.decision,
      this.playerDesign.name,
      this.opponentDesign.name,
    );
    this.screen = 'result';
    this.audio.stopMachines();
  }

  // -------------------------------------------------------------------------
  // Support
  // -------------------------------------------------------------------------

  private debugText(fight: Fight): string {
    const red = fight.red;
    const blue = fight.blue;
    const lines = [
      `phase      ${fight.match.phase}  t=${fight.match.timeRemaining.toFixed(1)}`,
      `steps      ${fight.physics.lastStepCount}/frame   fx ${this.renderer.effects.liveCount}`,
      `render     ${(this.renderer.currentRenderScale * 100).toFixed(0)}% scale`,
      '',
      `RED  ${red.design.name}`,
      `  cond ${(fight.conditionOf('a') * 100).toFixed(0)}%  struct ${red.health.structure.toFixed(0)}`,
      `  spd  ${mpsToMph(red.speed).toFixed(1)} mph  wheels ${red.health.wheels.filter((w) => w > 0).length}/${red.health.wheels.length}`,
      `  wpn  ${(red.weaponSpinFraction * 100).toFixed(0)}%  ${(red.weaponStoredEnergyJ / 1000).toFixed(1)} kJ`,
      '',
      `BLUE ${blue.design.name}   ai:${this.opponent.currentTactic}`,
      `  cond ${(fight.conditionOf('b') * 100).toFixed(0)}%  struct ${blue.health.structure.toFixed(0)}`,
      `  spd  ${mpsToMph(blue.speed).toFixed(1)} mph  wheels ${blue.health.wheels.filter((w) => w > 0).length}/${blue.health.wheels.length}`,
      `  wpn  ${(blue.weaponSpinFraction * 100).toFixed(0)}%  ${(blue.weaponStoredEnergyJ / 1000).toFixed(1)} kJ`,
    ];
    return lines.join('\n');
  }

  /** A plain snapshot of game state, for the end-to-end tests. */
  snapshot(): Record<string, unknown> {
    const fight = this.fight;
    return {
      screen: this.screen,
      paused: this.paused,
      hasFight: fight !== null,
      phase: fight?.match.phase ?? null,
      timeRemaining: fight?.match.timeRemaining ?? null,
      redName: this.playerDesign.name,
      blueName: this.opponentDesign.name,
      redCondition: fight ? fight.conditionOf('a') : null,
      blueCondition: fight ? fight.conditionOf('b') : null,
      redPosition: fight ? { ...fight.red.position } : null,
      bluePosition: fight ? { ...fight.blue.position } : null,
      redSpin: fight?.red.weaponSpinFraction ?? null,
      result: fight?.match.result ?? null,
      audioReady: this.audio.ready,
    };
  }

  private loadDesign(): BotDesign {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultDesign();
      const parsed = JSON.parse(raw) as BotDesign;
      // Validate it still refers to parts that exist, and still makes weight.
      const stats = computeStats(parsed);
      return stats.legal ? parsed : defaultDesign();
    } catch {
      // Corrupt or unavailable storage is not worth failing a boot over.
      return defaultDesign();
    }
  }

  private saveDesign(design: BotDesign): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(design));
    } catch {
      // Private browsing, quota, or no storage at all. Not fatal.
    }
  }

  dispose(): void {
    this.running = false;
    this.input.detach();
    window.removeEventListener('resize', this.onResize);
    this.preview.clear();
    this.teardownFight();
    this.renderer.dispose();
    this.audio.dispose();
  }
}
