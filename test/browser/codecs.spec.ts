/**
 * toImageBitmap (codec module, stage A) on every fixture image in a real
 * browser, on the main thread and in a Web Worker. Expected values derive
 * from manifest.json and codec-manifest.json.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedCodecScenarios } from '../scenarios/codec-scenarios.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const read = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const EXPECTED = expectedCodecScenarios(read('manifest.json'), read('codec-manifest.json'));

test.beforeEach(async ({ page }) => {
    await page.goto('/test/browser/harness.html');
    await page.waitForFunction(() => window.harnessReady === true);
});

test('toImageBitmap in the page decodes what stage A covers', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInPage('codecs'));
    expect(observations).toEqual(EXPECTED);
});

test('toImageBitmap in a Web Worker decodes what stage A covers', async ({ page }) => {
    const observations = await page.evaluate(() => window.runSuiteInWorker('codecs'));
    expect(observations).toEqual(EXPECTED);
});
