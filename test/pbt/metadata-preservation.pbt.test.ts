/**
 * Property-based tests for omitted metadata preservation.
 *
 * **Validates: Requirements 5.2**
 *
 * Property 4: Omitted Metadata Fields Are Preserved
 * When metadata fields are omitted, WASM receives 0 for integers and '' for strings.
 * Partial metadata only fills specified fields, others are zero/empty.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams } from '../../src/index.js';
import { mockWasm } from '../__mocks__/qpdf-image-stream.js';


/** The wrapper strips a leading slash; the C++ side adds the PDF name prefix. */
const stripSlash = (v: string) => (v.startsWith('/') ? v.slice(1) : v);

describe('Property 4: Omitted Metadata Fields Are Preserved', () => {
    beforeEach(() => {
        mockWasm.loadPdf = null;
        mockWasm.loadPdfWithPassword = null;
        mockWasm.getImages = null;
        mockWasm.getImageStreamData = null;
        mockWasm.getRawImageStreamData = null;
        mockWasm.replaceImageStream = null;
        mockWasm.writePdf = null;
        mockWasm.close = null;
        mockWasm.getPageCount = null;
    });

    it('when replaceImageStream is called with no metadata, WASM receives all zeros/empty strings', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 10000 }),
                fc.integer({ min: 0, max: 5 }),
                fc.uint8Array({ minLength: 1, maxLength: 100 }),
                async (objId, gen, streamData) => {
                    let capturedMetadata: any = null;
                    mockWasm.replaceImageStream = (
                        _objId: number,
                        _gen: number,
                        _data: Uint8Array,
                        metadata: any
                    ) => {
                        capturedMetadata = metadata;
                        return { success: true };
                    };

                    const qpdf = await createQpdfImageStreams();
                    const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
                    if (!doc.ok) throw new Error('loadPdf failed');

                    // Call with no metadata argument
                    doc.value.replaceImageStream(objId, gen, streamData);

                    expect(capturedMetadata).toEqual({
                        width: 0,
                        height: 0,
                        bitsPerComponent: 0,
                        colorSpace: '',
                        filter: '',
                    });
                }
            ),
            { numRuns: 100 }
        );
    });

    it('when called with partial metadata (only width), WASM receives specified width and all others as 0/empty', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 10000 }),
                fc.integer({ min: 0, max: 5 }),
                fc.uint8Array({ minLength: 1, maxLength: 100 }),
                fc.integer({ min: 1, max: 10000 }),
                async (objId, gen, streamData, width) => {
                    let capturedMetadata: any = null;
                    mockWasm.replaceImageStream = (
                        _objId: number,
                        _gen: number,
                        _data: Uint8Array,
                        metadata: any
                    ) => {
                        capturedMetadata = metadata;
                        return { success: true };
                    };

                    const qpdf = await createQpdfImageStreams();
                    const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
                    if (!doc.ok) throw new Error('loadPdf failed');

                    doc.value.replaceImageStream(objId, gen, streamData, { width });

                    expect(capturedMetadata).toEqual({
                        width,
                        height: 0,
                        bitsPerComponent: 0,
                        colorSpace: '',
                        filter: '',
                    });
                }
            ),
            { numRuns: 100 }
        );
    });

    it('for any subset of metadata fields, omitted fields are always 0 (integers) or empty string (strings)', async () => {
        // Generate a random subset of metadata fields
        const optionalWidth = fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined });
        const optionalHeight = fc.option(fc.integer({ min: 1, max: 10000 }), { nil: undefined });
        const optionalBpc = fc.option(fc.constantFrom(1, 2, 4, 8, 16), { nil: undefined });
        const optionalColorSpace = fc.option(fc.constantFrom('/DeviceRGB', '/DeviceGray'), { nil: undefined });
        const optionalFilter = fc.option(fc.constantFrom('/DCTDecode', '/FlateDecode'), { nil: undefined });

        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 10000 }),
                fc.integer({ min: 0, max: 5 }),
                fc.uint8Array({ minLength: 1, maxLength: 100 }),
                optionalWidth,
                optionalHeight,
                optionalBpc,
                optionalColorSpace,
                optionalFilter,
                async (objId, gen, streamData, width, height, bpc, colorSpace, filter) => {
                    let capturedMetadata: any = null;
                    mockWasm.replaceImageStream = (
                        _objId: number,
                        _gen: number,
                        _data: Uint8Array,
                        metadata: any
                    ) => {
                        capturedMetadata = metadata;
                        return { success: true };
                    };

                    const qpdf = await createQpdfImageStreams();
                    const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
                    if (!doc.ok) throw new Error('loadPdf failed');

                    // Build partial metadata only with defined fields
                    const partialMetadata: Record<string, unknown> = {};
                    if (width !== undefined) partialMetadata.width = width;
                    if (height !== undefined) partialMetadata.height = height;
                    if (bpc !== undefined) partialMetadata.bitsPerComponent = bpc;
                    if (colorSpace !== undefined) partialMetadata.colorSpace = colorSpace;
                    if (filter !== undefined) partialMetadata.filter = filter;

                    doc.value.replaceImageStream(objId, gen, streamData, partialMetadata as any);

                    // Verify: provided fields have the exact value, omitted fields are 0 or ''
                    expect(capturedMetadata).not.toBeNull();
                    expect(capturedMetadata.width).toBe(width ?? 0);
                    expect(capturedMetadata.height).toBe(height ?? 0);
                    expect(capturedMetadata.bitsPerComponent).toBe(bpc ?? 0);
                    expect(capturedMetadata.colorSpace).toBe(colorSpace ? stripSlash(colorSpace) : '');
                    expect(capturedMetadata.filter).toBe(filter ? stripSlash(filter) : '');
                }
            ),
            { numRuns: 100 }
        );
    });
});
