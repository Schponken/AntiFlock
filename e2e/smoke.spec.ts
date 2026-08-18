/**
 * End-to-end tests: boot the real game in real Chromium, drive it, and check
 * that it renders and that a fight actually plays out.
 *
 * These are the tests that catch what neither the unit tests nor the headless
 * physics tests can — a shader that will not compile, a texture that throws,
 * a UI panel that never appears, or a black screen.
 */

import { test, expect, type Page } from '@playwright/test';

/** Anything the page logs as an error is a failure. */
function watchForErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

/** Wait until the game has booted and exposed its debug handle. */
async function waitForBoot(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const api = (window as { antiflock?: { getScreen?: () => string } }).antiflock;
      return typeof api?.getScreen === 'function' && api.getScreen() !== 'loading';
    },
    undefined,
    { timeout: 60_000 },
  );
}

type Snapshot = {
  screen: string;
  hasFight: boolean;
  phase: string | null;
  timeRemaining: number | null;
  redName: string;
  blueName: string;
  redCondition: number | null;
  blueCondition: number | null;
  redPosition: { x: number; y: number; z: number } | null;
  bluePosition: { x: number; y: number; z: number } | null;
  redSpin: number | null;
  result: { winner: string; reason: string } | null;
};

async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(
    () => (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock.getState(),
  );
}

/**
 * How much of the canvas is not background. A rendered arena fills most of the
 * frame; a black screen or a failed context does not.
 */
async function measureBrightness(page: Page): Promise<{ mean: number; nonBlack: number }> {
  return page.evaluate(() => {
    const source = document.getElementById('scene') as HTMLCanvasElement;
    const scratch = document.createElement('canvas');
    scratch.width = 160;
    scratch.height = 100;
    const ctx = scratch.getContext('2d');
    if (!ctx) return { mean: 0, nonBlack: 0 };
    ctx.drawImage(source, 0, 0, scratch.width, scratch.height);
    const { data } = ctx.getImageData(0, 0, scratch.width, scratch.height);
    let total = 0;
    let nonBlack = 0;
    const pixels = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
      total += luma;
      if (luma > 12) nonBlack++;
    }
    return { mean: total / pixels, nonBlack: nonBlack / pixels };
  });
}

test.describe('boot', () => {
  test('loads, initialises WebGL and Rapier, and shows the title screen', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);

    await expect(page.locator('#title')).toBeVisible();
    await expect(page.locator('#title .title-mark')).toHaveText('ANTIFLOCK');
    await expect(page.locator('#loading')).toBeHidden();

    const state = await snapshot(page);
    expect(state.screen).toBe('title');

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('renders the arena rather than a black screen', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    // Give the orbit camera a moment to settle on the lit cage.
    await page.waitForTimeout(1500);

    const { mean, nonBlack } = await measureBrightness(page);
    expect(mean, 'the canvas is essentially black').toBeGreaterThan(6);
    expect(nonBlack, 'almost nothing is being drawn').toBeGreaterThan(0.5);
  });

  test('reports a WebGL 2 context', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    const info = await page.evaluate(() => {
      const canvas = document.getElementById('scene') as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2');
      return gl ? gl.getParameter(gl.VERSION) : null;
    });
    expect(String(info)).toContain('WebGL');
  });
});

test.describe('garage', () => {
  test('opens and lists every part category', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);

    await page.getByRole('button', { name: 'Build a Robot' }).click();
    await expect(page.locator('#garage')).toBeVisible();

    for (const heading of ['Identity', 'Chassis', 'Weapon', 'Armour', 'Drivetrain', 'Performance']) {
      await expect(page.locator('.section-head', { hasText: heading }).first()).toBeVisible();
    }

    // The weight readout must be present and under the limit.
    const weight = await page.locator('.weight-total').first().innerText();
    expect(weight).toMatch(/\d+\.\d lb/);
    await expect(page.locator('.weight-total.over')).toHaveCount(0);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('changing a part updates the weight and the derived stats', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Build a Robot' }).click();

    const readWeight = async () =>
      parseFloat((await page.locator('.weight-total').first().innerText()).replace(/[^\d.]/g, ''));

    const before = await readWeight();

    // Switch to the heaviest weapon available on this frame.
    await page.locator('.option', { hasText: 'Overkill Bar' }).first().click();
    await page.waitForTimeout(120);

    const after = await readWeight();
    expect(after).not.toBe(before);
    // And the armour must have been trimmed to keep it legal, or it is flagged.
    const overweight = await page.locator('.weight-total.over').count();
    const warning = await page.locator('.warning').count();
    expect(overweight === 0 || warning > 0).toBe(true);
  });

  test('greys out a weapon the chassis cannot mount, with the reason', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Build a Robot' }).click();

    // The bar frame has no vertical mount, so the disc must be unavailable.
    await page.locator('.option', { hasText: 'Bar Frame' }).first().click();
    await page.waitForTimeout(120);

    const disc = page.locator('.option', { hasText: 'Vertical Disc' }).first();
    await expect(disc).toHaveClass(/illegal/);
    await expect(disc).toBeDisabled();
    await expect(disc).toContainText('no front-vertical mount');
  });

  test('random build always produces a legal robot', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Build a Robot' }).click();

    for (let i = 0; i < 12; i++) {
      await page.getByRole('button', { name: 'Random Build' }).click();
      await page.waitForTimeout(60);
      await expect(page.locator('.weight-total.over')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Fight', exact: true })).toBeEnabled();
    }
  });

  test('renaming the robot keeps focus in the field', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Build a Robot' }).click();

    const field = page.locator('#garage input[type=text]').first();
    await field.click();
    await field.fill('');
    await field.type('SHREDDER', { delay: 25 });
    await expect(field).toBeFocused();
    await expect(field).toHaveValue('SHREDDER');
  });
});

test.describe('the start sequence', () => {
  test('runs the whole show and ends with the fight live', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);

    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await expect(page.locator('#hud')).toBeVisible();

    // The introductions put a lower-third on screen.
    await expect(page.locator('.lower-third.visible')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.lower-third.red .lower-third-name')).not.toBeEmpty();

    // Then the countdown numbers.
    await expect(page.locator('.countdown-number')).toBeVisible({ timeout: 20_000 });

    // And finally the fight goes live.
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock;
        const state = api.getState();
        return state.phase === 'fight' || state.phase === 'knockout';
      },
      undefined,
      { timeout: 30_000 },
    );

    const state = await snapshot(page);
    expect(state.hasFight).toBe(true);
    expect(state.timeRemaining).toBeGreaterThan(150);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the arena is dark during the introductions and lit for the fight', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();

    // Sample once the blackout has taken hold.
    await page.waitForTimeout(2200);
    const dark = await measureBrightness(page);

    // Skip to the fight and sample again.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1800);
    const lit = await measureBrightness(page);

    expect(lit.mean, 'the arena did not get brighter for the fight').toBeGreaterThan(dark.mean);
  });

  test('Enter skips the intro straight into the fight', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.waitForTimeout(600);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);

    const state = await snapshot(page);
    expect(['fight', 'knockout']).toContain(state.phase);
  });
});

test.describe('fighting', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock;
        return ['fight', 'knockout'].includes(api.getState().phase ?? '');
      },
      undefined,
      { timeout: 30_000 },
    );
  });

  test('the player robot drives when keys are held', async ({ page }) => {
    const before = await snapshot(page);

    await page.keyboard.down('KeyW');
    await page.waitForTimeout(1400);
    await page.keyboard.up('KeyW');

    const after = await snapshot(page);
    const moved = Math.hypot(
      after.redPosition!.x - before.redPosition!.x,
      after.redPosition!.z - before.redPosition!.z,
    );
    expect(moved, 'the robot did not move under throttle').toBeGreaterThan(0.7);
  });

  test('the weapon spins up while the key is held', async ({ page }) => {
    const before = await snapshot(page);
    expect(before.redSpin).toBeLessThan(0.2);

    await page.keyboard.down('Space');
    await page.waitForTimeout(4000);
    await page.keyboard.up('Space');

    const after = await snapshot(page);
    expect(after.redSpin!, 'the weapon never spun up').toBeGreaterThan(before.redSpin! + 0.05);
  });

  test('the clock counts down and the HUD tracks it', async ({ page }) => {
    const before = await snapshot(page);
    await page.waitForTimeout(2500);
    const after = await snapshot(page);

    expect(after.timeRemaining!).toBeLessThan(before.timeRemaining!);

    const shown = await page.locator('.hud-clock-time').innerText();
    expect(shown).toMatch(/^\d:\d\d$/);
  });

  test('the HUD shows both robots with health bars', async ({ page }) => {
    await expect(page.locator('.hud-bot.red .hud-name')).not.toBeEmpty();
    await expect(page.locator('.hud-bot.blue .hud-name')).not.toBeEmpty();
    await expect(page.locator('.hud-bot.red .hud-health-fill')).toBeVisible();
    await expect(page.locator('.hud-bot.blue .hud-health-fill')).toBeVisible();
  });

  test('the opponent drives itself', async ({ page }) => {
    const before = await snapshot(page);
    await page.waitForTimeout(3000);
    const after = await snapshot(page);

    const moved = Math.hypot(
      after.bluePosition!.x - before.bluePosition!.x,
      after.bluePosition!.z - before.bluePosition!.z,
    );
    expect(moved, 'the opponent never moved').toBeGreaterThan(0.5);
  });

  test('runs a sustained fight without errors or robots escaping the cage', async ({ page }) => {
    const errors = watchForErrors(page);

    // Drive hard for a while with the weapon running.
    await page.keyboard.down('Space');
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(900);
      await page.keyboard.up('KeyW');
      await page.keyboard.down(i % 2 === 0 ? 'KeyA' : 'KeyD');
      await page.waitForTimeout(500);
      await page.keyboard.up(i % 2 === 0 ? 'KeyA' : 'KeyD');
    }
    await page.keyboard.up('Space');

    const state = await snapshot(page);
    for (const position of [state.redPosition!, state.bluePosition!]) {
      expect(Math.abs(position.x)).toBeLessThan(8);
      expect(Math.abs(position.z)).toBeLessThan(8);
      expect(position.y).toBeGreaterThan(-0.5);
      expect(position.y).toBeLessThan(6);
    }

    // Something should have happened to at least one of them.
    expect(Math.min(state.redCondition!, state.blueCondition!)).toBeLessThanOrEqual(1);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the camera can be cycled and keeps rendering', async ({ page }) => {
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('KeyC');
      await page.waitForTimeout(700);
      const { nonBlack } = await measureBrightness(page);
      expect(nonBlack, `camera mode ${i} rendered nothing`).toBeGreaterThan(0.3);
    }
  });

  test('pause stops the clock and resume restarts it', async ({ page }) => {
    await page.keyboard.press('KeyP');
    const paused = await snapshot(page);
    await page.waitForTimeout(1200);
    const stillPaused = await snapshot(page);
    expect(stillPaused.timeRemaining).toBe(paused.timeRemaining);

    await page.keyboard.press('KeyP');
    await page.waitForTimeout(900);
    const resumed = await snapshot(page);
    expect(resumed.timeRemaining!).toBeLessThan(paused.timeRemaining!);
  });

  test('the debug overlay opens and reports live simulation values', async ({ page }) => {
    await page.keyboard.press('F3');
    await page.waitForTimeout(400);
    const debug = page.locator('#debug');
    await expect(debug).toBeVisible();
    await expect(debug).toContainText('phase');
    await expect(debug).toContainText('RED');
    await expect(debug).toContainText('BLUE');
  });
});

test.describe('finishing a match', () => {
  test('a knockout ends the fight and shows the result card', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => {
        const api = (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock;
        return ['fight', 'knockout'].includes(api.getState().phase ?? '');
      },
      undefined,
      { timeout: 30_000 },
    );

    // Disable the opponent's drive so the referee has to count it out. This is
    // the damage model's own immobilisation path, not a test-only shortcut.
    await page.evaluate(() => {
      const api = (
        window as unknown as {
          antiflock: { getFight: () => { blue: { health: { wheels: number[] } } } | null };
        }
      ).antiflock;
      const fight = api.getFight();
      if (fight) fight.blue.health.wheels.fill(0);
    });

    await page.waitForFunction(
      () => {
        const api = (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock;
        return api.getState().result !== null;
      },
      undefined,
      { timeout: 40_000 },
    );

    const state = await snapshot(page);
    expect(state.result!.reason).toBe('knockout');
    expect(state.result!.winner).toBe('a');

    // The card appears after a short beat.
    await expect(page.locator('#result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.result-reason').first()).toContainText('Knockout');
    await expect(page.locator('.result-winner-name')).not.toBeEmpty();

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('the result card can start a rematch', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => {
        const api = (window as unknown as { antiflock: { getState: () => Snapshot } }).antiflock;
        return ['fight', 'knockout'].includes(api.getState().phase ?? '');
      },
      undefined,
      { timeout: 30_000 },
    );

    await page.evaluate(() => {
      const api = (
        window as unknown as {
          antiflock: { getFight: () => { blue: { health: { wheels: number[] } } } | null };
        }
      ).antiflock;
      api.getFight()?.blue.health.wheels.fill(0);
    });

    await expect(page.locator('#result')).toBeVisible({ timeout: 45_000 });
    await page.getByRole('button', { name: 'Rematch' }).click();
    await page.waitForTimeout(800);

    const state = await snapshot(page);
    expect(state.screen).toBe('fight');
    expect(state.result).toBeNull();
    expect(state.timeRemaining).toBeGreaterThan(170);
  });
});

test.describe('robustness', () => {
  test('survives being resized mid-fight', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);

    for (const size of [
      { width: 800, height: 600 },
      { width: 1600, height: 900 },
      { width: 480, height: 900 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(500);
      const { nonBlack } = await measureBrightness(page);
      expect(nonBlack, `nothing rendered at ${size.width}x${size.height}`).toBeGreaterThan(0.3);
    }

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('can go title to garage to fight and back repeatedly', async ({ page }) => {
    const errors = watchForErrors(page);
    await page.goto('/');
    await waitForBoot(page);

    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Build a Robot' }).click();
      await expect(page.locator('#garage')).toBeVisible();

      await page.getByRole('button', { name: 'Fight', exact: true }).click();
      await expect(page.locator('#hud')).toBeVisible();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);

      await page.keyboard.press('Escape');
      await expect(page.locator('#title')).toBeVisible();
    }

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('keeps a usable frame rate during a fight', async ({ page }) => {
    await page.goto('/');
    await waitForBoot(page);
    await page.getByRole('button', { name: 'Enter the Arena' }).click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1500);

    const fps = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          let frames = 0;
          const start = performance.now();
          const tick = () => {
            frames++;
            if (performance.now() - start >= 3000) {
              resolve((frames / (performance.now() - start)) * 1000);
            } else {
              requestAnimationFrame(tick);
            }
          };
          requestAnimationFrame(tick);
        }),
    );

    // SwiftShader is a software rasteriser, so this is a floor for "the loop is
    // running and not stalling", not a performance target for real hardware.
    expect(fps, `only ${fps.toFixed(1)} fps`).toBeGreaterThan(5);
  });
});
