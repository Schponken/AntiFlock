/**
 * Screenshot capture, used to eyeball the game while developing it.
 *
 * Not assertions — these just render each screen and save a PNG so the visuals
 * can be reviewed. Run with: npx playwright test e2e/shots.spec.ts
 */

import { test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = 'shots';

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

test('capture every screen', async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('PAGE ERROR:', m.text());
  });
  page.on('pageerror', (e) => console.log('PAGE EXCEPTION:', e.message));

  await page.goto('/');
  await waitForBoot(page);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/01-title.png` });

  // Garage
  await page.getByRole('button', { name: 'Build a Robot' }).click();
  await page.waitForTimeout(1600);
  await page.screenshot({ path: `${OUT}/02-garage.png` });

  // Start the fight and grab the opening beats.
  await page.getByRole('button', { name: 'Fight', exact: true }).click();
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `${OUT}/03-blackout.png` });

  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/04-intro-red.png` });

  await page.waitForTimeout(2900);
  await page.screenshot({ path: `${OUT}/05-intro-blue.png` });

  await page.waitForTimeout(3400);
  await page.screenshot({ path: `${OUT}/06-countdown.png` });

  await page.waitForTimeout(3200);
  await page.screenshot({ path: `${OUT}/07-fight-start.png` });

  // Drive into the opponent with the weapon up.
  await page.keyboard.down('Space');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/08-spinning.png` });

  await page.keyboard.down('KeyW');
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${OUT}/09-engaging.png` });
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `${OUT}/10-contact.png` });
  await page.keyboard.up('KeyW');
  await page.keyboard.up('Space');

  // Chase camera.
  await page.keyboard.press('KeyC');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/11-chase.png` });

  // Result card via a count-out.
  await page.keyboard.press('KeyC');
  await page.evaluate(() => {
    const api = (
      window as unknown as {
        antiflock: { getFight: () => { blue: { health: { wheels: number[] } } } | null };
      }
    ).antiflock;
    api.getFight()?.blue.health.wheels.fill(0);
  });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/12-ko-count.png` });
  await page.waitForTimeout(9000);
  await page.screenshot({ path: `${OUT}/13-result.png` });
});
