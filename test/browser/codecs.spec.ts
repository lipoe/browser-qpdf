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

test('toImageBitmap with a mask that cannot be decoded fails with the mask\'s code, never returning the unmasked picture', async ({ page }) => {
    const result = await page.evaluate(async () => {
        const codecs = await import('/dist/codecs/index.js');
        const rgb = { family: 'DeviceRGB', components: 3, raw: '/DeviceRGB' };
        const masks = { isStencilMask: false, softMaskInData: null, softMask: null, mask: null, softMaskOf: [], maskOf: [] };
        const info = (colorSpaceInfo: unknown) => ({
            objId: 1, generation: 0, width: 1, height: 1, bitsPerComponent: 8, colorSpace: '', filter: null, streamLength: 0,
            colorSpaceInfo, filters: [], decode: null, encoding: { kind: 'samples' }, masks, pages: [0], directPages: [0],
        });
        const picture = { data: new Uint8Array([255, 0, 0]), encoding: { kind: 'samples' } };
        const badMask = { data: new Uint8Array([0]), encoding: { kind: 'samples' } };
        const separation = { family: 'Separation', components: 1, names: ['Spot'], alternate: rgb, raw: '' };
        const r = await codecs.toImageBitmap(picture, info(rgb), { softMask: { image: badMask, info: info(separation) } });
        return r.ok ? 'ok' : r.code;
    });
    expect(result).toBe('UNSUPPORTED_COLOR_SPACE');
});
