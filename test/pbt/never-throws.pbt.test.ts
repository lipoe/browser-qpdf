/**
 * Property: no public operation throws, for arbitrary arguments and
 * arbitrary wrapper behavior (mocked WASM: errors, exceptions, odd values).
 */

import { describe, it, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams } from '../../src/index.js';
import { mockWasm, resetMockWasm } from '../__mocks__/qpdf-image-stream.js';
import {
    anyArgument,
    DOCUMENT_OPERATIONS,
    expectNeverThrows,
    LOAD_OPERATIONS,
} from '../support/api-invariants.js';

/** Arbitrary return value or exception of a raw wrapper method. */
const wrapperBehavior = fc.oneof(
    fc.record({ throws: fc.constant(true), message: fc.string() }),
    fc.record({ throws: fc.constant(false), value: fc.anything() }),
    fc.record({ throws: fc.constant(false), value: fc.constant(new Uint8Array(2)) }),
    fc.record({
        throws: fc.constant(false),
        value: fc.record({ success: fc.boolean(), kind: fc.anything(), error: fc.anything() }),
    })
);

type Behavior = typeof wrapperBehavior extends fc.Arbitrary<infer T> ? T : never;

function install(behavior: Behavior) {
    const fn = () => {
        if (behavior.throws) throw new Error(behavior.message);
        return behavior.value;
    };
    for (const key of [
        'getImages',
        'getImageStreamData',
        'getRawImageStreamData',
        'replaceImageStream',
        'isEncrypted',
        'writePdf',
    ] as const) {
        (mockWasm as Record<string, unknown>)[key] = fn;
    }
}

describe('Property: public operations never throw (mocked WASM)', () => {
    beforeEach(() => resetMockWasm());

    it.each(Object.keys(LOAD_OPERATIONS))('%s with arbitrary arguments', async (name) => {
        const api = await createQpdfImageStreams();
        fc.assert(
            fc.property(fc.array(anyArgument, { maxLength: 3 }), wrapperBehavior, (args, behavior) => {
                resetMockWasm();
                mockWasm.loadPdf = () => (behavior.throws ? { success: true } : behavior.value);
                mockWasm.loadPdfWithPassword = mockWasm.loadPdf;
                const result = expectNeverThrows(() => LOAD_OPERATIONS[name](api, args)) as {
                    ok: boolean;
                    value?: { close(): void };
                };
                if (result.ok) result.value?.close();
            }),
            { numRuns: 300 }
        );
    });

    it.each(Object.keys(DOCUMENT_OPERATIONS))('%s with arbitrary arguments and wrapper behavior', async (name) => {
        const api = await createQpdfImageStreams();
        fc.assert(
            fc.property(fc.array(anyArgument, { maxLength: 4 }), wrapperBehavior, (args, behavior) => {
                resetMockWasm();
                const loaded = api.loadPdf(new Uint8Array([1]));
                if (!loaded.ok) throw new Error(loaded.error);
                install(behavior);
                expectNeverThrows(() => DOCUMENT_OPERATIONS[name](loaded.value, args));
                loaded.value.close();
            }),
            { numRuns: 300 }
        );
    });
});
