/**
 * Runs the shared catalog scenarios against the built package (dist/) in a
 * real browser, on the main thread and in a Web Worker, and compares with
 * test/fixtures/manifest.json, the same table the Node tests use.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedCatalogs } from '../scenarios/catalog-scenarios.mjs';

const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'manifest.json'), 'utf8')
) as { fixtures: Record<string, unknown> };
const EXPECTED = expectedCatalogs(manifest);

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/harness.html');
    await page.waitForFunction(() => window.harnessReady === true);
});

test('catalog scenarios in the page match the manifest', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInPage('catalog'));
    expect(observations).toEqual(EXPECTED);
});

test('catalog scenarios in a Web Worker match the manifest', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInWorker('catalog'));
    expect(observations).toEqual(EXPECTED);
});
