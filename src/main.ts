/**
 * Entry point.
 */

import './ui/styles.css';
import { Game } from './game';

declare global {
  interface Window {
    /** Exposed so the end-to-end tests can drive and inspect a real session. */
    antiflock?: Record<string, unknown>;
  }
}

function fail(message: string, error: unknown): void {
  // If boot fails there is no game to report through, so say so on the page.
  console.error(message, error);
  const container = document.getElementById('app') ?? document.body;
  const panel = document.createElement('div');
  panel.className = 'layer interactive';
  panel.style.cssText =
    'display:flex;align-items:center;justify-content:center;background:#05060a;padding:40px;text-align:center';
  panel.innerHTML = `
    <div>
      <div style="font-family:'Arial Black',sans-serif;font-size:32px;margin-bottom:14px">
        Could not start
      </div>
      <div style="color:#9aa3b0;font-size:14px;line-height:1.7;max-width:520px">
        ${message}<br><br>
        AntiFlock needs WebGL 2 and WebAssembly. If you are on a very old
        browser, or hardware acceleration is switched off, that is the usual
        cause.
      </div>
      <div style="color:#5d646f;font-family:monospace;font-size:12px;margin-top:20px">
        ${error instanceof Error ? error.message : String(error)}
      </div>
    </div>`;
  container.appendChild(panel);
}

async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('#app is missing from the document');

  const game = new Game(container);
  window.antiflock = game.debugApi;

  try {
    await game.boot();
  } catch (error) {
    fail('The arena failed to load.', error);
  }
}

void main();
