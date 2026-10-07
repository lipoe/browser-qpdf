/**
 * The operation lists in test/support/api-invariants.ts must cover the real
 * public API. A new public method fails this test until it is added there,
 * which puts it under the never-throws / well-formed-result property tests.
 */

import { describe, it, expect } from 'vitest';
import { createQpdfImageStreams } from '../../src/index.js';
import { resetMockWasm } from '../__mocks__/qpdf-image-stream.js';
import { DOCUMENT_OPERATIONS, LOAD_OPERATIONS } from '../support/api-invariants.js';

describe('Public API surface is fully covered by the invariant tests', () => {
    it('QpdfImageStreams methods match LOAD_OPERATIONS', async () => {
        const api = await createQpdfImageStreams();
        expect(Object.keys(api).sort()).toEqual(Object.keys(LOAD_OPERATIONS).sort());
    });

    it('PdfDocument methods match DOCUMENT_OPERATIONS', async () => {
        resetMockWasm();
        const loaded = (await createQpdfImageStreams()).loadPdf(new Uint8Array([1]));
        if (!loaded.ok) throw new Error(loaded.error);
        expect(Object.keys(loaded.value).sort()).toEqual(Object.keys(DOCUMENT_OPERATIONS).sort());
        loaded.value.close();
    });
});
