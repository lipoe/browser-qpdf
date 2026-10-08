/**
 * Catalog facts against the real WASM binary (Node), through the shared
 * scenario module. The same module runs in the browser page and in a Web
 * Worker (test/browser/catalog.spec.ts); all three compare against
 * test/fixtures/manifest.json.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import { catalogFixtureNames, expectedCatalog, observeCatalog } from '../scenarios/catalog-scenarios.mjs';
import { loadFixture, readJson } from './helpers.js';

const manifest = readJson<{ fixtures: Record<string, unknown> }>('manifest.json');

describe('Catalog scenarios (real WASM, Node)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    for (const name of catalogFixtureNames(manifest)) {
        it(`${name} is observed as the manifest describes`, () => {
            expect(observeCatalog(api, loadFixture(name))).toEqual(expectedCatalog(manifest.fixtures[name]));
        });
    }
});
