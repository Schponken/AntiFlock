/**
 * The player's controls.
 *
 * `src/game/input.ts` was imported by no test at all, and the only test named for
 * the controls drove `bot.setInput` directly — so the whole keyboard path could be
 * reversed, or detached, with every gate green, and A, D, R and C were never
 * pressed anywhere in either suite. These drive the real `InputManager` through
 * synthetic events on a stand-in window.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, InputManager } from '../src/game/input.ts';

type Listener = (event: unknown) => void;

/** Just enough window for `attach`: it only uses add/removeEventListener. */
function fakeWindow() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    target: {
      addEventListener: (type: string, fn: Listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(fn);
      },
      removeEventListener: (type: string, fn: Listener) => listeners.get(type)?.delete(fn),
    } as unknown as Window,
    emit(type: string, event: Record<string, unknown>) {
      for (const fn of listeners.get(type) ?? []) fn({ preventDefault: () => {}, ...event });
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

describe('keyboard controls', () => {
  let win: ReturnType<typeof fakeWindow>;
  let input: InputManager;

  beforeEach(() => {
    win = fakeWindow();
    input = new InputManager();
    input.attach(win.target);
  });

  const down = (code: string) => win.emit('keydown', { code, target: null });
  const up = (code: string) => win.emit('keyup', { code, target: null });

  it('maps every bound key to the axis the player expects', () => {
    const cases: [string, Partial<Record<'throttle' | 'steer', number>>][] = [
      ['KeyW', { throttle: 1 }],
      ['ArrowUp', { throttle: 1 }],
      ['KeyS', { throttle: -1 }],
      ['ArrowDown', { throttle: -1 }],
      ['KeyD', { steer: 1 }],
      ['ArrowRight', { steer: 1 }],
      ['KeyA', { steer: -1 }],
      ['ArrowLeft', { steer: -1 }],
    ];

    for (const [code, expected] of cases) {
      down(code);
      const sample = input.sample();
      for (const [axis, value] of Object.entries(expected)) {
        expect(sample[axis as 'throttle' | 'steer'], `${code} -> ${axis}`).toBe(value);
      }
      up(code);
      expect(input.sample().throttle).toBe(0);
      expect(input.sample().steer).toBe(0);
    }
  });

  it('cancels opposing keys instead of picking one', () => {
    down('KeyW');
    down('KeyS');
    expect(input.sample().throttle).toBe(0);
    down('KeyA');
    down('KeyD');
    expect(input.sample().steer).toBe(0);
  });

  it('treats the weapon as a level and fire as a rising edge', () => {
    down('ShiftLeft');
    expect(input.sample().weapon).toBe(true);
    expect(input.sample().weapon, 'the weapon key is held, not tapped').toBe(true);

    down('Space');
    expect(input.sample().fire, 'the first read after pressing fire').toBe(true);
    expect(input.sample().fire, 'fire must not repeat while the key is held').toBe(false);
    // Released and pressed again, with a frame in between — the edge is recomputed
    // on each sample, so a release and re-press inside one frame is not an edge.
    up('Space');
    input.sample();
    down('Space');
    expect(input.sample().fire).toBe(true);
  });

  it('makes self-right an edge and the camera key a one-shot toggle', () => {
    down('KeyR');
    expect(input.sample().selfRight).toBe(true);
    expect(input.sample().selfRight).toBe(false);

    down('KeyC');
    input.sample();
    expect(input.consumeCameraToggle()).toBe(true);
    expect(input.consumeCameraToggle(), 'the toggle is consumed once').toBe(false);
  });

  it('does not eat keystrokes aimed at the workshop or its buttons', () => {
    /*
     * The listener is on `window` for the life of the app, and Space is bound to
     * fire — so cancelling it anywhere in the propagation path cancelled a focused
     * button's activation, and a machine could not be named with a bound letter
     * in it.
     */
    let cancelled = false;
    const typing = { tagName: 'INPUT', isContentEditable: false };
    win.emit('keydown', {
      code: 'KeyW',
      target: typing,
      preventDefault: () => {
        cancelled = true;
      },
    });
    expect(cancelled, 'a keystroke typed into a text field was cancelled').toBe(false);
    expect(input.sample().throttle, 'typing a W drove the machine').toBe(0);
  });

  it('drops everything it was holding when the window loses focus', () => {
    down('KeyW');
    expect(input.sample().throttle).toBe(1);
    win.emit('blur', {});
    expect(input.sample().throttle, 'losing focus left the throttle open').toBe(0);
  });

  it('clears a latched edge between matches', () => {
    // A key still held on the results screen used to swallow the first FIRE of
    // the next fight: the edge detector only advances while a fight is sampled.
    down('Space');
    expect(input.sample().fire).toBe(true);
    input.resetEdges();
    expect(input.sample().fire, 'the latch survived the reset').toBe(false);
    down('Space');
    expect(input.sample().fire).toBe(true);
  });

  it('detaches cleanly', () => {
    expect(win.count('keydown')).toBe(1);
    input.detach(win.target);
    expect(win.count('keydown')).toBe(0);
    down('KeyW');
    expect(input.sample().throttle).toBe(0);
  });

  it('binds every control the catalogue of bindings names', () => {
    for (const [action, codes] of Object.entries(DEFAULT_BINDINGS)) {
      expect(codes.length, `${action} has no key bound to it`).toBeGreaterThan(0);
    }
  });
});
