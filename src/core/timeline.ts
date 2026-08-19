/**
 * A cue list. Used for the show open, where a dozen lighting, audio, camera and
 * announcer beats have to land at exact times relative to each other.
 */

interface Cue {
  at: number;
  label: string;
  fn: () => void;
  fired: boolean;
}

export class Timeline {
  private cues: Cue[] = [];
  private time = 0;
  private _running = false;

  /** Schedule `fn` to run `at` seconds after the timeline starts. */
  add(at: number, label: string, fn: () => void): this {
    this.cues.push({ at, label, fn, fired: false });
    this.cues.sort((a, b) => a.at - b.at);
    return this;
  }

  get duration(): number {
    return this.cues.length === 0 ? 0 : this.cues[this.cues.length - 1]!.at;
  }

  get elapsed(): number {
    return this.time;
  }

  get running(): boolean {
    return this._running;
  }

  get finished(): boolean {
    return this.time >= this.duration && this.cues.every((c) => c.fired);
  }

  start(): void {
    this.time = 0;
    this._running = true;
    for (const cue of this.cues) cue.fired = false;
  }

  stop(): void {
    this._running = false;
  }

  update(dt: number): void {
    if (!this._running) return;
    this.time += dt;
    for (const cue of this.cues) {
      if (!cue.fired && this.time >= cue.at) {
        cue.fired = true;
        cue.fn();
      }
    }
    if (this.finished) this._running = false;
  }

  /**
   * Mark everything as done without running it. The caller is responsible for
   * putting the world into the end state — firing twenty cues at once would
   * stack every sound effect on the same millisecond.
   */
  skip(): void {
    for (const cue of this.cues) cue.fired = true;
    this.time = this.duration;
    this._running = false;
  }

  reset(): void {
    this.time = 0;
    this._running = false;
    for (const cue of this.cues) cue.fired = false;
  }
}
