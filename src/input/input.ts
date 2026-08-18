/**
 * Keyboard and gamepad input.
 *
 * Combat robots are driven on two sticks, so the gamepad mapping is the real
 * one: left stick forward/back, right stick to steer, triggers for the weapon.
 * Keyboard is WASD to drive with space for the weapon.
 */

import { clamp, deadzone } from '../core/math';
import type { BotControl } from '../sim/bot';

export interface InputBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  weapon: string[];
  fire: string[];
  selfRight: string[];
}

export const DEFAULT_BINDINGS: InputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  weapon: ['Space'],
  fire: ['KeyF', 'ShiftLeft'],
  selfRight: ['KeyR'],
};

export class InputManager {
  private keys = new Set<string>();
  private bindings: InputBindings;
  /** Weapon throttle ramps rather than snapping, like a real transmitter. */
  private weaponLevel = 0;
  private firePressed = false;
  private selfRightPressed = false;

  /** Callbacks for keys the game handles rather than the robot. */
  onAction: (action: string) => void = () => {};

  private keyDown = (event: KeyboardEvent): void => {
    // Never swallow typing in the garage's name field.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    this.keys.add(event.code);

    switch (event.code) {
      case 'Escape':
        this.onAction('escape');
        break;
      case 'Enter':
        this.onAction('enter');
        break;
      case 'KeyC':
        this.onAction('camera');
        break;
      case 'KeyM':
        this.onAction('mute');
        break;
      case 'KeyP':
        this.onAction('pause');
        break;
      case 'F3':
        event.preventDefault();
        this.onAction('debug');
        break;
    }

    // Stop the page scrolling out from under the fight.
    if (
      ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)
    ) {
      event.preventDefault();
    }
  };

  private keyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private blur = (): void => {
    // Losing focus mid-fight must not leave the throttle stuck on.
    this.keys.clear();
  };

  constructor(bindings: InputBindings = DEFAULT_BINDINGS) {
    this.bindings = bindings;
  }

  attach(target: Window = window): void {
    target.addEventListener('keydown', this.keyDown);
    target.addEventListener('keyup', this.keyUp);
    target.addEventListener('blur', this.blur);
  }

  detach(target: Window = window): void {
    target.removeEventListener('keydown', this.keyDown);
    target.removeEventListener('keyup', this.keyUp);
    target.removeEventListener('blur', this.blur);
    this.keys.clear();
  }

  private held(codes: string[]): boolean {
    return codes.some((code) => this.keys.has(code));
  }

  /** First connected gamepad, if any. */
  private gamepad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const pad of pads) {
      if (pad?.connected) return pad;
    }
    return null;
  }

  get hasGamepad(): boolean {
    return this.gamepad() !== null;
  }

  /**
   * Read the current control state.
   *
   * `dt` is used to ramp the weapon throttle, so tapping the key does not slam
   * a 30 kg rotor from nothing to full demand in one frame.
   */
  read(dt: number): BotControl {
    let throttle = 0;
    let steer = 0;
    let weaponDemand = 0;
    let fire = false;
    let selfRight = false;

    // --- Keyboard -------------------------------------------------------------
    if (this.held(this.bindings.forward)) throttle += 1;
    if (this.held(this.bindings.back)) throttle -= 1;
    if (this.held(this.bindings.right)) steer += 1;
    if (this.held(this.bindings.left)) steer -= 1;
    if (this.held(this.bindings.weapon)) weaponDemand = 1;
    if (this.held(this.bindings.fire)) fire = true;
    if (this.held(this.bindings.selfRight)) selfRight = true;

    // --- Gamepad --------------------------------------------------------------
    const pad = this.gamepad();
    if (pad) {
      const ly = deadzone(-(pad.axes[1] ?? 0));
      const rx = deadzone(pad.axes[2] ?? pad.axes[0] ?? 0);
      if (Math.abs(ly) > 0) throttle = ly;
      if (Math.abs(rx) > 0) steer = rx;

      // Right trigger runs the weapon; both bumpers fire a burst weapon.
      const rt = pad.buttons[7]?.value ?? 0;
      if (rt > 0.05) weaponDemand = Math.max(weaponDemand, rt);
      if (pad.buttons[5]?.pressed || pad.buttons[0]?.pressed) fire = true;
      if (pad.buttons[3]?.pressed) selfRight = true;
    }

    // --- Weapon ramp ----------------------------------------------------------
    // Up quickly, down slowly: releasing the trigger lets a spinner coast.
    const rate = weaponDemand > this.weaponLevel ? 3.2 : 1.4;
    const delta = clamp(weaponDemand - this.weaponLevel, -rate * dt, rate * dt);
    this.weaponLevel = clamp(this.weaponLevel + delta, 0, 1);

    // --- Edge triggers --------------------------------------------------------
    // A burst weapon fires once per press, not once per frame — holding the
    // key down must not chain-fire a flipper.
    const fireEdge = fire && !this.firePressed;
    this.firePressed = fire;

    const selfRightEdge = selfRight && !this.selfRightPressed;
    this.selfRightPressed = selfRight;

    return {
      throttle: clamp(throttle, -1, 1),
      steer: clamp(steer, -1, 1),
      weapon: this.weaponLevel,
      fire: fireEdge,
      selfRight: selfRightEdge,
    };
  }

  /** Drop any latched state, between matches. */
  reset(): void {
    this.keys.clear();
    this.weaponLevel = 0;
    this.firePressed = false;
    this.selfRightPressed = false;
  }
}
