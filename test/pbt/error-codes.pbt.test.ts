/**
 * Property: every error result carries a known ErrorCode and a non-empty
 * message, for arbitrary inputs and arbitrary wrapper behavior (errors with
 * any kind, exceptions, successes) on every public operation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams, type ErrorCode, type PdfDocument } from '../../src/index.js';
import { mockWasm, resetMockWasm } from '../__mocks__/qpdf-image-stream.js';

const ERROR_CODES: readonly ErrorCode[] = [
    'PASSWORD_REQUIRED',
    'INVALID_PASSWORD',
    'INVALID_INPUT',
    'DISPOSED',
    'UNKNOWN',
];

/** Arbitrary behavior of a raw wrapper method. */
const wrapperBehavior = fc.oneof(
    fc.record({
        type: fc.constant('error' as const),
        kind: fc.option(
            fc.oneof(
                fc.constantFrom('password', 'damaged_pdf', 'invalid_argument', 'disposed', 'unknown'),
                fc.string()
            ),
            { nil: undefined }
        ),
        error: fc.option(fc.string(), { nil: undefined }),
    }),
    fc.record({ type: fc.constant('throw' as const), message: fc.string() }),
    fc.record({ type: fc.constant('ok' as const) })
);

type Behavior = typeof wrapperBehavior extends fc.Arbitrary<infer T> ? T : never;

function apply(behavior: Behavior, okValue: unknown) {
    return () => {
        if (behavior.type === 'throw') throw new Error(behavior.message);
        if (behavior.type === 'error') return { success: false, kind: behavior.kind, error: behavior.error };
        return okValue;
    };
}

/** Arbitrary numbers including invalid object references. */
const anyNumber = fc.oneof(fc.integer({ min: -5, max: 100 }), fc.double(), fc.constant(NaN));

const operation = fc.oneof(
    fc.record({ op: fc.constant('getImages' as const), recursive: fc.boolean() }),
    fc.record({ op: fc.constant('getImageStreamData' as const), objId: anyNumber, gen: anyNumber }),
    fc.record({ op: fc.constant('getRawImageStreamData' as const), objId: anyNumber, gen: anyNumber }),
    fc.record({
        op: fc.constant('replaceImageStream' as const),
        objId: anyNumber,
        gen: anyNumber,
        validData: fc.boolean(),
        width: fc.option(fc.integer({ min: -3, max: 10 }), { nil: undefined }),
    }),
    fc.record({ op: fc.constant('isEncrypted' as const) }),
    fc.record({ op: fc.constant('writePdf' as const), preserveEncryption: fc.option(fc.boolean(), { nil: undefined }) }),
    fc.record({ op: fc.constant('close' as const) })
);

type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never;

function run(doc: PdfDocument, o: Operation) {
    switch (o.op) {
        case 'getImages':
            return doc.getImages({ recursive: o.recursive });
        case 'getImageStreamData':
            return doc.getImageStreamData(o.objId, o.gen);
        case 'getRawImageStreamData':
            return doc.getRawImageStreamData(o.objId, o.gen);
        case 'replaceImageStream':
            return doc.replaceImageStream(
                o.objId,
                o.gen,
                o.validData ? new Uint8Array(1) : ('x' as unknown as Uint8Array),
                { width: o.width }
            );
        case 'isEncrypted':
            return doc.isEncrypted();
        case 'writePdf':
            return doc.writePdf({ preserveEncryption: o.preserveEncryption });
        case 'close':
            doc.close();
            return undefined;
    }
}

function expectWellFormed(result: unknown) {
    if (result === undefined) return;
    const r = result as { ok: boolean; code?: unknown; error?: unknown };
    if (r.ok) return;
    expect(ERROR_CODES).toContain(r.code);
    expect(typeof r.error).toBe('string');
    expect((r.error as string).length).toBeGreaterThan(0);
}

describe('Property: every error result has a known code and a message', () => {
    beforeEach(() => resetMockWasm());

    it('holds for loading with arbitrary input and wrapper behavior', async () => {
        const qpdf = await createQpdfImageStreams();
        await fc.assert(
            fc.asyncProperty(
                wrapperBehavior,
                fc.boolean(),
                fc.option(fc.string(), { nil: undefined }),
                async (behavior, validInput, password) => {
                    mockWasm.loadPdf = apply(behavior, { success: true });
                    mockWasm.loadPdfWithPassword = apply(behavior, { success: true });
                    const input = validInput ? new Uint8Array([1]) : ('x' as unknown as Uint8Array);
                    const result =
                        password === undefined ? qpdf.loadPdf(input) : qpdf.loadPdfWithPassword(input, password);
                    expectWellFormed(result);
                    if (result.ok) result.value.close();
                }
            ),
            { numRuns: 200 }
        );
    });

    it('holds for arbitrary operation sequences on a document', async () => {
        const qpdf = await createQpdfImageStreams();
        await fc.assert(
            fc.asyncProperty(
                fc.array(fc.tuple(operation, wrapperBehavior), { minLength: 1, maxLength: 12 }),
                async (steps) => {
                    resetMockWasm();
                    const loaded = qpdf.loadPdf(new Uint8Array([1]));
                    if (!loaded.ok) throw new Error(loaded.error);
                    for (const [o, behavior] of steps) {
                        mockWasm.getImages = apply(behavior, []);
                        mockWasm.getImageStreamData = apply(behavior, new Uint8Array(1));
                        mockWasm.getRawImageStreamData = apply(behavior, new Uint8Array(1));
                        mockWasm.replaceImageStream = apply(behavior, { success: true });
                        mockWasm.isEncrypted = apply(behavior, false);
                        mockWasm.writePdf = apply(behavior, new Uint8Array(1));
                        expectWellFormed(run(loaded.value, o));
                    }
                }
            ),
            { numRuns: 200 }
        );
    });
});
