/**
 * Runs the shared image paint scenarios against the built package (dist/) in
 * a real browser, on the main thread and in a Web Worker, and compares with
 * test/fixtures/paint-manifest.json, the same table the Node tests use.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedPaintObservations } from '../scenarios/paint-scenarios.mjs';

const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'paint-manifest.json'), 'utf8')
) as { fixtures: Record<string, unknown> };
const EXPECTED = expectedPaintObservations(manifest);

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/harness.html');
    await page.waitForFunction(() => window.harnessReady === true);
});

test('image paint scenarios in the page match the paint manifest', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInPage('paints'));
    expect(observations).toEqual(EXPECTED);
});

test('image paint scenarios in a Web Worker match the paint manifest', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInWorker('paints'));
    expect(observations).toEqual(EXPECTED);
});
