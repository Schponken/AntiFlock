/** Small DOM helpers. Enough structure to keep the UI readable, no framework. */

type Attrs = Record<string, string | number | boolean | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data-') || key === 'style') node.setAttribute(key, String(value));
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.firstChild.remove();
}

export function button(
  label: string,
  onClick: () => void,
  options: { variant?: 'primary' | 'ghost' | 'danger'; className?: string } = {},
): HTMLButtonElement {
  const node = el('button', {
    class: `btn ${options.variant ? `btn--${options.variant}` : ''} ${options.className ?? ''}`.trim(),
    type: 'button',
  });
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

/** A labelled range slider that reports live values. */
export function slider(options: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format: (value: number) => string;
  onInput: (value: number) => void;
}): HTMLElement {
  const readout = el('span', { class: 'slider__value', text: options.format(options.value) });
  const input = el('input', {
    type: 'range',
    class: 'slider__input',
    min: options.min,
    max: options.max,
    step: options.step,
    value: options.value,
  });
  input.addEventListener('input', () => {
    const value = Number(input.value);
    readout.textContent = options.format(value);
    options.onInput(value);
  });
  return el(
    'label',
    { class: 'slider' },
    el('span', { class: 'slider__label' }, options.label, readout),
    input,
  );
}

/** Colour swatch picker. */
export function colorField(
  label: string,
  value: number,
  onInput: (value: number) => void,
): HTMLElement {
  const input = el('input', {
    type: 'color',
    class: 'colorfield__input',
    value: `#${value.toString(16).padStart(6, '0')}`,
  });
  input.addEventListener('input', () => {
    onInput(Number.parseInt(input.value.slice(1), 16));
  });
  return el('label', { class: 'colorfield' }, el('span', { text: label }), input);
}

export const hexOf = (color: number): string => `#${color.toString(16).padStart(6, '0')}`;
