/**
 * The in-fight overlay: health bars, the clock, the referee's count, the
 * countdown, announcer captions and the broadcast lower-thirds.
 *
 * Kept as plain DOM over the canvas rather than drawn in WebGL, because
 * broadcast graphics are flat, text-heavy and crisp — which is exactly what the
 * DOM is good at.
 */

import { clamp01, formatClock, mpsToMph } from '../core/math';
import type { Fight } from '../sim/fight';
import type { Decision } from '../sim/judging';
import { KO_COUNT } from '../sim/match';
import type { BotStats } from '../sim/parts';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface BotPanel {
  root: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  ghost: HTMLElement;
  weaponFill: HTMLElement;
  meterText: HTMLElement;
  /** The ghost bar lags the real one, so a big hit is visible. */
  ghostValue: number;
}

export class Hud {
  readonly root: HTMLElement;

  private red!: BotPanel;
  private blue!: BotPanel;
  private clockTime!: HTMLElement;
  private clockLabel!: HTMLElement;
  private koCount!: HTMLElement;
  private koNumber!: HTMLElement;
  private koLabel!: HTMLElement;
  private caption!: HTMLElement;
  private captionTimer = 0;
  private lowerThird!: HTMLElement;
  private lowerThirdCorner!: HTMLElement;
  private lowerThirdName!: HTMLElement;
  private lowerThirdSpec!: HTMLElement;
  private lowerThirdTimer = 0;
  private countdown!: HTMLElement;
  private countdownTimer = 0;
  private debug!: HTMLElement;
  private controlsHint!: HTMLElement;

  debugVisible = false;

  constructor() {
    this.root = el('div', 'layer hidden');
    this.root.id = 'hud';
    this.build();
  }

  private build(): void {
    // --- Top bar --------------------------------------------------------------
    const top = el('div', 'hud-top');
    this.red = this.buildBotPanel('red');
    this.blue = this.buildBotPanel('blue');

    const clock = el('div', 'hud-clock');
    this.clockTime = el('div', 'hud-clock-time', '3:00');
    this.clockLabel = el('div', 'hud-clock-label', 'Round 1');
    clock.append(this.clockTime, this.clockLabel);

    top.append(this.red.root, clock, this.blue.root);
    this.root.appendChild(top);

    // --- Referee count --------------------------------------------------------
    this.koCount = el('div', 'ko-count hidden');
    this.koLabel = el('div', 'ko-count-label', 'Count');
    this.koNumber = el('div', 'ko-count-number', '1');
    this.koCount.append(this.koLabel, this.koNumber);
    this.root.appendChild(this.koCount);

    // --- Countdown ------------------------------------------------------------
    this.countdown = el('div', 'layer hidden');
    this.countdown.id = 'countdown';
    this.root.appendChild(this.countdown);

    // --- Announcer caption ----------------------------------------------------
    this.caption = el('div', 'caption');
    this.root.appendChild(this.caption);

    // --- Lower third ----------------------------------------------------------
    this.lowerThird = el('div', 'lower-third');
    this.lowerThirdCorner = el('div', 'lower-third-corner', 'Red Square');
    this.lowerThirdName = el('div', 'lower-third-name', '');
    this.lowerThirdSpec = el('div', 'lower-third-spec', '');
    this.lowerThird.append(this.lowerThirdCorner, this.lowerThirdName, this.lowerThirdSpec);
    this.root.appendChild(this.lowerThird);

    // --- Controls hint --------------------------------------------------------
    this.controlsHint = el('div', 'controls-hint');
    for (const [key, action] of [
      ['WASD', 'Drive'],
      ['Space', 'Weapon'],
      ['F', 'Fire'],
      ['R', 'Self-right'],
      ['C', 'Camera'],
    ] as const) {
      const item = el('div');
      const kbd = el('kbd', undefined, key);
      item.appendChild(kbd);
      item.appendChild(document.createTextNode(action));
      this.controlsHint.appendChild(item);
    }
    this.root.appendChild(this.controlsHint);

    // --- Debug ----------------------------------------------------------------
    this.debug = el('div', 'hidden');
    this.debug.id = 'debug';
    this.root.appendChild(this.debug);
  }

  private buildBotPanel(side: 'red' | 'blue'): BotPanel {
    const root = el('div', `hud-bot ${side}`);
    const name = el('div', 'hud-name', side === 'red' ? 'RED' : 'BLUE');

    const health = el('div', 'hud-health');
    const ghost = el('div', 'hud-health-ghost');
    const fill = el('div', 'hud-health-fill');
    ghost.style.width = '100%';
    fill.style.width = '100%';
    health.append(ghost, fill);

    const meters = el('div', 'hud-meters');
    const weaponMeter = el('div', 'hud-weapon-meter');
    const weaponFill = el('div', 'hud-weapon-fill');
    weaponMeter.appendChild(weaponFill);
    const meterText = el('span', undefined, '0 rpm');
    if (side === 'red') meters.append(weaponMeter, meterText);
    else meters.append(meterText, weaponMeter);

    root.append(name, health, meters);
    return { root, name, fill, ghost, weaponFill, meterText, ghostValue: 1 };
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
    this.hideLowerThird();
    this.koCount.classList.add('hidden');
  }

  setNames(redName: string, blueName: string): void {
    this.red.name.textContent = redName;
    this.blue.name.textContent = blueName;
  }

  /** Update everything that changes every frame. */
  update(fight: Fight, dt: number): void {
    // --- Health ---------------------------------------------------------------
    for (const [panel, side] of [
      [this.red, 'a'],
      [this.blue, 'b'],
    ] as const) {
      const value = clamp01(fight.conditionOf(side));
      panel.fill.style.width = `${value * 100}%`;
      // The ghost catches up slowly, leaving a white flash on the bar.
      panel.ghostValue = Math.max(value, panel.ghostValue - dt * 0.22);
      panel.ghost.style.width = `${panel.ghostValue * 100}%`;

      const bot = fight.botFor(side);
      const spin = bot.weaponSpinFraction;
      panel.weaponFill.style.width = `${spin * 100}%`;

      if (bot.stats.weapon.kind === 'none') {
        panel.meterText.textContent = 'no weapon';
      } else if (bot.weaponDead) {
        panel.meterText.textContent = 'WEAPON OUT';
      } else if (bot.stats.weapon.rpm > 0) {
        panel.meterText.textContent = `${Math.round(spin * bot.stats.weapon.rpm)} rpm`;
      } else {
        panel.meterText.textContent = bot.burstReady
          ? 'ARMED'
          : `${Math.round(bot.burstCharge * 100)}%`;
      }
    }

    // --- Clock ----------------------------------------------------------------
    const remaining = fight.match.timeRemaining;
    this.clockTime.textContent = formatClock(remaining);
    this.clockTime.classList.toggle('urgent', remaining <= 15 && fight.match.live);

    switch (fight.match.phase) {
      case 'intro':
      case 'countdown':
        this.clockLabel.textContent = 'Get Ready';
        break;
      case 'fight':
      case 'knockout':
        this.clockLabel.textContent = 'Fight';
        break;
      case 'decision':
        this.clockLabel.textContent = 'Judging';
        break;
      case 'over':
        this.clockLabel.textContent = 'Final';
        break;
      default:
        this.clockLabel.textContent = 'Standby';
    }

    // --- Referee's count ------------------------------------------------------
    const koA = fight.match.ko.a;
    const koB = fight.match.ko.b;
    const active = koA.counting ? koA : koB.counting ? koB : null;
    const countingSide = koA.counting ? 'a' : 'b';
    if (active && fight.match.live) {
      this.koCount.classList.remove('hidden');
      this.koNumber.textContent = String(Math.min(KO_COUNT, active.displayed));
      const name = fight.botFor(countingSide).design.name;
      this.koLabel.textContent = `${name} — count`;
    } else {
      this.koCount.classList.add('hidden');
    }

    // --- Timers ---------------------------------------------------------------
    if (this.captionTimer > 0) {
      this.captionTimer -= dt;
      if (this.captionTimer <= 0) this.caption.classList.remove('visible');
    }
    if (this.lowerThirdTimer > 0) {
      this.lowerThirdTimer -= dt;
      if (this.lowerThirdTimer <= 0) this.hideLowerThird();
    }
    if (this.countdownTimer > 0) {
      this.countdownTimer -= dt;
      if (this.countdownTimer <= 0) this.countdown.classList.add('hidden');
    }
  }

  /** Show an announcer line as a caption. */
  showCaption(text: string, durationMs: number): void {
    this.caption.textContent = text;
    this.caption.classList.add('visible');
    this.captionTimer = durationMs / 1000 + 0.4;
  }

  /** The big 3 / 2 / 1 / ACTIVATE numbers. */
  showCountdown(text: string, isGo: boolean): void {
    this.countdown.replaceChildren();
    const number = el('div', `countdown-number${isGo ? ' go' : ''}`, text);
    this.countdown.appendChild(number);
    this.countdown.classList.remove('hidden');
    this.countdownTimer = isGo ? 1.1 : 0.9;
  }

  /** Broadcast-style name card during the introductions. */
  showLowerThird(side: 'red' | 'blue', name: string, stats: BotStats): void {
    this.lowerThird.className = `lower-third ${side} visible`;
    this.lowerThirdCorner.textContent = side === 'red' ? 'Red Square' : 'Blue Square';
    this.lowerThirdName.textContent = name;

    const spec = [
      `${stats.totalMassLb.toFixed(0)} lb`,
      stats.weapon.kind === 'none' ? 'no weapon' : stats.weapon.name,
      `${mpsToMph(stats.topSpeedMps).toFixed(0)} mph`,
      stats.weapon.kind === 'none'
        ? `${stats.armor.name}`
        : `${(stats.weaponEnergyJ / 1000).toFixed(0)} kJ`,
    ].join('   ·   ');
    this.lowerThirdSpec.textContent = spec;

    this.lowerThirdTimer = 2.6;
  }

  hideLowerThird(): void {
    this.lowerThird.classList.remove('visible');
    this.lowerThirdTimer = 0;
  }

  setControlsHintVisible(visible: boolean): void {
    this.controlsHint.classList.toggle('hidden', !visible);
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debug.classList.toggle('hidden', !this.debugVisible);
  }

  setDebugText(text: string): void {
    if (this.debugVisible) this.debug.textContent = text;
  }
}

/** The end-of-match card, including the judges' scorecards. */
export class ResultCard {
  readonly root: HTMLElement;
  private head!: HTMLElement;
  private winnerName!: HTMLElement;
  private reason!: HTMLElement;
  private scores!: HTMLElement;

  constructor(
    private readonly callbacks: {
      onRematch: () => void;
      onGarage: () => void;
      onTitle: () => void;
    },
  ) {
    this.root = el('div', 'layer interactive hidden');
    this.root.id = 'result';
    this.build();
  }

  private build(): void {
    const card = el('div', 'result-card');
    this.head = el('div', 'result-head', 'Match Result');
    const winner = el('div', 'result-winner');
    this.winnerName = el('div', 'result-winner-name', '');
    this.reason = el('div', 'result-reason', '');
    winner.append(this.winnerName, this.reason);

    this.scores = el('div', 'result-scores');

    const actions = el('div', 'result-actions');
    const rematch = el('button', 'primary', 'Rematch');
    rematch.addEventListener('click', () => this.callbacks.onRematch());
    const garage = el('button', '', 'Back to Garage');
    garage.addEventListener('click', () => this.callbacks.onGarage());
    const title = el('button', 'ghost', 'Main Menu');
    title.addEventListener('click', () => this.callbacks.onTitle());
    actions.append(rematch, garage, title);

    card.append(this.head, winner, this.scores, actions);
    this.root.appendChild(card);
  }

  show(
    winnerName: string,
    reason: 'knockout' | 'decision' | 'draw' | 'none',
    decision: Decision | null,
    redName: string,
    blueName: string,
  ): void {
    this.winnerName.textContent = reason === 'draw' ? 'Draw' : winnerName;
    this.reason.textContent =
      reason === 'knockout'
        ? 'Knockout'
        : reason === 'decision'
          ? 'Judges’ Decision'
          : reason === 'draw'
            ? 'Nobody could separate them'
            : '';

    this.scores.replaceChildren();
    if (decision) {
      const table = el('table', 'judge-table');
      const thead = el('thead');
      const headRow = el('tr');
      for (const label of ['', redName, blueName]) headRow.appendChild(el('th', undefined, label));
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = el('tbody');
      const categories: [string, (j: Decision['judges'][number]) => [number, number]][] = [
        ['Damage', (j) => [j.damage.a, j.damage.b]],
        ['Aggression', (j) => [j.aggression.a, j.aggression.b]],
        ['Control', (j) => [j.control.a, j.control.b]],
      ];
      for (const [label, pick] of categories) {
        const row = el('tr');
        row.appendChild(el('td', undefined, label));
        const totals = decision.judges.reduce(
          (acc, j) => {
            const [a, b] = pick(j);
            return [acc[0] + a, acc[1] + b] as [number, number];
          },
          [0, 0] as [number, number],
        );
        row.appendChild(el('td', undefined, String(totals[0])));
        row.appendChild(el('td', undefined, String(totals[1])));
        tbody.appendChild(row);
      }

      const totalRow = el('tr', 'total');
      totalRow.appendChild(el('td', undefined, 'Total'));
      totalRow.appendChild(el('td', undefined, String(decision.totalA)));
      totalRow.appendChild(el('td', undefined, String(decision.totalB)));
      tbody.appendChild(totalRow);

      table.appendChild(tbody);
      this.scores.appendChild(table);
      this.scores.appendChild(
        el('div', 'result-reason', decision.unanimous ? 'Unanimous' : 'Split decision'),
      );
    }

    this.head.textContent = reason === 'knockout' ? 'Knockout' : 'Match Result';
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}
