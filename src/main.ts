/**
 * Application shell: screens, the render loop, and the wiring between the
 * simulation and everything the player sees and hears.
 */

import * as THREE from 'three';
import './style.css';

import { initRapier } from './physics/world.ts';
import { Stage, type QualityLevel } from './render/renderer.ts';
import { CameraDirector } from './render/cameras.ts';
import { Match } from './game/match.ts';
import { Builder } from './ui/builder.ts';
import { Hud } from './ui/hud.ts';
import { InputManager } from './game/input.ts';
import {
  PRESETS,
  cloneDesign,
  computeStats,
  isBuildable,
  loadDesign,
  makeDefaultDesign,
  presetById,
  saveDesign,
  type BotDesign,
} from './game/design.ts';
import type { Difficulty } from './game/ai.ts';
import { audio } from './audio/audio.ts';
import { announcer } from './audio/announcer.ts';
import { button, clear, el } from './ui/dom.ts';
import { kgToLb, mpsToMph } from './core/mathx.ts';
import { makeArenaFloor } from './render/textures.ts';
import { getRenderProfile } from './render/profile.ts';

type Screen = 'loading' | 'title' | 'builder' | 'opponent' | 'fight' | 'results';

/**
 * Longest frame the game will advance by in one step.
 *
 * This has to be generous. On a weak or software renderer a frame can easily take
 * half a second, and clamping harder than that does not make the game faster — it
 * just runs the show open, the match clock and the camera in slow motion while the
 * player watches. Physics protects itself separately by capping how many fixed
 * steps it will take per frame.
 */
const MAX_FRAME_DT = 0.5;

class App {
  private stage: Stage;
  private camera = new CameraDirector();
  private uiRoot: HTMLElement;
  private hud = new Hud();
  private input = new InputManager();

  private screen: Screen = 'loading';
  private screenRoot: HTMLElement;
  private match: Match | null = null;
  private builder: Builder | null = null;

  private playerDesign: BotDesign;
  private opponentId = 'meridian';
  private difficulty: Difficulty = 'veteran';
  private skipIntro = false;
  private roundSeconds = 180;

  /** Lights and a floor for the menu and workshop, so they are never a black void. */
  private showroom = new THREE.Group();

  private lastFrame = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.uiRoot = uiRoot;
    this.stage = new Stage({ canvas, quality: detectQuality() });
    this.stage.attachCamera(this.camera.camera);
    this.playerDesign = loadDesign() ?? makeDefaultDesign();

    this.screenRoot = el('div', { class: 'screens' });
    this.uiRoot.append(this.screenRoot, this.hud.root);

    this.buildShowroom();
    this.stage.scene.add(this.showroom);

    globalThis.addEventListener('resize', () => this.stage.resize());
    this.stage.resize();

    // Audio can only start after a gesture, so the first interaction unlocks it.
    const unlock = () => {
      void audio.unlock();
    };
    globalThis.addEventListener('pointerdown', unlock, { once: true });
    globalThis.addEventListener('keydown', unlock, { once: true });

    this.input.attach();
  }

  /** A simple turntable set: dark floor, key light, two coloured rims. */
  private buildShowroom(): void {
    const floorMaps = makeArenaFloor();
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(4.2, 64),
      new THREE.MeshStandardMaterial({
        map: floorMaps.map,
        normalMap: floorMaps.normalMap,
        roughnessMap: floorMaps.roughnessMap,
        metalness: 0.85,
        roughness: 0.45,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.showroom.add(floor);

    // A three-point set-up. The workshop is the only place the player really
    // looks at their machine, so it gets enough light to read the panel work.
    const key = new THREE.SpotLight(0xfff0dd, 700, 30, Math.PI / 3.6, 0.55, 1.3);
    key.position.set(3.4, 6.2, 4.6);
    key.castShadow = getRenderProfile().shadows;
    key.shadow.mapSize.set(1024, 1024);
    this.showroom.add(key, key.target);

    const fill = new THREE.SpotLight(0xd8e4ff, 240, 26, Math.PI / 3, 0.7, 1.2);
    fill.position.set(-4.2, 4.4, 3.4);
    this.showroom.add(fill, fill.target);

    const rimRed = new THREE.PointLight(0xff3b30, 140, 18, 2);
    rimRed.position.set(-3.6, 1.9, -2.6);
    const rimBlue = new THREE.PointLight(0x2b6bff, 140, 18, 2);
    rimBlue.position.set(3.4, 1.6, -3.2);
    this.showroom.add(rimRed, rimBlue);
    this.showroom.add(new THREE.HemisphereLight(0x8fa6c4, 0x14100c, 1.1));
  }

  private setShowroomVisible(visible: boolean): void {
    this.showroom.visible = visible;
  }

  // -------------------------------------------------------------------------
  // Screens
  // -------------------------------------------------------------------------

  private setScreen(screen: Screen): void {
    this.screen = screen;
    clear(this.screenRoot);
    this.screenRoot.classList.toggle('screens--hidden', screen === 'fight');

    switch (screen) {
      case 'title':
        this.renderTitle();
        break;
      case 'builder':
        this.renderBuilder();
        break;
      case 'opponent':
        this.renderOpponent();
        break;
      case 'fight':
        break;
      case 'results':
        this.renderResults();
        break;
      case 'loading':
        this.renderLoading();
        break;
    }
  }

  private renderLoading(): void {
    this.screenRoot.append(
      el(
        'section',
        { class: 'screen screen--center' },
        el('h1', { class: 'logo', text: 'ANTIFLOCK' }),
        el('p', { class: 'muted', text: 'Warming up the solver…' }),
      ),
    );
  }

  private renderTitle(): void {
    this.setShowroomVisible(true);
    this.camera.setMode('orbit');
    this.disposeBuilder();
    this.showPlayerBotInShowroom();

    const stats = computeStats(this.playerDesign);

    this.screenRoot.append(
      el(
        'section',
        { class: 'screen screen--title' },
        el(
          'div',
          { class: 'title__brand' },
          el('span', { class: 'eyebrow', text: 'Robot Combat League' }),
          el('h1', { class: 'logo', text: 'ANTIFLOCK' }),
          el('p', {
            class: 'tagline',
            text: 'Two machines. Two hundred and fifty pounds each. One box.',
          }),
        ),
        el(
          'div',
          { class: 'title__panel' },
          el('span', { class: 'eyebrow', text: 'Your machine' }),
          el('h2', { class: 'title__bot', text: this.playerDesign.name }),
          el('p', {
            class: 'muted',
            text: `${stats.parts.weapon.name} · ${kgToLb(stats.totalMass).toFixed(0)} lb · ${mpsToMph(stats.topSpeed).toFixed(0)} mph`,
          }),
          el(
            'div',
            { class: 'title__actions' },
            button('ENTER THE BOX', () => this.setScreen('opponent'), { variant: 'primary' }),
            button('WORKSHOP', () => this.setScreen('builder')),
          ),
          this.buildSettingsPanel(),
        ),
        el(
          'footer',
          { class: 'title__controls' },
          el('span', { text: 'W A S D drive' }),
          el('span', { text: 'SHIFT weapon' }),
          el('span', { text: 'SPACE fire' }),
          el('span', { text: 'R self-right' }),
          el('span', { text: 'C camera' }),
        ),
      ),
    );
  }

  private buildSettingsPanel(): HTMLElement {
    const settings = audio.getSettings();

    const volume = el('input', {
      type: 'range',
      class: 'slider__input',
      min: 0,
      max: 1,
      step: 0.05,
      value: settings.master,
    });
    volume.addEventListener('input', () => {
      void audio.unlock();
      audio.setSettings({ master: Number(volume.value) });
    });

    const music = el('input', {
      type: 'range',
      class: 'slider__input',
      min: 0,
      max: 1,
      step: 0.05,
      value: settings.music,
    });
    music.addEventListener('input', () => audio.setSettings({ music: Number(music.value) }));

    const voice = el('input', { type: 'checkbox', checked: announcer.enabled });
    voice.addEventListener('change', () => announcer.setEnabled(voice.checked));

    const skip = el('input', { type: 'checkbox', checked: this.skipIntro });
    skip.addEventListener('change', () => {
      this.skipIntro = skip.checked;
    });

    const round = el('select', { class: 'select', 'aria-label': 'Round length' });
    for (const [seconds, label] of [
      [60, '1 minute'],
      [120, '2 minutes'],
      [180, '3 minutes'],
    ] as [number, string][]) {
      const option = el('option', { value: seconds, text: label });
      if (seconds === this.roundSeconds) option.selected = true;
      round.append(option);
    }
    round.addEventListener('change', () => {
      this.roundSeconds = Number(round.value);
    });

    const quality = el('select', { class: 'select' });
    for (const level of ['high', 'medium', 'low'] as QualityLevel[]) {
      const option = el('option', { value: level, text: level[0]!.toUpperCase() + level.slice(1) });
      if (level === this.stage.getQuality()) option.selected = true;
      quality.append(option);
    }
    quality.addEventListener('change', () => {
      this.stage.setQuality(quality.value as QualityLevel);
      this.stage.resize();
    });

    return el(
      'details',
      { class: 'settings' },
      el('summary', { text: 'Settings' }),
      el('label', { class: 'settings__row' }, el('span', { text: 'Master volume' }), volume),
      el('label', { class: 'settings__row' }, el('span', { text: 'Music' }), music),
      el('label', { class: 'settings__row' }, el('span', { text: 'Announcer voice' }), voice),
      el('label', { class: 'settings__row' }, el('span', { text: 'Skip the show open' }), skip),
      el('label', { class: 'settings__row' }, el('span', { text: 'Round length' }), round),
      el('label', { class: 'settings__row' }, el('span', { text: 'Graphics' }), quality),
    );
  }

  /** Preview mesh shown on the title screen turntable. */
  private previewGroup: THREE.Group | null = null;

  private showPlayerBotInShowroom(): void {
    this.clearShowroomBot();
    const builder = new Builder(this.playerDesign, {
      onFight: () => undefined,
      onBack: () => undefined,
    });
    // Reuse the builder's preview construction, then throw the DOM away.
    this.previewGroup = builder.previewGroup;
    this.showroom.add(this.previewGroup);
    this.titlePreviewBuilder = builder;
  }

  private titlePreviewBuilder: Builder | null = null;

  private clearShowroomBot(): void {
    if (this.previewGroup) {
      this.showroom.remove(this.previewGroup);
      this.previewGroup = null;
    }
    this.titlePreviewBuilder?.dispose();
    this.titlePreviewBuilder = null;
  }

  private renderBuilder(): void {
    this.setShowroomVisible(true);
    this.camera.setMode('orbit');
    this.clearShowroomBot();

    this.builder = new Builder(this.playerDesign, {
      onFight: (design) => {
        this.playerDesign = design;
        this.setScreen('opponent');
      },
      onBack: () => {
        /*
         * Persist on the way out, not only on the way to a fight.
         *
         * `saveDesign` was reachable from SAVE & FIGHT alone, so a player who
         * edited a machine and pressed Back saw the title screen quite correctly
         * showing their new build — and lost every change on reload. The title
         * screen was telling them the opposite of what had been stored.
         */
        const edited = this.builder?.currentDesign;
        if (edited) {
          this.playerDesign = edited;
          if (isBuildable(edited)) saveDesign(edited);
        }
        this.setScreen('title');
      },
    });
    this.showroom.add(this.builder.previewGroup);
    this.screenRoot.append(this.builder.root);
  }

  private disposeBuilder(): void {
    if (!this.builder) return;
    this.showroom.remove(this.builder.previewGroup);
    this.builder.dispose();
    this.builder = null;
  }

  private renderOpponent(): void {
    this.setShowroomVisible(true);
    this.camera.setMode('orbit');
    this.disposeBuilder();
    this.clearShowroomBot();

    const grid = el('div', { class: 'opponents' });
    for (const preset of PRESETS) {
      const stats = computeStats(preset.design);
      const card = el(
        'button',
        {
          type: 'button',
          class: `opponent ${this.opponentId === preset.id ? 'is-selected' : ''}`,
        },
        el('h3', { text: preset.label }),
        el('p', { class: 'muted', text: preset.tagline }),
        el('p', {
          class: 'opponent__stats',
          text: `${stats.parts.weapon.name} · ${kgToLb(stats.totalMass).toFixed(0)} lb · ${mpsToMph(stats.topSpeed).toFixed(0)} mph${stats.weaponEnergy > 0 ? ` · ${(stats.weaponEnergy / 1000).toFixed(0)} kJ` : ''}`,
        }),
      );
      card.addEventListener('click', () => {
        this.opponentId = preset.id;
        this.renderOpponentSelection(grid);
      });
      grid.append(card);
    }

    const difficultyRow = el('div', { class: 'difficulty' });
    for (const level of ['rookie', 'veteran', 'champion'] as Difficulty[]) {
      const node = button(
        level.toUpperCase(),
        () => {
          this.difficulty = level;
          this.renderOpponent();
        },
        { className: `chip ${this.difficulty === level ? 'is-active' : ''}` },
      );
      difficultyRow.append(node);
    }

    this.screenRoot.append(
      el(
        'section',
        { class: 'screen screen--opponent' },
        el('span', { class: 'eyebrow', text: 'Tonight’s main event' }),
        el('h2', { class: 'screen__title', text: 'Choose your opponent' }),
        grid,
        el(
          'div',
          { class: 'opponent__footer' },
          el('div', {}, el('span', { class: 'eyebrow', text: 'Driver skill' }), difficultyRow),
          el(
            'div',
            { class: 'opponent__actions' },
            button('← Back', () => this.setScreen('title'), { variant: 'ghost' }),
            button('FIGHT', () => this.beginMatch(), { variant: 'primary' }),
          ),
        ),
      ),
    );
  }

  private renderOpponentSelection(grid: HTMLElement): void {
    const cards = grid.querySelectorAll('.opponent');
    PRESETS.forEach((preset, index) => {
      cards[index]?.classList.toggle('is-selected', preset.id === this.opponentId);
    });
  }

  /**
   * Start a fight, and put something readable on screen if it cannot start.
   *
   * `void this.startMatch()` swallowed every rejection — and the first thing it
   * awaits is `audio.unlock()`, a promise the platform is entitled to reject. A
   * player whose browser refused to resume an audio context got a dead FIGHT
   * button and nothing else. The startup path already does this properly.
   */
  private beginMatch(): void {
    void this.startMatch().catch((error: unknown) => {
      console.error('AntiFlock could not start the fight', error);
      this.disposeMatch();
      this.screenRoot.replaceChildren(
        el(
          'section',
          { class: 'screen screen--center' },
          el('h2', { text: 'Could not start the fight' }),
          el('p', { class: 'muted', text: String(error) }),
          button('← Back', () => this.setScreen('title'), { variant: 'ghost' }),
        ),
      );
    });
  }

  private async startMatch(): Promise<void> {
    // A key still held on the results screen must not eat the first FIRE of the
    // next fight; the edge detectors only advance while a fight is being sampled.
    this.input.resetEdges();
    await audio.unlock();
    this.disposeBuilder();
    this.clearShowroomBot();
    this.setShowroomVisible(false);
    this.disposeMatch();

    this.match = new Match({
      playerDesign: cloneDesign(this.playerDesign),
      opponentDesign: cloneDesign(presetById(this.opponentId).design),
      difficulty: this.difficulty,
      stage: this.stage,
      camera: this.camera,
      roundSeconds: this.roundSeconds,
      quickStart: this.skipIntro,
    });

    this.hud.attach(this.match);
    this.match.events.on('state', ({ state }) => {
      if (state === 'finished') this.setScreen('results');
    });

    this.setScreen('fight');
  }

  private renderResults(): void {
    const outcome = this.match?.result;
    this.hud.detach();

    const body: HTMLElement[] = [];
    if (outcome?.kind === 'draw') {
      // A fight neither machine did anything in still gets a card and a report.
      body.push(
        el('span', { class: 'eyebrow', text: 'Judges’ decision' }),
        el('h2', { class: 'results__winner', text: 'Draw' }),
        el('p', { class: 'muted', text: 'Nothing on the cards separated them.' }),
      );
    } else if (outcome) {
      body.push(
        el('span', { class: 'eyebrow', text: outcome.kind === 'ko' ? 'Knockout' : 'Judges’ decision' }),
        el('h2', { class: 'results__winner', text: outcome.winner.design.name }),
        el('p', {
          class: 'muted',
          text:
            outcome.kind === 'ko'
              ? `${outcome.loser.design.name} was ${outcome.reason}.`
              : `${outcome.card.unanimous ? 'Unanimous' : 'Split'} decision.`,
        }),
      );

      if (outcome.kind === 'decision') {
        const rows: [string, number, number][] = [
          ['Damage', outcome.card.damage[0], outcome.card.damage[1]],
          ['Aggression', outcome.card.aggression[0], outcome.card.aggression[1]],
          ['Control', outcome.card.control[0], outcome.card.control[1]],
          ['Total', outcome.card.total[0], outcome.card.total[1]],
        ];
        body.push(
          el(
            'table',
            { class: 'scorecard' },
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                el('th', { text: '' }),
                el('th', { text: this.match!.player.design.name }),
                el('th', { text: this.match!.opponent.design.name }),
              ),
            ),
            el(
              'tbody',
              {},
              ...rows.map(([label, a, b]) =>
                el(
                  'tr',
                  { class: label === 'Total' ? 'is-total' : '' },
                  el('td', { text: label }),
                  el('td', { text: a.toFixed(1) }),
                  el('td', { text: b.toFixed(1) }),
                ),
              ),
            ),
          ),
        );
      }

    }

    if (outcome) {
      // Post-fight damage report for the player's machine.
      const player = this.match!.player;
      const lost = player.damage.parts.filter((p) => p.destroyed);
      body.push(
        el(
          'div',
          { class: 'results__report' },
          el('span', { class: 'eyebrow', text: 'Your machine' }),
          el('p', {
            text: `${(player.damage.integrity * 100).toFixed(0)}% structural integrity · ${(player.damage.mobility * 100).toFixed(0)}% drive · ${(player.damage.weaponCondition * 100).toFixed(0)}% weapon`,
          }),
          el('p', {
            class: 'muted',
            text: lost.length
              ? `Lost: ${lost.map((p) => p.label).join(', ')}`
              : 'Came home in one piece.',
          }),
        ),
      );
    } else {
      body.push(el('h2', { class: 'results__winner', text: 'No result' }));
    }

    this.screenRoot.append(
      el(
        'section',
        { class: 'screen screen--center results' },
        ...body,
        el(
          'div',
          { class: 'results__actions' },
          button('REMATCH', () => this.beginMatch(), { variant: 'primary' }),
          button('WORKSHOP', () => {
            this.disposeMatch();
            this.setScreen('builder');
          }),
          button('MAIN MENU', () => {
            this.disposeMatch();
            this.setScreen('title');
          }, { variant: 'ghost' }),
        ),
      ),
    );
  }

  private disposeMatch(): void {
    if (!this.match) return;
    this.hud.detach();
    this.match.dispose();
    this.match = null;
  }

  // -------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    this.setScreen('loading');
    await initRapier();
    this.setScreen('title');
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    const dt = Math.min(MAX_FRAME_DT, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    if (this.screen === 'fight' && this.match) {
      const input = this.input.sample();
      this.match.setPlayerInput(input);

      // Any input during the show open skips it.
      if (this.match.getState() === 'intro' && this.input.consumeAnyPress()) {
        this.match.skipIntro();
      } else {
        this.input.consumeAnyPress();
      }

      if (this.input.consumeCameraToggle()) {
        const next = this.camera.getMode() === 'broadcast' ? 'chase' : 'broadcast';
        this.camera.setMode(next);
      }

      this.match.update(dt);
      this.hud.update();
    } else {
      this.builder?.update(dt);
      this.titlePreviewBuilder?.update(dt);
      this.camera.update(dt, [], null, 0);
      this.input.consumeAnyPress();
      this.input.consumeCameraToggle();
    }

    this.stage.render(dt);
  };

  stop(): void {
    this.running = false;
    this.input.detach();
    this.disposeMatch();
    this.disposeBuilder();
  }
}

/** Pick an initial quality tier from what the device tells us about itself. */
function detectQuality(): QualityLevel {
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const coarse = globalThis.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (coarse || memory <= 4 || cores <= 4) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------

const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
const uiRoot = document.getElementById('ui-root');

if (canvas && uiRoot) {
  const fail = (error: unknown): void => {
    console.error('AntiFlock failed to start', error);
    uiRoot.append(
      el(
        'section',
        { class: 'screen screen--center' },
        el('h2', { text: 'Could not start' }),
        el('p', {
          class: 'muted',
          text: 'This machine could not open a WebGL 2 context. Check that hardware acceleration is enabled and that the browser is up to date.',
        }),
        el('p', { class: 'muted', text: String(error) }),
      ),
    );
  };

  /*
   * The App constructor is inside the guard too, and that is the whole point.
   * It builds the WebGLRenderer, which throws synchronously on a machine with no
   * usable GPU context — before `start()` is ever reached — so the friendly
   * failure screen that was written for exactly that case could never be shown
   * for exactly that case. The user got a blank black page and a console trace.
   */
  try {
    const app = new App(canvas, uiRoot);
    void app.start().catch(fail);
    // Expose for the end-to-end smoke test.
    (globalThis as unknown as { __antiflock?: unknown }).__antiflock = app;
  } catch (error) {
    fail(error);
  }
}
