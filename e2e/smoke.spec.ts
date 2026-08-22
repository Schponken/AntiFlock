import { expect, test, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * End-to-end smoke tests.
 *
 * These drive the real build in a real browser: WebGL context, procedural
 * texture generation, the Rapier WASM module, the show open and a live fight.
 * Anything that throws at runtime shows up here and nowhere else.
 */

/** Errors we do not control and that do not indicate a broken game. */
const IGNORED = [
  /AudioContext/i,
  /play\(\) failed/i,
  /Failed to load resource.*fonts\.googleapis/i,
  /net::ERR_/i,
  /SwiftShader/i,
  /GroupMarkerNotSet/i,
  /Automatic fallback to software WebGL/i,
];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    errors.push(`console: ${text}`);
  });
  // Report the URL of anything that fails to load, so a 404 is actionable
  // rather than an anonymous console line.
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (IGNORED.some((pattern) => pattern.test(url))) return;
    errors.push(`http ${response.status()}: ${url}`);
  });
  page.on('pageerror', (error) => {
    if (IGNORED.some((pattern) => pattern.test(error.message))) return;
    errors.push(`pageerror: ${error.message}\n${error.stack ?? ''}`);
  });
  return errors;
}

test.describe('AntiFlock', () => {
  test('boots to the title screen with a live WebGL context', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');

    await expect(page.locator('.screen--title')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('.logo')).toHaveText('ANTIFLOCK');

    // The renderer must actually be drawing, not just present in the DOM.
    const drawing = await page.evaluate(() => {
      const canvas = document.getElementById('viewport') as HTMLCanvasElement | null;
      if (!canvas) return { ok: false, reason: 'no canvas' };
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      return {
        ok: !!gl && canvas.width > 0 && canvas.height > 0,
        width: canvas.width,
        height: canvas.height,
      };
    });
    expect(drawing.ok, JSON.stringify(drawing)).toBe(true);

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });

  test('the workshop edits a design and updates the live readout', async ({ page }) => {
    // Same budget as the fight tests: the workshop renders a live 3D preview, and
    // this machine runs WebGL on the CPU at about a frame a second.
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.locator('.screen--title')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'WORKSHOP' }).click();
    await expect(page.locator('.builder')).toBeVisible();

    // Every tab must render without throwing.
    for (const tab of ['Frame', 'Armour', 'Drive', 'Weapon', 'Extras', 'Livery']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expect(page.locator('.builder__options')).toBeVisible();
    }

    // Changing the armour material must move the weight readout.
    await page.getByRole('button', { name: 'Armour', exact: true }).click();
    const weightBefore = await page.locator('.weight__head strong').innerText();
    await page.locator('.option', { hasText: 'AR500 Steel' }).click();
    await expect(page.locator('.weight__head strong')).not.toHaveText(weightBefore);

    /*
     * Overweight builds must be caught and must block the fight.
     *
     * The old assertion here was `expect(locator).toBeTruthy()`, which passes for
     * any locator whether or not it matches anything — so the one check that the
     * weight limit is enforced through the real UI asserted nothing at all. These
     * three are the actual contract: an error is shown, it names the limit, and
     * the fight button refuses.
     */
    await page.locator('.slider__input').first().fill('20');
    const error = page.locator('.issue--error').first();
    await expect(error).toBeVisible();
    await expect(error).toContainText(/class limit/i);
    await expect(page.locator('.builder__foot .btn--primary')).toHaveText('ILLEGAL BUILD');
    await expect(page.locator('.builder__foot .btn--primary')).toBeDisabled();

    // ...and pulling it back under the limit must clear both.
    await page.locator('.slider__input').first().fill('4');
    await expect(page.locator('.issue--error')).toHaveCount(0);
    await expect(page.locator('.builder__foot .btn--primary')).toBeEnabled();

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });

  test('runs a full fight: show open, live physics, HUD and a result', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.locator('.screen--title')).toBeVisible({ timeout: 60_000 });

    await page.getByRole('button', { name: 'ENTER THE BOX' }).click();
    await expect(page.locator('.screen--opponent')).toBeVisible();

    await page.locator('.opponent', { hasText: 'Anvilhead' }).click();
    await page.getByRole('button', { name: 'FIGHT', exact: true }).click();

    // The show open runs first: the HUD comes alive and cards appear.
    await expect(page.locator('.hud--live')).toBeVisible({ timeout: 30_000 });

    const introCard = await page
      .locator('.hud__card.is-visible')
      .first()
      .textContent({ timeout: 30_000 })
      .catch(() => null);
    expect(introCard, 'the show open never displayed a card').toBeTruthy();

    // Skip the rest of the introductions and get into the fight.
    await page.keyboard.press('Space');

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const app = (globalThis as Record<string, any>).__antiflock;
            return app?.match?.getState?.() ?? 'none';
          }),
        { timeout: 60_000, message: 'match never reached the fighting state' },
      )
      .toBe('fighting');

    const before = await page.evaluate(() => {
      const match = (globalThis as Record<string, any>).__antiflock.match;
      const position = match.player.position();
      const forward = match.player.forward();
      return {
        stepCount: match.world.stepCount as number,
        position: [position.x, position.y, position.z] as [number, number, number],
        forward: [forward.x, 0, forward.z] as [number, number, number],
      };
    });
    const stepsBefore = before.stepCount;

    /*
     * Drive with the weapon running, until the *simulation* has advanced — not
     * until a wall clock has.
     *
     * This machine runs WebGL on the CPU at about a frame a second, and the loop
     * caps catch-up at 24 fixed steps per frame, so six seconds of wall time is a
     * fraction of a second of simulated driving. Waiting on the solver's own step
     * counter makes the test measure the drivetrain instead of the frame rate.
     */
    await page.keyboard.down('KeyW');
    await page.keyboard.down('ShiftLeft');
    await expect
      .poll(
        async () =>
          page.evaluate(
            (from) =>
              ((globalThis as Record<string, any>).__antiflock.match.world.stepCount as number) -
              from,
            stepsBefore,
          ),
        { timeout: 150_000, message: 'the solver never advanced two seconds of fight' },
      )
      .toBeGreaterThan(2 * 480);
    await page.keyboard.up('KeyW');
    await page.keyboard.up('ShiftLeft');

    const telemetry = await page.evaluate(() => {
      const app = (globalThis as Record<string, any>).__antiflock;
      const match = app?.match;
      if (!match) return null;
      return {
        state: match.getState(),
        remaining: match.timeRemaining,
        playerY: match.player.position().y,
        playerPosition: (() => {
          const p = match.player.position();
          return [p.x, p.y, p.z] as [number, number, number];
        })(),
        playerOmega: Math.abs(match.player.omega),
        opponentMoved: match.opponent.position().length(),
        stepCount: match.world.stepCount,
      };
    });

    expect(telemetry, 'no telemetry from the running match').toBeTruthy();
    // The clock must be running.
    expect(telemetry!.remaining).toBeLessThan(180);
    // The machine must still be on the floor, not NaN and not launched into orbit.
    expect(Number.isFinite(telemetry!.playerY)).toBe(true);
    expect(telemetry!.playerY).toBeGreaterThan(-1);
    expect(telemetry!.playerY).toBeLessThan(3);
    // The weapon must have spun up.
    expect(telemetry!.playerOmega).toBeGreaterThan(20);
    // The solver must have kept stepping throughout. How many steps land in six
    // seconds depends entirely on the renderer — this machine runs WebGL on the
    // CPU — so assert that time advanced, not how fast the host happened to be.
    expect(telemetry!.stepCount).toBeGreaterThan(stepsBefore);
    // The opponent has to be driving too, not parked in its square. This was
    // already being measured and then thrown away.
    expect(telemetry!.opponentMoved, 'the opponent never left its start square').toBeGreaterThan(
      0.5,
    );

    /*
     * The player's own controls, end to end: keyboard to input manager to
     * drivetrain to displacement.
     *
     * Nothing in either suite observed this. The drive mapping could be reversed,
     * or the key handler detached entirely, and every gate stayed green — because
     * this test held W for six seconds and then asserted only that the clock was
     * running and the machine had not been launched into orbit.
     */
    const travelled = [
      telemetry!.playerPosition[0] - before.position[0],
      telemetry!.playerPosition[2] - before.position[2],
    ];
    const distance = Math.hypot(travelled[0]!, travelled[1]!);
    expect(distance, 'holding W moved the machine nowhere').toBeGreaterThan(0.5);
    const alongNose = travelled[0]! * before.forward[0]! + travelled[1]! * before.forward[2]!;
    expect(alongNose, 'holding W drove the machine backwards').toBeGreaterThan(distance * 0.4);

    /*
     * The live readouts.
     *
     * `Hud.update()` — the clock, both integrity bars, the weapon charge, the
     * telemetry line and the INVERTED / DRIVE DAMAGED flags — could be replaced
     * with `return;` without a single gate noticing: the suite only ever checked
     * that the HUD was *visible*, which `attach()` does. These are the numbers the
     * player actually reads.
     */
    const telemetryText = await page.locator('.hud__telemetry').innerText();
    expect(telemetryText, 'the telemetry line is empty').toMatch(/mph/);
    expect(telemetryText).toMatch(/integrity/);
    expect(telemetryText, 'a spun-up rotor should report its speed').toMatch(/rpm/);

    // The clock is counting down, not sitting at its initial value.
    await expect(page.locator('.hud__clock')).not.toHaveText('3:00');

    /*
     * The health bars have to track the damage model, not merely be shaped like a
     * percentage. A format check passes just as well on a bar frozen at "100%",
     * which is exactly what a broken `update()` leaves behind.
     */
    const bars = await page.evaluate(() => {
      const match = (globalThis as Record<string, any>).__antiflock.match;
      // One plate per machine, and each plate carries three bars — integrity,
      // drive and weapon — so take the first of each plate rather than the first
      // two of a flat list.
      const plates = [...document.querySelectorAll('.plate')];
      const widths = plates.map((plate) => {
        const bars = [...plate.querySelectorAll('.bar__fill')] as HTMLElement[];
        return {
          integrity: bars[0]?.style.width ?? '',
          drive: bars[1]?.style.width ?? '',
          weapon: bars[2]?.style.width ?? '',
        };
      });
      return {
        widths,
        integrity: [match.player.damage.integrity, match.opponent.damage.integrity] as [
          number,
          number,
        ],
        mobility: [match.player.damage.mobility, match.opponent.damage.mobility] as [
          number,
          number,
        ],
      };
    });
    expect(bars.widths.length, 'expected a name plate for each machine').toBe(2);
    for (let i = 0; i < 2; i++) {
      const plate = bars.widths[i]!;
      expect(plate.integrity, `plate ${i} integrity bar is not a percentage`).toMatch(
        /^\d+(\.\d+)?%$/,
      );
      expect(
        Number.parseFloat(plate.integrity),
        `plate ${i} integrity bar does not track its machine`,
      ).toBeCloseTo(bars.integrity[i]! * 100, 0);
      expect(
        Number.parseFloat(plate.drive),
        `plate ${i} drive meter does not track its machine`,
      ).toBeCloseTo(bars.mobility[i]! * 100, 0);
      expect(plate.weapon, `plate ${i} weapon meter is not a percentage`).toMatch(
        /^\d+(\.\d+)?%$/,
      );
    }
    /*
     * ...and the bar has to *move*. Reading a value that happens to match is not
     * proof the readout is live, so knock a panel out from under it and watch.
     * Deliberately not waiting for the fight to land a hit: on this box only a
     * couple of seconds of fight are simulated in the time available, and a test
     * that depends on two machines finding each other in that window is a test
     * that fails for reasons unrelated to what it is checking.
     */
    const moved = await page.evaluate(async () => {
      const match = (globalThis as Record<string, any>).__antiflock.match;
      const plate = document.querySelectorAll('.plate')[0]!;
      const bar = plate.querySelector('.bar__fill') as HTMLElement;
      const before = bar.style.width;

      const panel = match.player.damage.get('armor-front');
      panel.hp = panel.maxHp * 0.25;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      return {
        before,
        after: bar.style.width,
        integrity: match.player.damage.integrity as number,
      };
    });
    expect(moved.after, 'the integrity bar is frozen').not.toBe(moved.before);
    expect(Number.parseFloat(moved.after)).toBeCloseTo(moved.integrity * 100, 0);

    // The charge readout tracks the weapon that the telemetry just said is spinning.
    const chargeText = await page.locator('.charge__text').first().innerText();
    expect(chargeText).toMatch(/kJ/);
    expect(Number.parseFloat(chargeText), 'the weapon is spinning but reads 0 kJ').toBeGreaterThan(
      0,
    );

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });

  test('reaches a result when the clock is run down', async ({ page }) => {
    test.setTimeout(300_000);
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.locator('.screen--title')).toBeVisible({ timeout: 60_000 });

    // Use the shortest round length and skip the show open, so the end-of-round
    // path is exercised through the real UI rather than by poking at internals.
    await page.locator('.settings summary').click();
    await page.getByLabel('Round length').selectOption('60');
    await page.locator('.settings__row', { hasText: 'Skip the show open' }).locator('input').check();

    await page.getByRole('button', { name: 'ENTER THE BOX' }).click();
    await page.getByRole('button', { name: 'FIGHT', exact: true }).click();
    await expect(page.locator('.hud--live')).toBeVisible({ timeout: 30_000 });

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const app = (globalThis as Record<string, any>).__antiflock;
            return app?.match?.getState?.() ?? 'none';
          }),
        { timeout: 60_000 },
      )
      .toBe('fighting');

    // A one-minute round plus the post-fight beat.
    await expect(page.locator('.screen--center.results')).toBeVisible({ timeout: 220_000 });
    await expect(page.locator('.results__winner')).not.toBeEmpty();

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });
});
