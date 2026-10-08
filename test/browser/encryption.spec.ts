/**
 * Runs the shared encryption scenarios against the built package (dist/)
 * in a real browser, both on the main thread and in a Web Worker.
 */

import { test, expect } from '@playwright/test';
import { EXPECTED_OBSERVATIONS } from '../scenarios/expected-observations.mjs';

declare global {
    interface Window {
        harnessReady?: boolean;
        runSuiteInPage: (suite: string) => Promise<unknown>;
        runSuiteInWorker: (suite: string) => Promise<unknown>;
    }
}

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/harness.html');
    await page.waitForFunction(() => window.harnessReady === true);
});

test('encryption scenarios in the page match the expectations', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInPage('encryption'));
    expect(observations).toEqual(EXPECTED_OBSERVATIONS);
});

test('encryption scenarios in a Web Worker match the expectations', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInWorker('encryption'));
    expect(observations).toEqual(EXPECTED_OBSERVATIONS);
});
