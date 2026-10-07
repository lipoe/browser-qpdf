/**
 * Loads the built package (dist/) and runs the shared encryption scenarios.
 * Used by both the browser page (harness.html) and the Web Worker (worker.mjs).
 */

import { createQpdfImageStreams } from '../../dist/index.js';
import { runEncryptionScenarios } from '../scenarios/encryption-scenarios.mjs';

const FIXTURES_URL = new URL('../fixtures/', import.meta.url);

async function readFixture(name) {
    const response = await fetch(new URL(name, FIXTURES_URL));
    if (!response.ok) throw new Error(`fixture ${name}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function runScenarios() {
    const manifest = await (await fetch(new URL('encrypted-manifest.json', FIXTURES_URL))).json();
    const api = await createQpdfImageStreams();
    return runEncryptionScenarios(api, manifest, readFixture);
}
