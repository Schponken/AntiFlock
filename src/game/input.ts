/**
 * Driver controls: keyboard and gamepad, both mapped onto the same tank-drive
 * inputs a real transmitter produces.
 */

import { clamp, deadzone } from '../core/mathx.ts';
import { NEUTRAL_INPUT, type BotInput } from './bot.ts';

export interface InputBindings {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  weapon: string[];
  fire: string[];
  selfRight: string[];
  camera: string[];
}

export const DEFAULT_BINDINGS: InputBindings = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  weapon: ['ShiftLeft', 'ShiftRight'],
  fire: ['Space'],
  selfRight: ['KeyR'],
  camera: ['KeyC'],
};

export class InputManager {
  private pressed = new Set<string>();
  private bindings: InputBindings;
  private attached = false;
  private prevFire = false;
  private prevSelfRight = false;
  private prevCamera = false;

  /** Rising edge of the camera key, consumed by the game loop. */
  private cameraToggled = false;
  /** Set by any key or button, so the intro can be skipped with "any key". */
  private anyPressed = false;

  /**
   * True when the keystroke belongs to something the player is typing into.
   *
   * This listener sits on `window` and is attached for the whole life of the app,
   * including while the workshop is open — and the workshop is full of text
   * inputs, number fields, sliders and colour pickers. Swallowing every bound key
   * meant a machine could not be named "Wasteland" (W, A, S, D and Space are all
   * bound), an arrow key nudged the bot instead of the caret, and Space toggled
   * nothing on a focused checkbox. A control that has focus owns its keystrokes.
   */
  private static isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof globalThis.HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    /*
     * Buttons are in this list too, and deliberately.
     *
     * Space is bound to `fire`, and cancelling it anywhere in the propagation path
     * cancels a focused `<button>`'s activation — so the space bar could not press
     * ENTER THE BOX, FIGHT, or any other button in the application. A control that
     * has focus owns its keystrokes; the fight has no focused control.
     */
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      tag === 'OPTION' ||
      tag === 'BUTTON' ||
      tag === 'SUMMARY' ||
      tag === 'A'
    );
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    // Never eat the browser's own shortcuts.
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (InputManager.isTypingTarget(event.target)) return;
    this.pressed.add(event.code);
    this.anyPressed = true;
    if (this.isBound(event.code)) event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private onBlur = (): void => {
    // Losing focus mid-throttle must not leave the machine driving at a wall.
    this.pressed.clear();
  };

  constructor(bindings: InputBindings = DEFAULT_BINDINGS) {
    this.bindings = bindings;
  }

  private isBound(code: string): boolean {
    return Object.values(this.bindings).some((codes) => codes.includes(code));
  }

  attach(target: Window = globalThis.window): void {
    if (this.attached) return;
    this.attached = true;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  detach(target: Window = globalThis.window): void {
    if (!this.attached) return;
    this.attached = false;
    target.removeEventListener('keydown', this.onKeyDown);
    target.removeEventListener('keyup', this.onKeyUp);
    target.removeEventListener('blur', this.onBlur);
    this.pressed.clear();
  }

  private any(codes: string[]): boolean {
    return codes.some((code) => this.pressed.has(code));
  }

  private gamepad(): Gamepad | null {
    const pads = globalThis.navigator?.getGamepads?.();
    if (!pads) return null;
    for (const pad of pads) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  /** Build this frame's driver input. */
  sample(): BotInput {
    let throttle = 0;
    let steer = 0;
    let weapon = this.any(this.bindings.weapon);
    let fire = this.any(this.bindings.fire);
    let selfRight = this.any(this.bindings.selfRight);
    let camera = this.any(this.bindings.camera);

    if (this.any(this.bindings.forward)) throttle += 1;
    if (this.any(this.bindings.back)) throttle -= 1;
    if (this.any(this.bindings.right)) steer += 1;
    if (this.any(this.bindings.left)) steer -= 1;

    // A gamepad, if present, takes over the analogue axes.
    const pad = this.gamepad();
    if (pad) {
      const leftStickY = -deadzone(pad.axes[1] ?? 0);
      const rightStickX = deadzone(pad.axes[2] ?? pad.axes[0] ?? 0);
      const rightTrigger = pad.buttons[7]?.value ?? 0;
      const leftTrigger = pad.buttons[6]?.value ?? 0;

      if (Math.abs(leftStickY) > 0.01) throttle = leftStickY;
      if (Math.abs(rightStickX) > 0.01) steer = rightStickX;
      // Triggers drive forward/back for players who prefer that layout.
      if (rightTrigger > 0.05 || leftTrigger > 0.05) throttle = rightTrigger - leftTrigger;

      weapon = weapon || (pad.buttons[5]?.pressed ?? false) || (pad.buttons[0]?.pressed ?? false);
      fire = fire || (pad.buttons[1]?.pressed ?? false);
      selfRight = selfRight || (pad.buttons[3]?.pressed ?? false);
      camera = camera || (pad.buttons[2]?.pressed ?? false);

      if (pad.buttons.some((b) => b.pressed)) this.anyPressed = true;
    }

    // Fire and self-right are edges, not levels.
    const fireEdge = fire && !this.prevFire;
    const selfRightEdge = selfRight && !this.prevSelfRight;
    if (camera && !this.prevCamera) this.cameraToggled = true;

    this.prevFire = fire;
    this.prevSelfRight = selfRight;
    this.prevCamera = camera;

    return {
      throttle: clamp(throttle, -1, 1),
      steer: clamp(steer, -1, 1),
      weapon,
      fire: fireEdge,
      selfRight: selfRightEdge,
    };
  }

  /** True once per press of the camera key. */
  consumeCameraToggle(): boolean {
    const value = this.cameraToggled;
    this.cameraToggled = false;
    return value;
  }

  /** True if anything was pressed since the last call. Used to skip the intro. */
  consumeAnyPress(): boolean {
    const value = this.anyPressed;
    this.anyPressed = false;
    return value;
  }

  static neutral(): BotInput {
    return { ...NEUTRAL_INPUT };
  }
}
