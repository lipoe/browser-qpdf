/**
 * Property-based tests for stream replacement metadata update.
 *
 * Property 3: Stream Replacement Updates Metadata Correctly
 * - For any valid metadata and data, `replaceImageStream` succeeds
 * - Metadata values are passed through correctly (positive integers, non-empty strings)
 *
 * **Validates: Requirements 11.3**
 *
 * @module pbt/stream-replace
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { mockWasm } from '../__mocks__/qpdf-image-stream.js';
import { createQpdfImageStreams } from '../../src/index.js';

// --- Generators ---
const validWidth = fc.integer({ min: 1, max: 10000 });
const validHeight = fc.integer({ min: 1, max: 10000 });
const validBpc = fc.constantFrom(1, 2, 4, 8, 16);
const validColorSpace = fc.constantFrom('/DeviceRGB', '/DeviceGray', '/DeviceCMYK');
const validFilter = fc.constantFrom('/DCTDecode', '/FlateDecode', '/CCITTFaxDecode');
const validData = fc.uint8Array({ minLength: 1, maxLength: 1000 });
const validObjId = fc.integer({ min: 1, max: 10000 });
const validGeneration = fc.integer({ min: 0, max: 100 });


/** The wrapper strips a leading slash; the C++ side adds the PDF name prefix. */
const stripSlash = (v: string) => (v.startsWith('/') ? v.slice(1) : v);

describe('Feature: qpdf-wasm-image-streams, Property 3: Stream Replacement Updates Metadata Correctly', () => {
    beforeEach(() => {
        // Reset all mock functions
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

    it('for any positive width, positive height, positive bitsPerComponent, non-empty colorSpace, and non-empty filter, replaceImageStream returns { ok: true }', async () => {
        // Configure mock to accept all replacements
        mockWasm.replaceImageStream = (_objId: number, _gen: number, _data: Uint8Array, _metadata: any) => {
            return { success: true };
        };

        const qpdf = await createQpdfImageStreams();

        await fc.assert(
            fc.asyncProperty(
                validObjId,
                validGeneration,
                validData,
                validWidth,
                validHeight,
                validBpc,
                validColorSpace,
                validFilter,
                async (objId, generation, data, width, height, bpc, colorSpace, filter) => {
                    const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
                    expect(doc.ok).toBe(true);
                    if (!doc.ok) return;

                    const result = doc.value.replaceImageStream(objId, generation, data, {
                        width,
                        height,
                        bitsPerComponent: bpc,
                        colorSpace,
                        filter,
                    });

                    expect(result.ok).toBe(true);

                    doc.value.close();
                }
            ),
            { numRuns: 100 }
        );
    });

    it('metadata values passed to WASM match what was provided', async () => {
        // Configure mock to capture args
        let capturedMetadata: any = null;
        let capturedObjId: number | null = null;
        let capturedGen: number | null = null;
        let capturedData: Uint8Array | null = null;

        mockWasm.replaceImageStream = (objId: number, gen: number, data: Uint8Array, metadata: any) => {
            capturedObjId = objId;
            capturedGen = gen;
            capturedData = data;
            capturedMetadata = metadata;
            return { success: true };
        };

        const qpdf = await createQpdfImageStreams();

        await fc.assert(
            fc.asyncProperty(
                validObjId,
                validGeneration,
                validData,
                validWidth,
                validHeight,
                validBpc,
                validColorSpace,
                validFilter,
                async (objId, generation, data, width, height, bpc, colorSpace, filter) => {
                    // Reset captures
                    capturedMetadata = null;
                    capturedObjId = null;
                    capturedGen = null;
                    capturedData = null;

                    const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
                    expect(doc.ok).toBe(true);
                    if (!doc.ok) return;

                    doc.value.replaceImageStream(objId, generation, data, {
                        width,
                        height,
                        bitsPerComponent: bpc,
                        colorSpace,
                        filter,
                    });

                    // Verify metadata was passed through correctly
                    expect(capturedObjId).toBe(objId);
                    expect(capturedGen).toBe(generation);
                    expect(capturedData).toBe(data);
                    expect(capturedMetadata).not.toBeNull();
                    expect(capturedMetadata.width).toBe(width);
                    expect(capturedMetadata.height).toBe(height);
                    expect(capturedMetadata.bitsPerComponent).toBe(bpc);
                    expect(capturedMetadata.colorSpace).toBe(stripSlash(colorSpace));
                    expect(capturedMetadata.filter).toBe(stripSlash(filter));

                    doc.value.close();
                }
            ),
            { numRuns: 100 }
        );
    });
});
