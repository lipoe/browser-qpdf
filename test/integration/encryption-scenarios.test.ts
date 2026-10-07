/**
 * Encryption behavior against the real WASM binary (Node).
 * The same scenarios run in the browser, see test/browser/.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import { observeEncryptedFixture, scenarioCases } from '../scenarios/encryption-scenarios.mjs';
import { EXPECTED_OBSERVATIONS } from '../scenarios/expected-observations.mjs';
import { loadFixture, readJson } from './helpers.js';

interface EncryptedManifest {
    source: string;
    ownerPassword: string;
    fixtures: Record<string, { userPassword: string; requiresPassword: boolean }>;
}

const manifest = readJson<EncryptedManifest>('encrypted-manifest.json');

describe('Encryption scenarios (real WASM, Node)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    it('covers every generated fixture with an expectation', () => {
        expect(Object.keys(EXPECTED_OBSERVATIONS).sort()).toEqual(
            scenarioCases(manifest).map(([file]) => file).sort()
        );
    });

    for (const [file, fixture] of scenarioCases(manifest)) {
        it(`${file} behaves as expected`, () => {
            const observation = observeEncryptedFixture(
                api,
                loadFixture(file),
                loadFixture(manifest.source),
                fixture
            );
            expect(observation).toEqual(EXPECTED_OBSERVATIONS[file as keyof typeof EXPECTED_OBSERVATIONS]);
        });
    }
});
