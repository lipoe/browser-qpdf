/**
 * Cross-language contract: the error `kind` literals produced by the C++
 * wrapper (src/wrapper.cpp) must match RAW_ERROR_KINDS in src/errors.ts.
 *
 * Every kind is triggered against the real WASM binary, bypassing the
 * TypeScript layer (which would otherwise intercept e.g. disposed calls).
 */

import { describe, it, expect } from 'vitest';
import { RAW_ERROR_KINDS } from '../../src/errors.js';
import { loadFixture, withRawWrapper, type RawError, type RawWrapper } from './helpers.js';

const TRIGGERS: Record<(typeof RAW_ERROR_KINDS)[number], (wrapper: RawWrapper) => unknown> = {
    password: (w) => w.loadPdf(loadFixture('aes256-user.pdf')),
    damaged_pdf: (w) => w.loadPdf(new Uint8Array([1, 2, 3])),
    invalid_argument: (w) => {
        w.loadPdf(loadFixture('multi-image.pdf'));
        return w.getImageStreamData(99, 0);
    },
    disposed: (w) => {
        w.loadPdf(loadFixture('multi-image.pdf'));
        w.close();
        return w.writePdf(true);
    },
    unknown: (w) => w.isEncrypted(), // nothing loaded
};

describe('Raw wrapper error kinds (real WASM)', () => {
    it.each(RAW_ERROR_KINDS)('the C++ wrapper reports kind "%s"', async (kind) => {
        const result = (await withRawWrapper(TRIGGERS[kind])) as RawError;
        expect(result.success).toBe(false);
        expect(result.kind).toBe(kind);
        expect(result.error?.length).toBeGreaterThan(0);
    });

    it.each([
        ['getImages', (w: RawWrapper) => w.getImages(false)],
        ['getImageStreamData', (w: RawWrapper) => w.getImageStreamData(1, 0)],
        ['getRawImageStreamData', (w: RawWrapper) => w.getRawImageStreamData(1, 0)],
        [
            'replaceImageStream',
            (w: RawWrapper) =>
                w.replaceImageStream(1, 0, new Uint8Array(1), {
                    width: 0,
                    height: 0,
                    bitsPerComponent: 0,
                    colorSpace: '',
                    filter: '',
                }),
        ],
        ['isEncrypted', (w: RawWrapper) => w.isEncrypted()],
        ['writePdf', (w: RawWrapper) => w.writePdf(true)],
        ['readImage', (w: RawWrapper) => w.readImage(1, 0)],
        ['getPageCount', (w: RawWrapper) => w.getPageCount()],
        ['getPageInfo', (w: RawWrapper) => w.getPageInfo(0)],
    ])('%s reports only known kinds (disposed and unloaded)', async (_name, call) => {
        for (const prepare of [
            (w: RawWrapper) => w.close(),
            () => undefined,
        ]) {
            const result = (await withRawWrapper((w) => {
                prepare(w);
                return call(w);
            })) as RawError;
            expect(RAW_ERROR_KINDS).toContain(result.kind);
        }
    });
});
