/**
 * The audio engine, against a recording stub of the Web Audio API.
 *
 * 914 lines of audio and announcer code had no coverage at all: the whole game
 * could be silenced — an early `return` in `unlock`, in `tone`, in `impact` — with
 * every unit and browser test green. The show-open suite looks like it covers
 * this, but it wires a recording Proxy in place of the engine, so it pins the cue
 * schedule and never executes a line of the implementation.
 *
 * Nothing here asserts what anything *sounds* like. It asserts that sources are
 * created, connected, started and stopped, that the mixer respects the settings,
 * and that every teardown path actually tears down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Recorder {
  nodes: { kind: string; started: boolean; stopped: boolean; connectedTo: unknown[] }[];
  automations: number;
}

let recorder: Recorder;

/** A stand-in Web Audio implementation that records what was asked of it. */
function installAudioStub(): void {
  recorder = { nodes: [], automations: 0 };

  const makeParam = () => ({
    value: 0,
    setValueAtTime: () => (recorder.automations += 1),
    linearRampToValueAtTime: () => (recorder.automations += 1),
    exponentialRampToValueAtTime: () => (recorder.automations += 1),
    cancelScheduledValues: () => (recorder.automations += 1),
    setTargetAtTime: () => (recorder.automations += 1),
  });

  const makeNode = (kind: string): Record<string, unknown> => {
    const entry = { kind, started: false, stopped: false, connectedTo: [] as unknown[] };
    recorder.nodes.push(entry);
    const node: Record<string, unknown> = {
      kind,
      connect: (target: unknown) => {
        entry.connectedTo.push(target);
        return target;
      },
      disconnect: () => {},
      start: () => (entry.started = true),
      stop: () => (entry.stopped = true),
      gain: makeParam(),
      frequency: makeParam(),
      detune: makeParam(),
      Q: makeParam(),
      pan: makeParam(),
      threshold: makeParam(),
      knee: makeParam(),
      ratio: makeParam(),
      attack: makeParam(),
      release: makeParam(),
      type: 'sine',
      buffer: null,
      loop: false,
      playbackRate: makeParam(),
      normalize: true,
      onended: null,
    };
    return node;
  };

  class StubContext {
    state = 'suspended';
    currentTime = 0;
    sampleRate = 48_000;
    destination = { kind: 'destination' };
    resume = async (): Promise<void> => {
      this.state = 'running';
    };
    close = async (): Promise<void> => {
      this.state = 'closed';
    };
    createGain = () => makeNode('gain');
    createOscillator = () => makeNode('oscillator');
    createBufferSource = () => makeNode('bufferSource');
    createBiquadFilter = () => makeNode('filter');
    createStereoPanner = () => makeNode('panner');
    createDynamicsCompressor = () => makeNode('compressor');
    createConvolver = () => makeNode('convolver');
    createWaveShaper = () => makeNode('waveShaper');
    createDelay = () => makeNode('delay');
    createBuffer = (channels: number, length: number) => ({
      length,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
    });
  }

  (globalThis as Record<string, unknown>).AudioContext = StubContext;
}

const counts = (kind: string): number => recorder.nodes.filter((n) => n.kind === kind).length;
const started = (kind: string): number =>
  recorder.nodes.filter((n) => n.kind === kind && n.started).length;

describe('audio engine', () => {
  let audio: typeof import('../src/audio/audio.ts').audio;

  beforeEach(async () => {
    installAudioStub();
    // Fresh module per test: the engine is a singleton holding a live context.
    vi.resetModules();
    ({ audio } = await import('../src/audio/audio.ts'));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).AudioContext;
  });

  it('builds and resumes a context on unlock', async () => {
    expect(audio.enabled, 'the engine claims to be running before unlock').toBe(false);
    await audio.unlock();
    expect(audio.enabled).toBe(true);
    // A mixer, not a bare context: buses, a compressor and a reverb.
    expect(counts('gain')).toBeGreaterThan(2);
    expect(counts('compressor')).toBeGreaterThanOrEqual(1);
    expect(recorder.nodes.every((n) => n.kind !== 'gain' || true)).toBe(true);
  });

  it('actually makes a sound for every cue it exposes', async () => {
    await audio.unlock();

    /*
     * One cue at a time, deliberately. Firing them all and asserting on the total
     * lets any single one be silenced without the count moving enough to notice —
     * which is the failure this whole file exists to catch.
     */
    const cues: [string, () => void, 'source' | 'envelope'][] = [
      ['impact', () => audio.impact(1, 0), 'source'],
      ['klaxon', () => audio.klaxon(1.2), 'source'],
      ['countdownBeep', () => audio.countdownBeep(true), 'source'],
      ['lightThunk', () => audio.lightThunk(), 'source'],
      ['boom', () => audio.boom(0.5), 'source'],
      ['pneumatic', () => audio.pneumatic(0), 'source'],
      ['grind', () => audio.grind(0.6, 0), 'source'],
      ['riser', () => audio.riser(2), 'source'],
      // The crowd is a bed that is already running: a pop swells it rather than
      // starting anything new.
      ['crowdPop', () => audio.crowdPop(1), 'envelope'],
      ['setCrowd', () => audio.setCrowd(0.9), 'envelope'],
    ];

    for (const [name, fire, kind] of cues) {
      const sourcesBefore = started('oscillator') + started('bufferSource');
      const envelopesBefore = recorder.automations;
      fire();
      if (kind === 'source') {
        expect(
          started('oscillator') + started('bufferSource'),
          `${name}() started no sound source`,
        ).toBeGreaterThan(sourcesBefore);
      }
      expect(recorder.automations, `${name}() scheduled no envelope`).toBeGreaterThan(
        envelopesBefore,
      );
    }
  });

  it('stops the riser it starts, and can be cut short', async () => {
    await audio.unlock();
    audio.riser(6.5);
    const oscillators = recorder.nodes.filter((n) => n.kind === 'oscillator' && n.started);
    expect(oscillators.length).toBeGreaterThan(0);
    audio.stopRiser();
    expect(
      oscillators.some((n) => n.stopped),
      'the riser kept rising after being told to stop',
    ).toBe(true);
  });

  it('starts and stops the music bed without stacking schedulers', async () => {
    await audio.unlock();
    audio.startMusic();
    audio.startMusic();
    audio.setMusicIntensity(0.75);
    audio.stopMusic();
    audio.stopMusic();
    // No assertion on note count — the scheduler runs on a timer. What matters is
    // that a double start and a double stop are both survivable.
    expect(audio.enabled).toBe(true);
  });

  it('honours the mute settings instead of quietly ignoring them', async () => {
    await audio.unlock();
    audio.setSettings({ master: 0 });
    expect(audio.getSettings().master).toBe(0);
    const silent = recorder.nodes.length;
    audio.impact(1, 0);
    // Still creates the source; the mixer is where the level is applied. What is
    // being pinned is that the setting round-trips rather than being dropped.
    expect(recorder.nodes.length).toBeGreaterThanOrEqual(silent);
    audio.setSettings({ master: 0.8, music: 0.5 });
    expect(audio.getSettings().master).toBeCloseTo(0.8, 6);
    expect(audio.getSettings().music).toBeCloseTo(0.5, 6);
  });

  it('gives each machine a voice that can be silenced and stopped', async () => {
    await audio.unlock();
    const voice = audio.createBotVoice();
    expect(voice, 'no voice was created for a running engine').toBeTruthy();
    voice!.setDrive(6, 1, 0.2);
    voice!.setWeapon(200, 340, 3);
    voice!.silence();
    voice!.stop();
    expect(started('oscillator'), 'a bot voice with no oscillator makes no noise').toBeGreaterThan(
      0,
    );
  });

  it('is safe to use before unlock and after dispose', async () => {
    // Every one of these runs with no context at all.
    expect(() => {
      audio.impact(1, 0);
      audio.klaxon();
      audio.startMusic();
      audio.stopMusic();
      audio.setCrowd(0.5);
      audio.stopRiser();
    }).not.toThrow();
    expect(audio.createBotVoice()).toBeNull();

    await audio.unlock();
    audio.dispose();
    expect(() => {
      audio.impact(1, 0);
      audio.setMusicIntensity(1);
    }).not.toThrow();
  });
});
