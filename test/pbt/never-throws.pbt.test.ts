/**
 * Property: no public operation throws and every result is well-formed
 * (known error code, non-empty message), for arbitrary arguments, arbitrary
 * operation sequences and arbitrary wrapper behavior (mocked WASM: error
 * objects with any kind and message, exceptions, odd return values).
 */

import { describe, it, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams } from '../../src/index.js';
import { RAW_ERROR_KINDS } from '../../src/errors.js';
import { mockWasm, resetMockWasm } from '../__mocks__/qpdf-image-stream.js';
import {
    anyArgument,
    expectNeverThrows,
    LOAD_OPERATIONS,
    operationSequence,
    runStep,
    WRAPPER_BACKED_OPERATIONS,
} from '../support/api-invariants.js';

/** Arbitrary return value or exception of a raw wrapper method. */
const wrapperBehavior = fc.oneof(
    fc.record({ throws: fc.constant(true), message: fc.string() }),
    fc.record({ throws: fc.constant(false), value: fc.anything() }),
    fc.record({ throws: fc.constant(false), value: fc.constant(new Uint8Array(2)) }),
    fc.record({
        throws: fc.constant(false),
        value: fc.record({
            success: fc.boolean(),
            kind: fc.oneof(fc.constantFrom(...RAW_ERROR_KINDS), fc.anything()),
            error: fc.oneof(fc.string(), fc.anything()),
        }),
    })
);

type Behavior = typeof wrapperBehavior extends fc.Arbitrary<infer T> ? T : never;

function behave(behavior: Behavior) {
    return () => {
        if (behavior.throws) throw new Error(behavior.message);
        return behavior.value;
    };
}

describe('Property: public operations never throw (mocked WASM)', () => {
    beforeEach(() => resetMockWasm());

    it.each(Object.keys(LOAD_OPERATIONS) as (keyof typeof LOAD_OPERATIONS)[])(
        '%s with arbitrary arguments and wrapper behavior',
        async (name) => {
            const api = await createQpdfImageStreams();
            fc.assert(
                fc.property(fc.array(anyArgument, { maxLength: 3 }), wrapperBehavior, (args, behavior) => {
                    resetMockWasm();
                    mockWasm.loadPdf = behave(behavior);
                    mockWasm.loadPdfWithPassword = behave(behavior);
                    const result = expectNeverThrows(() => LOAD_OPERATIONS[name].call(api, args)) as {
                        ok: boolean;
                        value?: { close(): void };
                    };
                    if (result.ok) result.value?.close();
                }),
                { numRuns: 300 }
            );
        }
    );

    it('arbitrary operation sequences with arbitrary wrapper behavior', async () => {
        const api = await createQpdfImageStreams();
        fc.assert(
            fc.property(
                fc.array(fc.tuple(operationSequence, wrapperBehavior), { minLength: 1, maxLength: 3 }),
                (rounds) => {
                    resetMockWasm();
                    const loaded = api.loadPdf(new Uint8Array([1]));
                    if (!loaded.ok) throw new Error(loaded.error);
                    for (const [steps, behavior] of rounds) {
                        for (const name of WRAPPER_BACKED_OPERATIONS) {
                            (mockWasm as Record<string, unknown>)[name] = behave(behavior);
                        }
                        for (const step of steps) runStep(loaded.value, step);
                    }
                    loaded.value.close();
                }
            ),
            { numRuns: 500 }
        );
    });
});
