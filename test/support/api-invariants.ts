/**
 * The public API surface and its invariants, shared by unit, property and
 * integration tests. This is the only list of public operations in the
 * tests; test/unit/api-surface.test.ts checks it against the real objects,
 * so a new public method cannot be missed by the invariant tests.
 *
 * Invariants:
 * - no public operation ever throws
 * - every operation returns a well-formed Result; failures carry a known
 *   ErrorCode and a non-empty message
 */

import { expect } from 'vitest';
import * as fc from 'fast-check';
import { ERROR_CODES, type PdfDocument, type QpdfImageStreams } from '../../src/index.js';

interface Operation<Target> {
    /** Call the operation with arbitrary arguments. */
    call(target: Target, args: unknown[]): unknown;
    /** Arguments that pass validation (object 1 0 is used as reference). */
    validArgs: unknown[];
}

/** Every public PdfDocument method. */
export const DOCUMENT_OPERATIONS: Record<keyof PdfDocument, Operation<PdfDocument>> = {
    getImages: { call: (doc, [options]) => doc.getImages(options as never), validArgs: [] },
    getImageStreamData: {
        call: (doc, [objId, gen]) => doc.getImageStreamData(objId as never, gen as never),
        validArgs: [1, 0],
    },
    getRawImageStreamData: {
        call: (doc, [objId, gen]) => doc.getRawImageStreamData(objId as never, gen as never),
        validArgs: [1, 0],
    },
    replaceImageStream: {
        call: (doc, [objId, gen, data, metadata]) =>
            doc.replaceImageStream(objId as never, gen as never, data as never, metadata as never),
        validArgs: [1, 0, new Uint8Array(1)],
    },
    isEncrypted: { call: (doc) => doc.isEncrypted(), validArgs: [] },
    writePdf: { call: (doc, [options]) => doc.writePdf(options as never), validArgs: [] },
    close: { call: (doc) => doc.close(), validArgs: [] },
};

/** Every public QpdfImageStreams method. */
export const LOAD_OPERATIONS: Record<keyof QpdfImageStreams, Operation<QpdfImageStreams>> = {
    loadPdf: { call: (api, [data]) => api.loadPdf(data as never), validArgs: [new Uint8Array([1])] },
    loadPdfWithPassword: {
        call: (api, [data, password]) => api.loadPdfWithPassword(data as never, password as never),
        validArgs: [new Uint8Array([1]), 'password'],
    },
};

/**
 * Document operations backed by a raw wrapper method of the same name
 * (all except close, which only releases memory).
 */
export const WRAPPER_BACKED_OPERATIONS = (Object.keys(DOCUMENT_OPERATIONS) as (keyof PdfDocument)[]).filter(
    (name) => name !== 'close'
);

/** Assert that `result` is a well-formed Result (or undefined for close()). */
export function expectWellFormedResult(result: unknown): void {
    if (result === undefined) return;
    const r = result as { ok?: unknown; code?: unknown; error?: unknown };
    expect(typeof r.ok).toBe('boolean');
    if (r.ok) return;
    expect(ERROR_CODES).toContain(r.code);
    expect(typeof r.error).toBe('string');
    expect((r.error as string).length).toBeGreaterThan(0);
}

/** Call `operation` and assert it neither throws nor returns a malformed Result. */
export function expectNeverThrows(operation: () => unknown): unknown {
    let result: unknown;
    expect(() => {
        result = operation();
    }).not.toThrow();
    expectWellFormedResult(result);
    return result;
}

/** Any JS value, biased towards values that are close to valid arguments. */
export const anyArgument = fc.oneof(
    fc.anything(),
    fc.integer({ min: -2, max: 20 }),
    fc.constantFrom(2 ** 31 - 1, 2 ** 31, 2 ** 32 + 5),
    fc.boolean(),
    fc.constantFrom('', '/DCTDecode', 'DeviceRGB', 'false'),
    fc.constant(new Uint8Array([1, 2, 3])),
    fc.record(
        {
            recursive: fc.anything(),
            preserveEncryption: fc.anything(),
            width: fc.oneof(fc.anything(), fc.integer({ min: -2, max: 20 })),
            height: fc.anything(),
            bitsPerComponent: fc.anything(),
            colorSpace: fc.anything(),
            filter: fc.anything(),
        },
        { requiredKeys: [] }
    )
);

/** A sequence of document operations with arbitrary (or valid) arguments. */
export const operationSequence = fc.array(
    fc.record({
        name: fc.constantFrom(...(Object.keys(DOCUMENT_OPERATIONS) as (keyof PdfDocument)[])),
        args: fc.option(fc.array(anyArgument, { maxLength: 4 }), { nil: undefined }),
    }),
    { minLength: 1, maxLength: 8 }
);

/** Run one step of an operationSequence and check the invariants. */
export function runStep(doc: PdfDocument, step: { name: keyof PdfDocument; args?: unknown[] }): void {
    const operation = DOCUMENT_OPERATIONS[step.name];
    expectNeverThrows(() => operation.call(doc, step.args ?? operation.validArgs));
}
