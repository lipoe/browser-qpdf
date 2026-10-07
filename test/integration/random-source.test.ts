/**
 * The WASM build uses crypto.getRandomValues as qpdf's random data source
 * (AES IVs, AES-256 key derivation). These tests make sure it is really
 * random and that a missing Web Crypto API fails loudly instead of falling
 * back to an insecure source.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import { loadFixture } from './helpers.js';

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string }): T {
    if (!result.ok) throw new Error(`unexpected error result: ${result.error}`);
    return result.value;
}

describe('Random data source (real WASM)', () => {
    let api: QpdfImageStreams;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    afterEach(() => {
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    });

    it.each(['aes128-user.pdf', 'aes256-user.pdf'])(
        '%s: every write uses fresh random IVs',
        (file) => {
            const doc = unwrap(api.loadPdfWithPassword(loadFixture(file), 'geheim'));
            const first = unwrap(doc.writePdf());
            const second = unwrap(doc.writePdf());
            doc.close();

            expect(first.byteLength).toBe(second.byteLength);
            expect(first).not.toEqual(second);
        }
    );

    it('fails with a clear error if crypto.getRandomValues is missing', () => {
        const doc = unwrap(api.loadPdfWithPassword(loadFixture('aes128-user.pdf'), 'geheim'));
        Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });

        const result = doc.writePdf();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe(
                'no secure random source available: globalThis.crypto.getRandomValues is missing'
            );
        }

        // The module stays usable once the source is available again
        Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
        expect(doc.writePdf().ok).toBe(true);
        doc.close();
    });

    it('draws all random data from crypto.getRandomValues within its 65536-byte limit', () => {
        const calls: number[] = [];
        const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
        Object.defineProperty(globalThis, 'crypto', {
            configurable: true,
            value: {
                getRandomValues<T extends ArrayBufferView | null>(array: T): T {
                    calls.push(array!.byteLength);
                    return original(array as never) as T;
                },
            },
        });

        const doc = unwrap(api.loadPdfWithPassword(loadFixture('aes256-user.pdf'), 'geheim'));
        expect(doc.writePdf().ok).toBe(true);
        doc.close();

        expect(calls.length).toBeGreaterThan(0);
        expect(Math.max(...calls)).toBeLessThanOrEqual(65536);
    });
});
