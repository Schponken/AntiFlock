/**
 * The broadcast overlay: name plates with damage bars, the match clock, weapon
 * charge, the referee's count, announcer captions, and the big cards the show
 * open throws up between camera moves.
 */

import { clamp01 } from '../core/mathx.ts';
import { kgToLb, mpsToMph } from '../core/mathx.ts';
import type { Bot } from '../game/bot.ts';
import type { Match, MatchOutcome } from '../game/match.ts';
import { clear, el } from './dom.ts';

interface BotPlate {
  root: HTMLElement;
  integrity: HTMLElement;
  mobility: HTMLElement;
  weapon: HTMLElement;
  charge: HTMLElement;
  chargeText: HTMLElement;
  status: HTMLElement;
}

export class Hud {
  readonly root: HTMLElement;

  private clock: HTMLElement;
  private plates = new Map<number, BotPlate>();
  private card: HTMLElement;
  private caption: HTMLElement;
  private countBanner: HTMLElement;
  private telemetry: HTMLElement;
  private match: Match | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor() {
    this.clock = el('div', { class: 'hud__clock' }, '3:00');
    this.card = el('div', { class: 'hud__card' });
    this.caption = el('div', { class: 'hud__caption' });
    this.countBanner = el('div', { class: 'hud__count' });
    this.telemetry = el('div', { class: 'hud__telemetry' });

    this.root = el(
      'div',
      { class: 'hud' },
      el('div', { class: 'hud__top' }, this.clock),
      el('div', { class: 'hud__plates' }),
      this.countBanner,
      this.card,
      this.caption,
      this.telemetry,
    );
  }

  attach(match: Match): void {
    this.detach();
    this.match = match;

    const plateRow = this.root.querySelector('.hud__plates')!;
    clear(plateRow);
    this.plates.clear();

    for (const bot of [match.player, match.opponent]) {
      const plate = this.buildPlate(bot, bot === match.player);
      plateRow.append(plate.root);
      this.plates.set(bot.id, plate);
    }

    this.unsubscribers.push(
      match.events.on('tick', ({ remaining }) => this.setClock(remaining)),
      match.events.on('card', ({ text, sub, kind }) => this.showCard(text, sub, kind)),
      match.events.on('cardClear', () => this.hideCard()),
      match.events.on('caption', ({ text, emphasis }) => this.showCaption(text, emphasis)),
      match.events.on('captionClear', () => this.hideCaption()),
      match.events.on('count', ({ bot, seconds }) => this.showCount(bot, seconds)),
      match.events.on('outcome', (outcome) => this.showOutcome(outcome)),
    );

    this.setClock(match.timeRemaining);
    this.root.classList.add('hud--live');
  }

  detach(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    this.match = null;
    this.root.classList.remove('hud--live');
    this.hideCard();
    this.hideCaption();
    this.countBanner.classList.remove('is-visible');
  }

  private buildPlate(bot: Bot, isPlayer: boolean): BotPlate {
    const integrity = el('i', { class: 'bar__fill' });
    const mobility = el('i', { class: 'bar__fill bar__fill--mobility' });
    const weapon = el('i', { class: 'bar__fill bar__fill--weapon' });
    const charge = el('i', { class: 'charge__fill' });
    const chargeText = el('span', { class: 'charge__text' }, '0 kJ');
    const status = el('div', { class: 'plate__status' });

    const root = el(
      'div',
      { class: `plate plate--${bot.team === 0 ? 'red' : 'blue'} ${isPlayer ? 'plate--player' : ''}` },
      el(
        'div',
        { class: 'plate__head' },
        el('span', { class: 'plate__name', text: bot.design.name }),
        el('span', {
          class: 'plate__weight',
          text: `${Math.round(kgToLb(bot.stats.totalMass))} lb`,
        }),
      ),
      el('div', { class: 'plate__sub', text: bot.stats.parts.weapon.name }),
      el('div', { class: 'bar bar--integrity' }, integrity),
      el(
        'div',
        { class: 'plate__meters' },
        el('div', { class: 'meter' }, el('span', { text: 'DRIVE' }), el('div', { class: 'bar bar--small' }, mobility)),
        el('div', { class: 'meter' }, el('span', { text: 'WEAPON' }), el('div', { class: 'bar bar--small' }, weapon)),
      ),
      el(
        'div',
        { class: 'charge' },
        el('div', { class: 'charge__track' }, charge),
        chargeText,
      ),
      status,
    );

    return { root, integrity, mobility, weapon, charge, chargeText, status };
  }

  private setClock(remaining: number): void {
    const total = Math.max(0, Math.ceil(remaining));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    this.clock.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
    this.clock.classList.toggle('is-urgent', remaining <= 10.5);
  }

  showCard(text: string, sub: string | undefined, kind: 'intro' | 'count' | 'go'): void {
    clear(this.card);
    this.card.append(el('div', { class: 'hud__card-text', text }));
    if (sub) this.card.append(el('div', { class: 'hud__card-sub', text: sub }));
    this.card.className = `hud__card is-visible hud__card--${kind}`;
    // Restart the pop animation on every card.
    this.card.style.animation = 'none';
    void this.card.offsetHeight;
    this.card.style.animation = '';
  }

  hideCard(): void {
    this.card.classList.remove('is-visible');
  }

  showCaption(text: string, emphasis: boolean): void {
    this.caption.textContent = text;
    this.caption.classList.add('is-visible');
    this.caption.classList.toggle('is-emphasis', emphasis);
  }

  hideCaption(): void {
    this.caption.classList.remove('is-visible');
  }

  private showCount(bot: Bot, seconds: number): void {
    const left = Math.max(0, Math.ceil(10 - seconds));
    this.countBanner.textContent = `${bot.design.name.toUpperCase()} — COUNT ${left}`;
    this.countBanner.classList.add('is-visible');
    this.countBanner.classList.toggle('is-critical', left <= 3);
  }

  private showOutcome(outcome: MatchOutcome): void {
    this.countBanner.classList.remove('is-visible');
    if (outcome.kind === 'ko') {
      this.showCard(
        'KNOCKOUT',
        `${outcome.winner.design.name.toUpperCase()} WINS — ${outcome.loser.design.name.toUpperCase()} ${outcome.reason.toUpperCase()}`,
        'go',
      );
    } else if (outcome.kind === 'decision') {
      this.showCard(
        'JUDGES’ DECISION',
        `${outcome.winner.design.name.toUpperCase()} WINS ${outcome.card.total[outcome.card.winner].toFixed(0)}–${outcome.card.total[outcome.card.winner === 0 ? 1 : 0].toFixed(0)}`,
        'go',
      );
    } else {
      this.showCard('JUDGES’ DECISION', 'DRAW — NOTHING TO SEPARATE THEM', 'go');
    }
  }

  /** Per-frame refresh of everything that moves continuously. */
  update(): void {
    const match = this.match;
    if (!match) return;

    for (const bot of [match.player, match.opponent]) {
      const plate = this.plates.get(bot.id);
      if (!plate) continue;

      const integrity = clamp01(bot.damage.integrity);
      plate.integrity.style.width = `${integrity * 100}%`;
      plate.integrity.classList.toggle('is-critical', integrity < 0.3);
      plate.mobility.style.width = `${clamp01(bot.damage.mobility) * 100}%`;
      plate.weapon.style.width = `${clamp01(bot.damage.weaponCondition) * 100}%`;

      const charge = clamp01(bot.weaponCharge);
      plate.charge.style.width = `${charge * 100}%`;
      const kj = bot.weaponEnergy / 1000;
      plate.chargeText.textContent =
        bot.stats.weaponMaxOmega > 0
          ? `${kj.toFixed(1)} kJ · ${Math.round(mpsToMph(bot.weaponTipSpeed))} mph tip`
          : bot.stats.parts.weapon.actuator
            ? `${bot.actuatorShots} shots left`
            : 'no active weapon';

      const flags: string[] = [];
      if (bot.inverted) flags.push(bot.stats.invertible ? 'INVERTED (OK)' : 'ON ITS BACK');
      if (bot.damage.mobility <= 0.5 && bot.damage.mobility > 0) flags.push('DRIVE DAMAGED');
      if (bot.damage.mobility <= 0) flags.push('IMMOBILE');
      if (bot.damage.weaponCondition <= 0) flags.push('WEAPON DEAD');
      plate.status.textContent = flags.join(' · ');
      plate.status.classList.toggle('is-visible', flags.length > 0);
    }

    // The player's own telemetry, bottom-left.
    const player = match.player;
    this.telemetry.textContent = [
      `${mpsToMph(player.speed).toFixed(0)} mph`,
      `${(player.damage.integrity * 100).toFixed(0)}% integrity`,
      player.stats.weaponMaxOmega > 0
        ? `${((Math.abs(player.omega) * 60) / (Math.PI * 2)).toFixed(0)} rpm`
        : '',
    ]
      .filter(Boolean)
      .join('   ·   ');

    /*
     * Clear the referee's count the moment the machine gets going again.
     *
     * The banner was only ever raised by a `count` event and only ever lowered at
     * the end of the fight — and a bot that starts moving simply stops emitting
     * the event, it does not emit anything to say it recovered. So one near-count
     * left "COUNT 4" burned across the screen for the rest of the match. Deriving
     * it from live state instead of an event edge cannot get stuck.
     */
    const beingCounted = [match.player, match.opponent].some(
      (bot) => !bot.damage.countedOut && bot.damage.immobileFor > 2.5,
    );
    if (!beingCounted || match.getState() !== 'fighting') {
      this.countBanner.classList.remove('is-visible');
    }
  }
}
