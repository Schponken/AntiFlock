/**
 * The announcer.
 *
 * Uses the browser's speech synthesis where it exists, picking a deep voice and
 * pushing the rate and pitch toward the way a ring announcer actually delivers
 * a line. Where speech is unavailable — some headless browsers, some locked
 * down environments — it falls back to a synthesised "call": a short burst of
 * pitched tones with the cadence of the line, so the beat of the sequence is
 * still there even in silence.
 *
 * Nothing in the game waits on the announcer. Lines are fire-and-forget, and
 * the caption is always shown on screen regardless.
 */

import type { AudioEngine } from './audio';

export type AnnouncerListener = (text: string, durationMs: number) => void;

/** Roughly how long a line takes to say, for the caption timing. */
function estimateDuration(text: string): number {
  const words = text.trim().split(/\s+/).length;
  return Math.max(700, words * 340 + 400);
}

export class Announcer {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private voiceResolved = false;
  private listeners: AnnouncerListener[] = [];
  /** Turn speech off but keep the captions and the fallback tones. */
  speechEnabled = true;

  constructor(private readonly audio: AudioEngine) {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      this.synth = window.speechSynthesis;
      // Voices load asynchronously in most browsers.
      this.pickVoice();
      this.synth.addEventListener?.('voiceschanged', () => this.pickVoice());
    }
  }

  /** Subscribe to lines, so the HUD can caption them. */
  onLine(listener: AnnouncerListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private pickVoice(): void {
    if (!this.synth) return;
    const voices = this.synth.getVoices();
    if (voices.length === 0) return;

    // Prefer a deep English male voice; these names cover the common engines.
    const preferred = [
      'Google UK English Male',
      'Microsoft Guy',
      'Microsoft David',
      'Daniel',
      'Alex',
      'Fred',
    ];
    for (const name of preferred) {
      const match = voices.find((v) => v.name.includes(name));
      if (match) {
        this.voice = match;
        this.voiceResolved = true;
        return;
      }
    }
    this.voice = voices.find((v) => v.lang.startsWith('en')) ?? voices[0] ?? null;
    this.voiceResolved = true;
  }

  /**
   * Say a line.
   *
   * `intensity` shapes the delivery: 0 is a calm introduction, 1 is a shout.
   */
  say(text: string, intensity = 0.5): void {
    const duration = estimateDuration(text);
    for (const listener of this.listeners) listener(text, duration);

    if (!this.speechEnabled) {
      this.tonalFallback(text, intensity);
      return;
    }

    if (this.synth && this.voiceResolved) {
      try {
        const utterance = new SpeechSynthesisUtterance(text);
        if (this.voice) utterance.voice = this.voice;
        utterance.rate = 0.94 + intensity * 0.22;
        utterance.pitch = 0.6 + intensity * 0.35;
        utterance.volume = 1;
        this.synth.speak(utterance);
        return;
      } catch {
        // Fall through to the tonal version.
      }
    }

    this.tonalFallback(text, intensity);
  }

  /**
   * When there is no speech engine, play the *shape* of the line: one short
   * tone per word, rising on emphasis. It is not speech, but it keeps the
   * rhythm of the sequence intact.
   */
  private tonalFallback(text: string, intensity: number): void {
    if (!this.audio.ready) return;
    const words = text.trim().split(/\s+/);
    const base = 150 + intensity * 90;
    words.forEach((word, i) => {
      const emphasis = word.endsWith('!') ? 1.5 : 1;
      window.setTimeout(() => {
        this.audio.beep(base * emphasis * (1 + (i % 3) * 0.08), 0.1, 0.13 + intensity * 0.1);
      }, i * 250);
    });
  }

  /** Stop anything mid-sentence, for example when the intro is skipped. */
  cancel(): void {
    this.synth?.cancel();
  }
}
