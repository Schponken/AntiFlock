/**
 * The sound of fight night, synthesised from scratch.
 *
 * There are no audio files in this project. Every motor whine, spinner shriek,
 * impact, klaxon and drum beat is built out of oscillators and shaped noise at
 * runtime, which keeps the download tiny and lets the mix react continuously to
 * the simulation — a rotor's pitch really is its RPM, and an impact's brightness
 * really is its energy.
 */

import { clamp, clamp01 } from '../core/mathx.ts';
import { fxRng } from '../core/rng.ts';

const NOTE = {
  E1: 41.2,
  G1: 49.0,
  A1: 55.0,
  B1: 61.74,
  C2: 65.41,
  D2: 73.42,
  E2: 82.41,
} as const;

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
}

/** Per-bot continuous voice: drive whine plus weapon spin. */
export class BotVoice {
  private engine: AudioEngine;
  private ctx: AudioContext;

  private driveOsc: OscillatorNode;
  private driveGain: GainNode;
  private driveFilter: BiquadFilterNode;

  private weaponOsc: OscillatorNode;
  private weaponSub: OscillatorNode;
  private weaponGain: GainNode;
  private weaponFilter: BiquadFilterNode;
  private bladeGain: GainNode;
  private bladeOsc: OscillatorNode;

  private panner: StereoPannerNode;
  private stopped = false;

  constructor(engine: AudioEngine, destination: AudioNode) {
    this.engine = engine;
    const ctx = engine.context!;
    this.ctx = ctx;

    this.panner = ctx.createStereoPanner();
    this.panner.connect(destination);

    // --- Drive: a gearbox whine that tracks wheel speed ---------------------
    this.driveFilter = ctx.createBiquadFilter();
    this.driveFilter.type = 'lowpass';
    this.driveFilter.frequency.value = 900;
    this.driveFilter.Q.value = 3;
    this.driveFilter.connect(this.panner);

    this.driveGain = ctx.createGain();
    this.driveGain.gain.value = 0;
    this.driveGain.connect(this.driveFilter);

    this.driveOsc = ctx.createOscillator();
    this.driveOsc.type = 'sawtooth';
    this.driveOsc.frequency.value = 60;
    this.driveOsc.connect(this.driveGain);
    this.driveOsc.start();

    // --- Weapon: a rising shriek with a sub and a blade-pass thrum ---------
    this.weaponFilter = ctx.createBiquadFilter();
    this.weaponFilter.type = 'bandpass';
    this.weaponFilter.frequency.value = 1400;
    this.weaponFilter.Q.value = 1.4;
    this.weaponFilter.connect(this.panner);

    this.weaponGain = ctx.createGain();
    this.weaponGain.gain.value = 0;
    this.weaponGain.connect(this.weaponFilter);

    this.weaponOsc = ctx.createOscillator();
    this.weaponOsc.type = 'sawtooth';
    this.weaponOsc.frequency.value = 100;
    this.weaponOsc.connect(this.weaponGain);
    this.weaponOsc.start();

    this.weaponSub = ctx.createOscillator();
    this.weaponSub.type = 'triangle';
    this.weaponSub.frequency.value = 50;
    this.weaponSub.connect(this.weaponGain);
    this.weaponSub.start();

    // The low "wub wub" of teeth passing, which is what a big rotor really sounds like.
    this.bladeGain = ctx.createGain();
    this.bladeGain.gain.value = 0;
    this.bladeGain.connect(this.panner);
    this.bladeOsc = ctx.createOscillator();
    this.bladeOsc.type = 'sine';
    this.bladeOsc.frequency.value = 20;
    this.bladeOsc.connect(this.bladeGain);
    this.bladeOsc.start();
  }

  /** `pan` is -1..1, `speed` in m/s, `throttle` 0..1. */
  setDrive(speed: number, throttle: number, pan: number): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    this.panner.pan.setTargetAtTime(clamp(pan, -1, 1), t, 0.08);
    const load = clamp01(Math.abs(throttle));
    this.driveOsc.frequency.setTargetAtTime(58 + speed * 26, t, 0.06);
    this.driveFilter.frequency.setTargetAtTime(600 + speed * 220, t, 0.08);
    this.driveGain.gain.setTargetAtTime(load * 0.055 * this.engine.sfxScale, t, 0.09);
  }

  /** `omega` in rad/s, `teeth` the number of impact teeth on the rotor. */
  setWeapon(omega: number, maxOmega: number, teeth: number): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    const magnitude = Math.abs(omega);
    const ratio = maxOmega > 0 ? clamp01(magnitude / maxOmega) : 0;

    // Fundamental follows the shaft; the ear reads that as "spinning up".
    const shaftHz = magnitude / (Math.PI * 2);
    this.weaponOsc.frequency.setTargetAtTime(clamp(shaftHz * 3.1, 20, 3200), t, 0.12);
    this.weaponSub.frequency.setTargetAtTime(clamp(shaftHz * 1.05, 18, 900), t, 0.12);
    this.weaponFilter.frequency.setTargetAtTime(700 + ratio * 3600, t, 0.15);
    this.weaponGain.gain.setTargetAtTime(ratio * 0.075 * this.engine.sfxScale, t, 0.14);

    this.bladeOsc.frequency.setTargetAtTime(clamp(shaftHz * Math.max(1, teeth), 4, 260), t, 0.1);
    this.bladeGain.gain.setTargetAtTime(ratio * 0.05 * this.engine.sfxScale, t, 0.12);
  }

  silence(): void {
    if (this.stopped) return;
    const t = this.ctx.currentTime;
    this.driveGain.gain.setTargetAtTime(0, t, 0.1);
    this.weaponGain.gain.setTargetAtTime(0, t, 0.2);
    this.bladeGain.gain.setTargetAtTime(0, t, 0.2);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const t = this.ctx.currentTime;
    for (const osc of [this.driveOsc, this.weaponOsc, this.weaponSub, this.bladeOsc]) {
      try {
        osc.stop(t + 0.15);
      } catch {
        // Already stopped: nothing to do.
      }
    }
  }
}

export class AudioEngine {
  context: AudioContext | null = null;

  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private ambienceBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private crowdGain: GainNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdSource: AudioBufferSourceNode | null = null;
  private roomGain: GainNode | null = null;

  private settings: AudioSettings = { master: 0.8, music: 0.5, sfx: 1 };
  /** The one sustained riser voice, so it can be cut short. */
  private riserVoice: { osc: OscillatorNode; gain: GainNode } | null = null;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private musicIntensity = 0.6;
  private musicRunning = false;

  get enabled(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  get sfxScale(): number {
    return this.settings.sfx;
  }

  /**
   * Browsers only allow audio after a gesture, so this is called from the first
   * click. Safe to call repeatedly.
   */
  async unlock(): Promise<void> {
    if (!this.context) {
      const Ctor =
        globalThis.AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor();
      this.build();
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  private build(): void {
    const ctx = this.context!;

    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.knee.value = 22;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.22;
    compressor.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.master;
    this.master.connect(compressor);

    // A short convolution gives the box its concrete-hall tail.
    const room = ctx.createConvolver();
    room.buffer = this.makeImpulseResponse(1.7, 2.6);
    this.roomGain = ctx.createGain();
    this.roomGain.gain.value = 0.24;
    room.connect(this.roomGain);
    this.roomGain.connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfx;
    this.sfxBus.connect(this.master);
    this.sfxBus.connect(room);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.music;
    this.musicBus.connect(this.master);

    this.ambienceBus = ctx.createGain();
    this.ambienceBus.gain.value = 0.9;
    this.ambienceBus.connect(this.master);

    this.noiseBuffer = this.makeNoiseBuffer(2);
    this.buildCrowd();
  }

  private makeNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.context!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = fxRng.range(-1, 1);
    return buffer;
  }

  /** Exponentially decaying noise: a cheap, convincing concrete room. */
  private makeImpulseResponse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.context!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        data[i] = fxRng.range(-1, 1) * (1 - i / length) ** decay;
      }
    }
    return buffer;
  }

  private buildCrowd(): void {
    const ctx = this.context!;
    this.crowdFilter = ctx.createBiquadFilter();
    this.crowdFilter.type = 'bandpass';
    this.crowdFilter.frequency.value = 700;
    this.crowdFilter.Q.value = 0.6;

    this.crowdGain = ctx.createGain();
    this.crowdGain.gain.value = 0;

    this.crowdSource = ctx.createBufferSource();
    this.crowdSource.buffer = this.noiseBuffer;
    this.crowdSource.loop = true;
    this.crowdSource.connect(this.crowdFilter);
    this.crowdFilter.connect(this.crowdGain);
    this.crowdGain.connect(this.ambienceBus!);
    this.crowdSource.start();
  }

  setSettings(partial: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...partial };
    if (!this.context) return;
    const t = this.context.currentTime;
    this.master?.gain.setTargetAtTime(this.settings.master, t, 0.05);
    this.musicBus?.gain.setTargetAtTime(this.settings.music, t, 0.05);
    this.sfxBus?.gain.setTargetAtTime(this.settings.sfx, t, 0.05);
  }

  getSettings(): AudioSettings {
    return { ...this.settings };
  }

  createBotVoice(): BotVoice | null {
    if (!this.context || !this.sfxBus) return null;
    return new BotVoice(this, this.sfxBus);
  }

  /** 0 = empty room, 1 = on their feet. */
  setCrowd(excitement: number): void {
    if (!this.context || !this.crowdGain || !this.crowdFilter) return;
    const t = this.context.currentTime;
    const level = clamp01(excitement);
    this.crowdGain.gain.setTargetAtTime(0.02 + level * 0.2, t, 0.6);
    this.crowdFilter.frequency.setTargetAtTime(600 + level * 900, t, 0.6);
  }

  /** A sharp swell when something spectacular happens. */
  crowdPop(intensity = 1): void {
    if (!this.context || !this.crowdGain) return;
    const t = this.context.currentTime;
    const current = this.crowdGain.gain.value;
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdGain.gain.setValueAtTime(current, t);
    this.crowdGain.gain.linearRampToValueAtTime(
      Math.min(0.55, current + 0.3 * clamp01(intensity)),
      t + 0.12,
    );
    this.crowdGain.gain.setTargetAtTime(current, t + 0.35, 1.4);
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  private noiseBurst(options: {
    duration: number;
    gain: number;
    type: BiquadFilterType;
    frequency: number;
    q: number;
    pan: number;
    sweepTo?: number;
  }): void {
    const ctx = this.context;
    if (!ctx || !this.sfxBus || !this.noiseBuffer) return;
    const t = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    source.playbackRate.value = fxRng.range(0.85, 1.2);

    const filter = ctx.createBiquadFilter();
    filter.type = options.type;
    filter.frequency.setValueAtTime(options.frequency, t);
    if (options.sweepTo !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(40, options.sweepTo),
        t + options.duration,
      );
    }
    filter.Q.value = options.q;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(options.gain, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + options.duration);

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(options.pan, -1, 1);

    source.connect(filter).connect(gain).connect(panner).connect(this.sfxBus);
    source.start(t);
    source.stop(t + options.duration + 0.02);
  }

  private tone(options: {
    type: OscillatorType;
    from: number;
    to: number;
    duration: number;
    gain: number;
    pan?: number;
    delay?: number;
    destination?: AudioNode;
  }): void {
    const ctx = this.context;
    if (!ctx || !this.sfxBus) return;
    const t = ctx.currentTime + (options.delay ?? 0);

    const osc = ctx.createOscillator();
    osc.type = options.type;
    osc.frequency.setValueAtTime(options.from, t);
    if (options.to !== options.from) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, options.to), t + options.duration);
    }

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(options.gain, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + options.duration);

    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(options.pan ?? 0, -1, 1);

    osc.connect(gain).connect(panner).connect(options.destination ?? this.sfxBus);
    osc.start(t);
    osc.stop(t + options.duration + 0.02);
  }

  /**
   * A metal-on-metal impact. `intensity` 0-1 chooses how much of the hit is a
   * bright shower of sparks versus a deep structural bang.
   */
  impact(intensity: number, pan = 0): void {
    const level = clamp01(intensity);
    // The crack.
    this.noiseBurst({
      duration: 0.09 + level * 0.13,
      gain: 0.28 + level * 0.5,
      type: 'bandpass',
      frequency: 2600 + level * 3200,
      sweepTo: 700,
      q: 0.9,
      pan,
    });
    // The structure ringing.
    this.tone({
      type: 'triangle',
      from: 140 + level * 90,
      to: 46,
      duration: 0.22 + level * 0.5,
      gain: 0.22 + level * 0.42,
      pan,
    });
    // Ringing overtone that sells "this is a big steel plate".
    if (level > 0.25) {
      this.tone({
        type: 'sine',
        from: 900 + fxRng.range(0, 700),
        to: 620,
        duration: 0.3 + level * 0.5,
        gain: 0.06 + level * 0.12,
        pan,
        delay: 0.01,
      });
    }
    if (level > 0.55) this.crowdPop(level);
  }

  /** Sparks skittering off armour. */
  grind(intensity: number, pan = 0): void {
    this.noiseBurst({
      duration: 0.06 + intensity * 0.08,
      gain: 0.09 + intensity * 0.18,
      type: 'highpass',
      frequency: 3600,
      q: 0.7,
      pan,
    });
  }

  /** Pneumatics firing. */
  pneumatic(pan = 0): void {
    this.noiseBurst({
      duration: 0.3,
      gain: 0.34,
      type: 'highpass',
      frequency: 1800,
      sweepTo: 5200,
      q: 0.6,
      pan,
    });
    this.tone({ type: 'square', from: 220, to: 70, duration: 0.16, gain: 0.16, pan });
  }

  /** The arena klaxon that starts and ends a fight. */
  klaxon(duration = 1.6): void {
    for (let i = 0; i < 3; i++) {
      this.tone({
        type: 'sawtooth',
        from: 220,
        to: 218,
        duration,
        gain: 0.16,
        delay: 0,
        pan: i === 0 ? 0 : i === 1 ? -0.4 : 0.4,
      });
      this.tone({
        type: 'square',
        from: 330 + i * 2,
        to: 328,
        duration,
        gain: 0.09,
        pan: i === 0 ? 0 : i === 1 ? -0.4 : 0.4,
      });
    }
    this.crowdPop(1);
  }

  /** Countdown blip. The final one is higher and longer. */
  countdownBeep(final = false): void {
    this.tone({
      type: 'square',
      from: final ? 1320 : 880,
      to: final ? 1320 : 880,
      duration: final ? 0.55 : 0.14,
      gain: 0.2,
    });
    this.tone({
      type: 'sine',
      from: final ? 660 : 440,
      to: final ? 660 : 440,
      duration: final ? 0.55 : 0.14,
      gain: 0.14,
    });
  }

  /** The heavy clunk of stadium lighting contactors closing. */
  lightThunk(): void {
    this.tone({ type: 'sine', from: 90, to: 34, duration: 0.5, gain: 0.4 });
    this.noiseBurst({
      duration: 0.16,
      gain: 0.2,
      type: 'lowpass',
      frequency: 900,
      sweepTo: 180,
      q: 1,
      pan: 0,
    });
  }

  /** Rising drone under the introductions. */
  riser(duration = 3.5): void {
    const ctx = this.context;
    if (!ctx || !this.sfxBus) return;
    this.stopRiser();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(55, t);
    osc.frequency.exponentialRampToValueAtTime(440, t + duration);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(300, t);
    filter.frequency.exponentialRampToValueAtTime(6000, t + duration);
    filter.Q.value = 6;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + duration * 0.92);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.4);

    osc.connect(filter).connect(gain).connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.5);
    // Keep hold of it: a seven-second drone that cannot be stopped keeps rising
    // over the top of a fight the player skipped into.
    this.riserVoice = { osc, gain };
    osc.onended = () => {
      if (this.riserVoice?.osc === osc) this.riserVoice = null;
    };
  }

  /** Cut the riser short — used when the show open is skipped. */
  stopRiser(): void {
    const ctx = this.context;
    const voice = this.riserVoice;
    if (!ctx || !voice) return;
    this.riserVoice = null;
    const t = ctx.currentTime;
    try {
      voice.gain.gain.cancelScheduledValues(t);
      voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), t);
      voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      voice.osc.stop(t + 0.2);
    } catch {
      // Already stopped; nothing to do.
    }
  }

  /** Deep sub hit for lights-out and for knockouts. */
  boom(gain = 0.5): void {
    this.tone({ type: 'sine', from: 120, to: 28, duration: 1.5, gain });
    this.noiseBurst({
      duration: 0.9,
      gain: gain * 0.5,
      type: 'lowpass',
      frequency: 400,
      sweepTo: 60,
      q: 0.8,
      pan: 0,
    });
  }

  // -------------------------------------------------------------------------
  // Music
  // -------------------------------------------------------------------------

  startMusic(): void {
    if (!this.context || this.musicRunning) return;
    this.musicRunning = true;
    this.musicStep = 0;
    this.nextNoteTime = this.context.currentTime + 0.1;
    const tick = () => {
      if (!this.musicRunning || !this.context) return;
      // Schedule ahead so timing does not depend on the frame rate.
      while (this.nextNoteTime < this.context.currentTime + 0.2) {
        this.scheduleStep(this.musicStep, this.nextNoteTime);
        this.nextNoteTime += 60 / 148 / 4;
        this.musicStep = (this.musicStep + 1) % 32;
      }
      this.musicTimer = globalThis.setTimeout(tick, 40) as unknown as number;
    };
    tick();
  }

  stopMusic(): void {
    this.musicRunning = false;
    if (this.musicTimer !== null) {
      clearTimeout(this.musicTimer);
      this.musicTimer = null;
    }
  }

  setMusicIntensity(value: number): void {
    this.musicIntensity = clamp01(value);
  }

  private scheduleStep(step: number, time: number): void {
    const ctx = this.context;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const energy = this.musicIntensity;

    const kickPattern = [0, 6, 8, 14, 16, 22, 24, 30];
    const snarePattern = [4, 12, 20, 28];
    const bassLine = [
      NOTE.E1, NOTE.E1, NOTE.E1, NOTE.G1, NOTE.E1, NOTE.E1, NOTE.A1, NOTE.G1,
    ];

    if (kickPattern.includes(step)) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, time);
      osc.frequency.exponentialRampToValueAtTime(38, time + 0.1);
      gain.gain.setValueAtTime(0.6, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.24);
      osc.connect(gain).connect(bus);
      osc.start(time);
      osc.stop(time + 0.26);
    }

    if (snarePattern.includes(step) && this.noiseBuffer) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 1900;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.34, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
      source.connect(filter).connect(gain).connect(bus);
      source.start(time);
      source.stop(time + 0.18);
    }

    // Hats thin out when the fight is calm and drive hard when it is not.
    if (step % 2 === 1 && this.noiseBuffer && energy > 0.25) {
      const source = ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      source.playbackRate.value = 1.7;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 7200;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.05 + energy * 0.07, time);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      source.connect(filter).connect(gain).connect(bus);
      source.start(time);
      source.stop(time + 0.06);
    }

    if (step % 2 === 0) {
      const note = bassLine[(step / 2) % bassLine.length]!;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(note, time);
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(240 + energy * 900, time);
      filter.Q.value = 7;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.linearRampToValueAtTime(0.24, time + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.19);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(time);
      osc.stop(time + 0.21);
    }

    // Power-chord stabs, only once the fight has some heat in it.
    if (energy > 0.5 && (step === 0 || step === 10 || step === 16 || step === 26)) {
      for (const detune of [-7, 0, 7]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(NOTE.E2 * 2, time);
        osc.detune.setValueAtTime(detune, time);
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2600;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.001, time);
        gain.gain.linearRampToValueAtTime(0.07 * energy, time + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.3);
        osc.connect(filter).connect(gain).connect(bus);
        osc.start(time);
        osc.stop(time + 0.32);
      }
    }
  }

  dispose(): void {
    this.stopMusic();
    try {
      this.crowdSource?.stop();
    } catch {
      // Already stopped.
    }
    void this.context?.close();
    this.context = null;
  }
}

/** One engine for the whole app. */
export const audio = new AudioEngine();
