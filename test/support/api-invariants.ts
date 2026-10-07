/**
 * Invariants of the public API, shared by property tests against the mocked
 * and the real WASM module:
 *
 * - no public operation ever throws
 * - every operation returns a well-formed Result; failures carry a known
 *   ErrorCode and a non-empty message
 */

import { expect } from 'vitest';
import * as fc from 'fast-check';
import { ERROR_CODES, type PdfDocument, type QpdfImageStreams } from '../../src/index.js';

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

/** Any JS value, biased towards values that are close to valid arguments. */
export const anyArgument = fc.oneof(
    fc.anything(),
    fc.integer({ min: -2, max: 20 }),
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

/** Every public document operation, called with arbitrary arguments. */
export const DOCUMENT_OPERATIONS: Record<string, (doc: PdfDocument, args: unknown[]) => unknown> = {
    getImages: (doc, [options]) => doc.getImages(options as never),
    getImageStreamData: (doc, [objId, gen]) => doc.getImageStreamData(objId as never, gen as never),
    getRawImageStreamData: (doc, [objId, gen]) => doc.getRawImageStreamData(objId as never, gen as never),
    replaceImageStream: (doc, [objId, gen, data, metadata]) =>
        doc.replaceImageStream(objId as never, gen as never, data as never, metadata as never),
    isEncrypted: (doc) => doc.isEncrypted(),
    writePdf: (doc, [options]) => doc.writePdf(options as never),
    close: (doc) => doc.close(),
};

/** Every public load operation, called with arbitrary arguments. */
export const LOAD_OPERATIONS: Record<string, (api: QpdfImageStreams, args: unknown[]) => unknown> = {
    loadPdf: (api, [data]) => api.loadPdf(data as never),
    loadPdfWithPassword: (api, [data, password]) => api.loadPdfWithPassword(data as never, password as never),
};

/** Call `operation` and assert it neither throws nor returns a malformed Result. */
export function expectNeverThrows(operation: () => unknown): unknown {
    let result: unknown;
    expect(() => {
        result = operation();
    }).not.toThrow();
    expectWellFormedResult(result);
    return result;
}
