import { defineConfig, devices } from '@playwright/test';

/**
 * The smoke suite boots the real game in a real browser. WebGL is provided by
 * SwiftShader, which is slow but faithful — it catches shader compile errors,
 * texture generation faults and startup exceptions that a Node test cannot.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
    video: 'off',
    launchOptions: {
      // This environment ships a pinned Chromium that predates the browser build
      // this Playwright release would download, so point at it directly rather
      // than fetching another copy.
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
      args: [
        '--enable-unsafe-swiftshader',
        '--use-gl=swiftshader',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
