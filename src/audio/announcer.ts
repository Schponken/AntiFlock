/**
 * The voice of the show.
 *
 * Uses the browser's own speech synthesis, which costs nothing to ship and is
 * available almost everywhere. Every line is also published as a caption, so the
 * presentation still lands with the sound off, on a machine with no voices
 * installed, or for anyone who reads rather than listens.
 */

import { Emitter } from '../core/emitter.ts';
import { fxRng } from '../core/rng.ts';

export interface AnnouncerEvents {
  /** A line has started; show it as a caption. */
  line: { text: string; emphasis: boolean };
  /** The line is finished and the caption can fade. */
  lineEnd: { text: string };
}

/** Voices that sound closest to a broadcast announcer, in order of preference. */
const PREFERRED_VOICES = [
  'Google UK English Male',
  'Microsoft Guy Online',
  'Microsoft David',
  'Daniel',
  'Alex',
  'Google US English',
];

export class Announcer {
  readonly events = new Emitter<AnnouncerEvents>();

  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private _enabled = true;
  private captionTimer: number | null = null;
  /** The line currently on screen, so it can always be taken back off. */
  private activeLine: string | null = null;

  constructor() {
    if (typeof globalThis.speechSynthesis !== 'undefined') {
      this.synth = globalThis.speechSynthesis;
      this.pickVoice();
      // Voice lists populate asynchronously in most browsers.
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  get available(): boolean {
    return this.synth !== null;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(value: boolean): void {
    this._enabled = value;
    if (!value) this.synth?.cancel();
  }

  private pickVoice(): void {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;
    for (const name of PREFERRED_VOICES) {
      const match = voices.find((v) => v.name === name);
      if (match) {
        this.voice = match;
        return;
      }
    }
    this.voice = voices.find((v) => v.lang.startsWith('en')) ?? voices[0]!;
  }

  /**
   * Speak a line and publish it as a caption. `emphasis` is for the big moments —
   * it raises the delivery and styles the caption accordingly.
   */
  say(text: string, options: { emphasis?: boolean; rate?: number; pitch?: number } = {}): void {
    const emphasis = options.emphasis ?? false;
    if (this.activeLine !== null) this.events.emit('lineEnd', { text: this.activeLine });
    this.activeLine = text;
    this.events.emit('line', { text, emphasis });

    // Captions clear on their own whether or not speech actually runs.
    if (this.captionTimer !== null) clearTimeout(this.captionTimer);
    const readingTime = 900 + text.length * 55;
    this.captionTimer = globalThis.setTimeout(() => {
      this.activeLine = null;
      this.events.emit('lineEnd', { text });
    }, readingTime) as unknown as number;

    if (!this._enabled || !this.synth) return;

    try {
      /*
       * Cut, do not queue.
       *
       * `speechSynthesis.speak` appends to a queue that runs at whatever pace the
       * platform voice reads at, with no relation to the show's timeline. Over a
       * 23-second open with eight cued lines that queue drifts seconds behind the
       * lights and the countdown, and the voice ends up calling the introductions
       * over the top of the fight. Cancelling first makes every cue land on its
       * cue: the announcer is always saying the line the show is currently on,
       * exactly as a live commentator dropping a sentence to call the next beat.
       */
      this.synth.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      if (this.voice) utterance.voice = this.voice;
      utterance.rate = options.rate ?? (emphasis ? 0.95 : 1.05);
      utterance.pitch = options.pitch ?? (emphasis ? 0.7 : 0.85);
      utterance.volume = 1;
      this.synth.speak(utterance);
    } catch {
      // Speech is a bonus, never a requirement — the caption already went out.
    }
  }

  /** Drop anything queued, e.g. when the player quits to the menu mid-sentence. */
  cancel(): void {
    this.synth?.cancel();
    if (this.captionTimer !== null) {
      clearTimeout(this.captionTimer);
      this.captionTimer = null;
    }
    // The caption timer was the only thing that ever hid a caption, so cancelling
    // it silently — which is what skipping the show open did — left the last
    // introduction burned across the screen for the whole fight.
    if (this.activeLine !== null) {
      const text = this.activeLine;
      this.activeLine = null;
      this.events.emit('lineEnd', { text });
    }
  }
}

// ---------------------------------------------------------------------------
// Colour commentary
// ---------------------------------------------------------------------------

const BIG_HIT_LINES = [
  'OH! Right on the money!',
  'That is a huge hit!',
  'Parts are coming off!',
  'He got underneath him and sent him flying!',
  'Look at the height on that!',
  'That one hurt. That one really hurt.',
];

const PART_LOSS_LINES = [
  'There goes a wheel!',
  'Armour is off! That panel is gone!',
  'The weapon has stopped! Something is broken in there!',
  'It is coming apart in front of us!',
];

const HAZARD_LINES = [
  'Straight into the killsaws!',
  'The pulveriser catches him flush!',
  'The screws have got him!',
];

const NEAR_COUNT_LINES = [
  'He is not moving! The count is on!',
  'Come on, show us something! Anything!',
  'That could be the fight right there.',
];

export const bigHitLine = (): string => fxRng.pick(BIG_HIT_LINES);
export const partLossLine = (): string => fxRng.pick(PART_LOSS_LINES);
export const hazardLine = (): string => fxRng.pick(HAZARD_LINES);
export const nearCountLine = (): string => fxRng.pick(NEAR_COUNT_LINES);

export const announcer = new Announcer();
