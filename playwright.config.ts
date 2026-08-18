import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * Use a pre-installed Chromium when the environment provides one, rather than
 * downloading a browser. The bundled revision does not always match what this
 * Playwright version expects, and the full browser is what we want anyway —
 * the headless shell has a weaker WebGL path.
 */
const CANDIDATE_BROWSERS = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];
const executablePath = CANDIDATE_BROWSERS.find((path) => existsSync(path));

/**
 * End-to-end tests run against a production build in real Chromium.
 *
 * WebGL needs a GPU path that works headless, so the browser is launched with
 * SwiftShader. That is slower than a real GPU but it renders the same pixels,
 * which is the point — these tests check that the game actually draws.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-gpu-sandbox',
        '--no-sandbox',
        // Speech synthesis is unavailable headless; the announcer falls back.
        '--mute-audio',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
