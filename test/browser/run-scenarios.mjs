/**
 * Loads the built package (dist/) and runs the shared scenario modules.
 * Used by both the browser page (harness.html) and the Web Worker (worker.mjs).
 */

import { createQpdfImageStreams } from '../../dist/index.js';
import * as codecs from '../../dist/codecs/index.js';
import { runEncryptionScenarios } from '../scenarios/encryption-scenarios.mjs';
import { runCatalogScenarios } from '../scenarios/catalog-scenarios.mjs';
import { runCodecScenarios } from '../scenarios/codec-scenarios.mjs';

const FIXTURES_URL = new URL('../fixtures/', import.meta.url);

async function readFixture(name) {
    const response = await fetch(new URL(name, FIXTURES_URL));
    if (!response.ok) throw new Error(`fixture ${name}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

async function readManifest(name) {
    return (await fetch(new URL(name, FIXTURES_URL))).json();
}

/** The scenario suites, by name. Each returns a JSON-comparable observation object. */
export const SUITES = {
    encryption: async (api) =>
        runEncryptionScenarios(api, await readManifest('encrypted-manifest.json'), readFixture),
    catalog: async (api) => runCatalogScenarios(api, await readManifest('manifest.json'), readFixture),
    codecs: async (api) => runCodecScenarios(api, codecs, await readManifest('manifest.json'), readFixture),
};

export async function runSuite(name) {
    const suite = SUITES[name];
    if (!suite) throw new Error(`unknown scenario suite: ${name}`);
    return suite(await createQpdfImageStreams());
}

/** Kept for compatibility with earlier harness code: the encryption suite. */
export const runScenarios = () => runSuite('encryption');
