/**
 * Runs the shared encryption scenarios against the built package (dist/)
 * in a real browser, both on the main thread and in a Web Worker.
 */

import { test, expect } from '@playwright/test';
import { EXPECTED_OBSERVATIONS } from '../scenarios/expected-observations.mjs';

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/harness.html');
    await page.waitForFunction(() => (window as unknown as { harnessReady?: boolean }).harnessReady === true);
});

test('encryption scenarios in the page match the expectations', async ({ page }) => {
    const observations = await page.evaluate(() =>
        (window as unknown as { runScenariosInPage: () => Promise<unknown> }).runScenariosInPage()
    );
    expect(observations).toEqual(EXPECTED_OBSERVATIONS);
});

test('encryption scenarios in a Web Worker match the expectations', async ({ page }) => {
    const observations = await page.evaluate(() =>
        (window as unknown as { runScenariosInWorker: () => Promise<unknown> }).runScenariosInWorker()
    );
    expect(observations).toEqual(EXPECTED_OBSERVATIONS);
});
