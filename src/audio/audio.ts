/**
 * The audio engine.
 *
 * Every sound in the game is synthesised at runtime with the Web Audio API —
 * there are no audio files to download. That is a real constraint and it shapes
 * the approach: impacts are filtered noise bursts with a pitched body, motors
 * are stacked detuned oscillators whose frequency tracks the actual rotor
 * speed, and the crowd is a bed of filtered noise that swells on cue.
 *
 * Browsers will not start audio until the user has interacted with the page, so
 * the context is created suspended and resumed on the first gesture.
 */

import { clamp, clamp01 } from '../core/math';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private crowdBus: GainNode | null = null;

  /** Reusable noise buffer — generating this every impact would be wasteful. */
  private noiseBuffer: AudioBuffer | null = null;

  // Continuous voices.
  private crowdSource: AudioBufferSourceNode | null = null;
  private crowdFilter: BiquadFilterNode | null = null;
  private crowdGain: GainNode | null = null;
  private weaponVoices = new Map<string, WeaponVoice>();
  private driveVoices = new Map<string, DriveVoice>();

  private enabled = true;
  private started = false;
  volume = 0.8;

  /** True once the context is running and sound can actually be heard. */
  get ready(): boolean {
    return this.started && this.ctx?.state === 'running';
  }

  /**
   * Create and resume the context. Must be called from a user gesture handler.
   */
  async start(): Promise<void> {
    if (this.started) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      this.enabled = false;
      return;
    }

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);

    // A gentle limiter so a big pile-up of impacts cannot clip.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 6;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.16;
    limiter.connect(this.master);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(limiter);

    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 0.5;
    this.musicBus.connect(limiter);

    this.crowdBus = this.ctx.createGain();
    this.crowdBus.gain.value = 0.5;
    this.crowdBus.connect(limiter);

    this.noiseBuffer = this.makeNoiseBuffer(2.5);
    this.started = true;

    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.startCrowdBed();
  }

  setVolume(value: number): void {
    this.volume = clamp01(value);
    if (this.master) this.master.gain.value = this.volume;
  }

  setEnabled(value: boolean): void {
    this.enabled = value;
    if (this.master) this.master.gain.value = value ? this.volume : 0;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  private makeNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Slightly pink-tinted noise reads warmer than pure white.
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5 + white * 0.35;
    }
    return buffer;
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noiseBuffer) return null;
    const source = this.ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;
    return source;
  }

  // -------------------------------------------------------------------------
  // Crowd
  // -------------------------------------------------------------------------

  private startCrowdBed(): void {
    if (!this.ctx || !this.crowdBus) return;
    const source = this.noiseSource();
    if (!source) return;

    // A crowd is broadband noise with the highs rolled off and a slow wobble.
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620;
    filter.Q.value = 0.55;

    const gain = this.ctx.createGain();
    gain.gain.value = 0.06;

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.crowdBus);
    source.start();

    this.crowdSource = source;
    this.crowdFilter = filter;
    this.crowdGain = gain;
  }

  /**
   * Set the crowd's excitement, 0..1. Louder and brighter as they get going.
   */
  setCrowd(level: number, glideSeconds = 0.6): void {
    if (!this.crowdGain || !this.crowdFilter || !this.ctx) return;
    const t = this.now();
    const value = clamp01(level);
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdGain.gain.setTargetAtTime(0.03 + value * 0.3, t, glideSeconds / 3);
    this.crowdFilter.frequency.cancelScheduledValues(t);
    this.crowdFilter.frequency.setTargetAtTime(520 + value * 900, t, glideSeconds / 3);
  }

  /** A short surge in the crowd, for a big hit. */
  crowdReaction(strength: number): void {
    if (!this.crowdGain) return;
    const t = this.now();
    const peak = 0.12 + clamp01(strength) * 0.4;
    this.crowdGain.gain.cancelScheduledValues(t);
    this.crowdGain.gain.setValueAtTime(this.crowdGain.gain.value, t);
    this.crowdGain.gain.linearRampToValueAtTime(peak, t + 0.18);
    this.crowdGain.gain.setTargetAtTime(0.12, t + 0.4, 0.9);
  }

  // -------------------------------------------------------------------------
  // Continuous machine voices
  // -------------------------------------------------------------------------

  /**
   * Track a robot's weapon. The pitch follows the real rotor speed, so a bar
   * spinning up is audibly spinning up and a bar that just took a hit audibly
   * slows down.
   */
  updateWeaponVoice(id: string, spinFraction: number, baseHz: number, kind: string): void {
    if (!this.ctx || !this.sfxBus) return;
    let voice = this.weaponVoices.get(id);

    if (!voice) {
      voice = new WeaponVoice(this.ctx, this.sfxBus, this.noiseSource(), kind);
      this.weaponVoices.set(id, voice);
    }
    voice.update(spinFraction, baseHz, this.now());
  }

  /** Track a robot's drive motors, so shoving matches whine under load. */
  updateDriveVoice(id: string, throttle: number, speedFraction: number, load: number): void {
    if (!this.ctx || !this.sfxBus) return;
    let voice = this.driveVoices.get(id);
    if (!voice) {
      voice = new DriveVoice(this.ctx, this.sfxBus);
      this.driveVoices.set(id, voice);
    }
    voice.update(throttle, speedFraction, load, this.now());
  }

  /** Silence and release every continuous voice. */
  stopMachines(): void {
    for (const voice of this.weaponVoices.values()) voice.stop(this.now());
    for (const voice of this.driveVoices.values()) voice.stop(this.now());
    this.weaponVoices.clear();
    this.driveVoices.clear();
  }

  // -------------------------------------------------------------------------
  // One-shots
  // -------------------------------------------------------------------------

  /**
   * A metal-on-metal impact. `energy` in joules picks the weight of the hit:
   * a scuff is a short bright tick, a full bar hit is a deep bang with a long
   * ringing tail.
   */
  impact(energyJ: number, sparkiness = 1): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const strength = clamp01(Math.log10(Math.max(energyJ, 1) + 1) / 4.2);

    // --- The bang: a filtered noise burst -----------------------------------
    const noise = this.noiseSource();
    if (noise) {
      const bandpass = this.ctx.createBiquadFilter();
      bandpass.type = 'bandpass';
      bandpass.frequency.value = 2600 - strength * 1800;
      bandpass.Q.value = 0.9;

      const gain = this.ctx.createGain();
      const peak = 0.12 + strength * 0.72;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + strength * 0.5);

      noise.connect(bandpass);
      bandpass.connect(gain);
      gain.connect(this.sfxBus);
      noise.start(t);
      noise.stop(t + 0.7 + strength);
    }

    // --- The body: a low pitched thump that drops -----------------------------
    const osc = this.ctx.createOscillator();
    osc.type = 'triangle';
    const startHz = 190 - strength * 100;
    osc.frequency.setValueAtTime(startHz, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(28, startHz * 0.35), t + 0.16 + strength * 0.3);

    const bodyGain = this.ctx.createGain();
    bodyGain.gain.setValueAtTime(0, t);
    bodyGain.gain.linearRampToValueAtTime(0.18 + strength * 0.55, t + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + strength * 0.55);

    osc.connect(bodyGain);
    bodyGain.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + 0.9 + strength);

    // --- The ring: struck metal, only on a real hit ---------------------------
    if (strength > 0.32) {
      const ringHz = 430 + Math.random() * 520;
      for (const [mult, level] of [
        [1, 1],
        [2.42, 0.5],
        [3.86, 0.28],
      ] as const) {
        const ring = this.ctx.createOscillator();
        ring.type = 'sine';
        ring.frequency.value = ringHz * mult;
        const ringGain = this.ctx.createGain();
        const amp = (strength - 0.32) * 0.34 * level * sparkiness;
        ringGain.gain.setValueAtTime(0, t);
        ringGain.gain.linearRampToValueAtTime(amp, t + 0.008);
        ringGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5 + strength * 1.4);
        ring.connect(ringGain);
        ringGain.connect(this.sfxBus);
        ring.start(t);
        ring.stop(t + 2.2);
      }
    }
  }

  /** The grinding shriek of a weapon dragging along armour. */
  grind(intensity: number): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const noise = this.noiseSource();
    if (!noise) return;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(2400 + Math.random() * 2600, t);
    filter.frequency.linearRampToValueAtTime(1600 + Math.random() * 2000, t + 0.14);
    filter.Q.value = 7;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.07 * clamp01(intensity), t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  /** The pneumatic crack of a flipper firing. */
  pneumatic(): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const noise = this.noiseSource();
    if (!noise) return;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(1800, t);
    filter.frequency.exponentialRampToValueAtTime(320, t + 0.3);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.55, t + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    noise.start(t);
    noise.stop(t + 0.5);
  }

  /**
   * The arena horn. Two detuned square waves through a lowpass — the sound of
   * the match starting and of it ending.
   */
  horn(duration = 1.6, pitch = 138): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.42, t + 0.03);
    gain.gain.setValueAtTime(0.42, t + duration - 0.18);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1500;
    filter.Q.value = 1.2;

    for (const detune of [-7, 0, 7, 1200]) {
      const osc = this.ctx.createOscillator();
      osc.type = detune === 1200 ? 'sine' : 'sawtooth';
      osc.frequency.value = pitch;
      osc.detune.value = detune;
      const oscGain = this.ctx.createGain();
      oscGain.gain.value = detune === 1200 ? 0.25 : 0.4;
      osc.connect(oscGain);
      oscGain.connect(filter);
      osc.start(t);
      osc.stop(t + duration + 0.05);
    }

    filter.connect(gain);
    gain.connect(this.sfxBus);
  }

  /** A countdown beep. The final one is higher and longer. */
  beep(pitch = 660, duration = 0.16, level = 0.34): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = pitch;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.008);
    gain.gain.setValueAtTime(level, t + duration - 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 3200;

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    osc.start(t);
    osc.stop(t + duration + 0.05);
  }

  /** The referee's count: a hard, dry knock. */
  countTick(): void {
    this.beep(420, 0.1, 0.26);
  }

  /** A rising sweep, used as the lights come up. */
  riser(duration = 2.2): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.now();
    const noise = this.noiseSource();
    if (!noise) return;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(180, t);
    filter.frequency.exponentialRampToValueAtTime(5200, t + duration);
    filter.Q.value = 3.4;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + duration * 0.92);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration + 0.25);

    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.musicBus);
    noise.start(t);
    noise.stop(t + duration + 0.4);
  }

  /** A deep hit of sub bass, for the blackout and for a knockout. */
  boom(level = 0.6): void {
    if (!this.ctx || !this.musicBus) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(88, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 1.1);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(level, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);

    osc.connect(gain);
    gain.connect(this.musicBus);
    osc.start(t);
    osc.stop(t + 1.5);
  }

  /** Heavy relays clunking as the arena lights switch. */
  lightClunk(): void {
    if (!this.ctx || !this.sfxBus) return;
    const t = this.now();
    const noise = this.noiseSource();
    if (!noise) return;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 380;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.3, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noise.connect(filter);
    filter.connect(gain);
    gain.connect(this.sfxBus);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  dispose(): void {
    this.stopMachines();
    this.crowdSource?.stop();
    this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

/**
 * A weapon's continuous voice: two detuned saws for the motor plus a noise band
 * for the blade cutting air, all tracking the real rotor speed.
 */
class WeaponVoice {
  private oscA: OscillatorNode;
  private oscB: OscillatorNode;
  private gain: GainNode;
  private airFilter: BiquadFilterNode;
  private airGain: GainNode;
  private air: AudioBufferSourceNode | null;
  private stopped = false;

  constructor(ctx: AudioContext, out: GainNode, noise: AudioBufferSourceNode | null, kind: string) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);

    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = kind === 'drum' ? 2600 : 4200;
    tone.Q.value = 1.1;
    tone.connect(this.gain);

    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscA.frequency.value = 40;
    this.oscA.connect(tone);
    this.oscA.start();

    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    this.oscB.frequency.value = 40;
    this.oscB.detune.value = 9;
    const bGain = ctx.createGain();
    bGain.gain.value = 0.35;
    this.oscB.connect(bGain);
    bGain.connect(tone);
    this.oscB.start();

    // The blade cutting air: a narrow noise band that rises with speed.
    this.airFilter = ctx.createBiquadFilter();
    this.airFilter.type = 'bandpass';
    this.airFilter.frequency.value = 900;
    this.airFilter.Q.value = 2.4;
    this.airGain = ctx.createGain();
    this.airGain.gain.value = 0;
    this.airFilter.connect(this.airGain);
    this.airGain.connect(out);

    this.air = noise;
    if (this.air) {
      this.air.connect(this.airFilter);
      this.air.start();
    }
  }

  update(spinFraction: number, baseHz: number, t: number): void {
    if (this.stopped) return;
    const spin = clamp01(spinFraction);
    // The motor's fundamental follows the rotor's actual rotation rate.
    const hz = clamp(28 + baseHz * spin, 22, 3200);
    this.oscA.frequency.setTargetAtTime(hz, t, 0.05);
    this.oscB.frequency.setTargetAtTime(hz * 1.5, t, 0.05);
    this.gain.gain.setTargetAtTime(spin * 0.09, t, 0.08);

    this.airFilter.frequency.setTargetAtTime(600 + spin * 4200, t, 0.08);
    this.airGain.gain.setTargetAtTime(spin * spin * 0.06, t, 0.1);
  }

  stop(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gain.gain.setTargetAtTime(0, t, 0.05);
    this.airGain.gain.setTargetAtTime(0, t, 0.05);
    this.oscA.stop(t + 0.4);
    this.oscB.stop(t + 0.4);
    this.air?.stop(t + 0.4);
  }
}

/** Drive motors: a low whine that rises with speed and growls under load. */
class DriveVoice {
  private osc: OscillatorNode;
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private stopped = false;

  constructor(ctx: AudioContext, out: GainNode) {
    this.gain = ctx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);

    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 900;
    this.filter.Q.value = 2.2;
    this.filter.connect(this.gain);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = 60;
    this.osc.connect(this.filter);
    this.osc.start();
  }

  update(throttle: number, speedFraction: number, load: number, t: number): void {
    if (this.stopped) return;
    const effort = clamp01(Math.abs(throttle));
    // Under load the motor bogs down: same effort, lower pitch, more growl.
    const hz = 55 + speedFraction * 240 + effort * 60 - load * 25;
    this.osc.frequency.setTargetAtTime(clamp(hz, 35, 420), t, 0.07);
    this.filter.frequency.setTargetAtTime(500 + effort * 1400 + load * 400, t, 0.1);
    this.gain.gain.setTargetAtTime(effort * 0.035 + load * 0.02, t, 0.1);
  }

  stop(t: number): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gain.gain.setTargetAtTime(0, t, 0.05);
    this.osc.stop(t + 0.4);
  }
}
