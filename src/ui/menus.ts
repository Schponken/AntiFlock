/**
 * Title screen and loading overlay.
 */

import type { Difficulty } from '../ai/opponent';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class LoadingScreen {
  readonly root: HTMLElement;
  private text: HTMLElement;

  constructor() {
    this.root = el('div', 'layer interactive');
    this.root.id = 'loading';
    const mark = el('div', 'title-mark', 'ANTIFLOCK');
    mark.style.fontSize = 'clamp(38px, 8vw, 92px)';
    this.text = el('div', 'loading-text', 'Loading physics');
    const bar = el('div', 'loading-bar');
    bar.appendChild(el('div', 'loading-bar-fill'));
    this.root.append(mark, this.text, bar);
  }

  setStatus(text: string): void {
    this.text.textContent = text;
  }

  hide(): void {
    this.root.classList.add('hidden');
  }
}

export interface TitleCallbacks {
  onFight: () => void;
  onGarage: () => void;
  onDifficulty: (difficulty: Difficulty) => void;
}

export class TitleScreen {
  readonly root: HTMLElement;
  private difficultyButtons = new Map<Difficulty, HTMLButtonElement>();
  private difficulty: Difficulty = 'veteran';

  constructor(private readonly callbacks: TitleCallbacks) {
    this.root = el('div', 'layer interactive hidden');
    this.root.id = 'title';
    this.build();
  }

  private build(): void {
    this.root.appendChild(el('div', 'title-mark', 'ANTIFLOCK'));
    this.root.appendChild(
      el('div', 'title-sub', 'Heavyweight Combat Robotics'),
    );

    const actions = el('div', 'title-actions');
    const fight = el('button', 'primary', 'Enter the Arena');
    fight.addEventListener('click', () => this.callbacks.onFight());
    const garage = el('button', '', 'Build a Robot');
    garage.addEventListener('click', () => this.callbacks.onGarage());
    actions.append(fight, garage);
    this.root.appendChild(actions);

    // Difficulty picker.
    const difficulties = el('div', 'title-actions');
    for (const level of ['rookie', 'veteran', 'champion'] as const) {
      const button = el('button', 'ghost tiny', level);
      button.style.minWidth = '120px';
      button.addEventListener('click', () => {
        this.setDifficulty(level);
        this.callbacks.onDifficulty(level);
      });
      this.difficultyButtons.set(level, button);
      difficulties.appendChild(button);
    }
    this.root.appendChild(difficulties);
    this.setDifficulty(this.difficulty);

    this.root.appendChild(
      el(
        'div',
        'title-hint',
        'Two robots, 250 pounds each, three minutes. Real physics, real damage — ' +
          'a bar spinner stores sixty kilojoules and it all has to go somewhere. ' +
          'Drive with WASD, run the weapon with Space.',
      ),
    );
  }

  setDifficulty(difficulty: Difficulty): void {
    this.difficulty = difficulty;
    for (const [level, button] of this.difficultyButtons) {
      button.classList.toggle('primary', level === difficulty);
      button.classList.toggle('ghost', level !== difficulty);
    }
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }
}
