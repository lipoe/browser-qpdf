/**
 * Unit tests for stream replacement, PDF writing, and lifecycle management.
 *
 * These tests use the project's mock WASM module (resolved via vitest alias in
 * vitest.config.ts) to verify the TypeScript wrapper's logic for input validation,
 * Result type translation, memory view copying, and lifecycle guards.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.5, 7.1, 7.2, 7.3, 7.4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createQpdfImageStreams } from '../../src/index.js';
import { mockWasm } from '../__mocks__/qpdf-image-stream.js';

describe('Stream Replacement', () => {
    beforeEach(() => {
        // Reset all mock functions to defaults
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

    describe('replaceImageStream with full metadata', () => {
        it('should succeed when full metadata is provided', async () => {
            mockWasm.replaceImageStream = () => ({ success: true });

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([10, 20, 30, 40]);
            const metadata = {
                width: 100,
                height: 200,
                bitsPerComponent: 8,
                colorSpace: '/DeviceRGB',
                filter: '/DCTDecode',
            };

            const result = doc.value.replaceImageStream(5, 0, newData, metadata);
            expect(result.ok).toBe(true);
        });

        it('should succeed when no metadata is provided', async () => {
            mockWasm.replaceImageStream = () => ({ success: true });

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([10, 20, 30]);
            const result = doc.value.replaceImageStream(3, 0, newData);
            expect(result.ok).toBe(true);
        });

        it('should succeed when partial metadata is provided', async () => {
            mockWasm.replaceImageStream = () => ({ success: true });

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([99]);
            const metadata = { width: 50, colorSpace: '/DeviceGray' };

            const result = doc.value.replaceImageStream(7, 1, newData, metadata);
            expect(result.ok).toBe(true);
        });
    });

    describe('replaceImageStream argument verification', () => {
        it('should pass correct full metadata arguments to WASM', async () => {
            let captured: any = null;
            mockWasm.replaceImageStream = (objId: number, gen: number, data: Uint8Array, metadata: any) => {
                captured = { objId, gen, data, metadata };
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([10, 20, 30, 40]);
            doc.value.replaceImageStream(5, 0, newData, {
                width: 100,
                height: 200,
                bitsPerComponent: 8,
                colorSpace: '/DeviceRGB',
                filter: '/DCTDecode',
            });

            expect(captured).not.toBeNull();
            expect(captured.objId).toBe(5);
            expect(captured.gen).toBe(0);
            expect(captured.data).toBe(newData);
            // Leading slashes are stripped; the C++ wrapper adds the PDF name prefix
            expect(captured.metadata).toEqual({
                width: 100,
                height: 200,
                bitsPerComponent: 8,
                colorSpace: 'DeviceRGB',
                filter: 'DCTDecode',
            });
        });

        it('should pass zeros and empty strings for omitted metadata fields', async () => {
            let captured: any = null;
            mockWasm.replaceImageStream = (objId: number, gen: number, data: Uint8Array, metadata: any) => {
                captured = { objId, gen, data, metadata };
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([10, 20, 30]);
            doc.value.replaceImageStream(3, 0, newData);

            expect(captured).not.toBeNull();
            expect(captured.metadata).toEqual({
                width: 0,
                height: 0,
                bitsPerComponent: 0,
                colorSpace: '',
                filter: '',
            });
        });

        it('should pass zeros for unspecified integer fields and empty for unspecified strings in partial metadata', async () => {
            let captured: any = null;
            mockWasm.replaceImageStream = (objId: number, gen: number, data: Uint8Array, metadata: any) => {
                captured = { objId, gen, data, metadata };
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const newData = new Uint8Array([99]);
            doc.value.replaceImageStream(7, 1, newData, {
                width: 50,
                colorSpace: '/DeviceGray',
            });

            expect(captured).not.toBeNull();
            expect(captured.metadata).toEqual({
                width: 50,
                height: 0,
                bitsPerComponent: 0,
                colorSpace: 'DeviceGray',
                filter: '',
            });
        });
    });

    describe('replaceImageStream input validation', () => {
        it('should return error for negative width without calling WASM', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, new Uint8Array([1]), { width: -1 }
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('width');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for negative height without calling WASM', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, new Uint8Array([1]), { height: -10 }
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('height');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for negative bitsPerComponent without calling WASM', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, new Uint8Array([1]), { bitsPerComponent: -2 }
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('bitsPerComponent');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for non-Uint8Array data', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, 'not a uint8array' as unknown as Uint8Array, { width: 10 }
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('Uint8Array');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for invalid (negative) objId', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                -1, 0, new Uint8Array([1, 2, 3])
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('object ID');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for invalid (negative) generation number', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, -1, new Uint8Array([1, 2, 3])
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('generation');
            }
            expect(wasCalled).toBe(false);
        });

        it('should return error for non-integer objId', async () => {
            let wasCalled = false;
            mockWasm.replaceImageStream = () => {
                wasCalled = true;
                return { success: true };
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                3.5, 0, new Uint8Array([1, 2, 3])
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('object ID');
            }
            expect(wasCalled).toBe(false);
        });
    });

    describe('replaceImageStream WASM error propagation', () => {
        it('should propagate WASM error when replacement fails', async () => {
            mockWasm.replaceImageStream = () => ({
                success: false,
                error: 'Object is not a stream',
            });

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, new Uint8Array([1, 2, 3]), { width: 10, height: 10 }
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('Object is not a stream');
            }
        });

        it('should handle WASM exception gracefully', async () => {
            mockWasm.replaceImageStream = () => {
                throw new Error('WASM internal error');
            };

            const qpdf = await createQpdfImageStreams();
            const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
            expect(doc.ok).toBe(true);
            if (!doc.ok) return;

            const result = doc.value.replaceImageStream(
                5, 0, new Uint8Array([1, 2, 3])
            );

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toBe('WASM internal error');
            }
        });
    });
});

describe('PDF Writing', () => {
    beforeEach(() => {
        mockWasm.loadPdf = null;
        mockWasm.loadPdfWithPassword = null;
        mockWasm.getImages = null;
        mockWasm.getImageStreamData = null;
        mockWasm.getRawImageStreamData = null;
        mockWasm.replaceImageStream = null;
        mockWasm.writePdf = () => new Uint8Array([37, 80, 68, 70, 45]);
        mockWasm.close = null;
        mockWasm.getPageCount = null;
    });

    it('should return a Uint8Array on successful write', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        const result = doc.value.writePdf();

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toBeInstanceOf(Uint8Array);
            expect(result.value.length).toBeGreaterThan(0);
        }
    });

    it('should copy typed_memory_view data into a new Uint8Array', async () => {
        const wasmView = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]);
        mockWasm.writePdf = () => wasmView;

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        const result = doc.value.writePdf();

        expect(result.ok).toBe(true);
        if (result.ok) {
            // Should be a copy, not the same reference
            expect(result.value).not.toBe(wasmView);
            // But should contain the same data
            expect(result.value).toEqual(wasmView);
        }
    });

    it('should propagate WASM error when write fails', async () => {
        mockWasm.writePdf = () => ({
            success: false,
            error: 'Serialization failed',
        });

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        const result = doc.value.writePdf();

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe('Serialization failed');
        }
    });

    it('should handle WASM exception during write gracefully', async () => {
        mockWasm.writePdf = () => {
            throw new Error('Out of memory');
        };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        const result = doc.value.writePdf();

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toBe('Out of memory');
        }
    });

    it('should write without modifications (round-trip)', async () => {
        let writeCallCount = 0;
        mockWasm.writePdf = () => {
            writeCallCount++;
            return new Uint8Array([37, 80, 68, 70, 45]);
        };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        const result = doc.value.writePdf();

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).toBeInstanceOf(Uint8Array);
            expect(result.value.length).toBeGreaterThan(0);
        }
        expect(writeCallCount).toBe(1);
    });

    it('should write after replacement produces valid output', async () => {
        mockWasm.replaceImageStream = () => ({ success: true });
        mockWasm.writePdf = () => new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]);

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        // Replace a stream
        const replaceResult = doc.value.replaceImageStream(
            5, 0, new Uint8Array([10, 20, 30]),
            { width: 1, height: 1, bitsPerComponent: 8, colorSpace: '/DeviceRGB', filter: '' }
        );
        expect(replaceResult.ok).toBe(true);

        // Write the modified PDF
        const writeResult = doc.value.writePdf();

        expect(writeResult.ok).toBe(true);
        if (writeResult.ok) {
            expect(writeResult.value).toBeInstanceOf(Uint8Array);
        }
    });
});

describe('Lifecycle Management', () => {
    beforeEach(() => {
        mockWasm.loadPdf = null;
        mockWasm.loadPdfWithPassword = null;
        mockWasm.getImages = null;
        mockWasm.getImageStreamData = null;
        mockWasm.getRawImageStreamData = null;
        mockWasm.replaceImageStream = null;
        mockWasm.writePdf = () => new Uint8Array([37, 80, 68, 70]);
        mockWasm.close = null;
        mockWasm.getPageCount = null;
    });

    it('should call WASM close() without error', async () => {
        let closeCallCount = 0;
        mockWasm.close = () => { closeCallCount++; };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        expect(() => doc.value.close()).not.toThrow();
        expect(closeCallCount).toBe(1);
    });

    it('should return disposed error from getImages() after close()', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        const result = doc.value.getImages();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('disposed');
        }
    });

    it('should return disposed error from getImageStreamData() after close()', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        const result = doc.value.getImageStreamData(5, 0);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('disposed');
        }
    });

    it('should return disposed error from getRawImageStreamData() after close()', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        const result = doc.value.getRawImageStreamData(5, 0);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('disposed');
        }
    });

    it('should return disposed error from replaceImageStream() after close()', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        const result = doc.value.replaceImageStream(
            5, 0, new Uint8Array([1, 2, 3])
        );
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('disposed');
        }
    });

    it('should return disposed error from writePdf() after close()', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        const result = doc.value.writePdf();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('disposed');
        }
    });

    it('should treat double close() as a no-op without error', async () => {
        let closeCallCount = 0;
        mockWasm.close = () => { closeCallCount++; };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        // First close
        expect(() => doc.value.close()).not.toThrow();
        // Second close - should be a no-op
        expect(() => doc.value.close()).not.toThrow();

        // WASM close() should only be called once (the second is a no-op at TS level)
        expect(closeCallCount).toBe(1);
    });

    it('should not call WASM methods after close()', async () => {
        let getImagesCalled = false;
        let getImageStreamDataCalled = false;
        let getRawImageStreamDataCalled = false;
        let replaceImageStreamCalled = false;
        let writePdfCalled = false;

        mockWasm.getImages = () => { getImagesCalled = true; return []; };
        mockWasm.getImageStreamData = () => { getImageStreamDataCalled = true; return new Uint8Array(0); };
        mockWasm.getRawImageStreamData = () => { getRawImageStreamDataCalled = true; return new Uint8Array(0); };
        mockWasm.replaceImageStream = () => { replaceImageStreamCalled = true; return { success: true }; };
        mockWasm.writePdf = () => { writePdfCalled = true; return new Uint8Array(0); };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        doc.value.close();

        // Attempt all operations - none should reach WASM
        doc.value.getImages();
        doc.value.getImageStreamData(1, 0);
        doc.value.getRawImageStreamData(1, 0);
        doc.value.replaceImageStream(1, 0, new Uint8Array([1]));
        doc.value.writePdf();

        // Verify WASM methods were not called after close
        expect(getImagesCalled).toBe(false);
        expect(getImageStreamDataCalled).toBe(false);
        expect(getRawImageStreamDataCalled).toBe(false);
        expect(replaceImageStreamCalled).toBe(false);
        expect(writePdfCalled).toBe(false);
    });
});

describe('Integration-style: Load, Replace, Write workflow', () => {
    beforeEach(() => {
        mockWasm.loadPdf = null;
        mockWasm.loadPdfWithPassword = null;
        mockWasm.getImages = () => [
            {
                objId: 5,
                generation: 0,
                width: 100,
                height: 100,
                bitsPerComponent: 8,
                colorSpace: '/DeviceRGB',
                filter: null,
                streamLength: 30000,
            },
        ];
        mockWasm.getImageStreamData = () => new Uint8Array(30000);
        mockWasm.getRawImageStreamData = () => new Uint8Array(30000);
        mockWasm.replaceImageStream = () => ({ success: true });
        mockWasm.writePdf = () => new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]);
        mockWasm.close = null;
        mockWasm.getPageCount = null;
    });

    it('should complete load → replace → write workflow', async () => {
        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        // Enumerate images
        const images = doc.value.getImages();
        expect(images.ok).toBe(true);

        // Replace image stream
        const newData = new Uint8Array(30000).fill(128);
        const replaceResult = doc.value.replaceImageStream(5, 0, newData, {
            width: 100,
            height: 100,
            bitsPerComponent: 8,
            colorSpace: '/DeviceRGB',
            filter: '',
        });
        expect(replaceResult.ok).toBe(true);

        // Write modified PDF
        const writeResult = doc.value.writePdf();
        expect(writeResult.ok).toBe(true);
        if (writeResult.ok) {
            expect(writeResult.value).toBeInstanceOf(Uint8Array);
            expect(writeResult.value.length).toBeGreaterThan(0);
        }

        // Cleanup
        doc.value.close();
    });

    it('should complete load → write without changes (round-trip)', async () => {
        let replaceWasCalled = false;
        mockWasm.replaceImageStream = () => {
            replaceWasCalled = true;
            return { success: true };
        };

        const qpdf = await createQpdfImageStreams();
        const doc = qpdf.loadPdf(new Uint8Array([37, 80, 68, 70]));
        expect(doc.ok).toBe(true);
        if (!doc.ok) return;

        // Write immediately without modifications
        const writeResult = doc.value.writePdf();
        expect(writeResult.ok).toBe(true);
        if (writeResult.ok) {
            expect(writeResult.value).toBeInstanceOf(Uint8Array);
            expect(writeResult.value.length).toBeGreaterThan(0);
        }

        // No replace calls should have been made
        expect(replaceWasCalled).toBe(false);

        // Cleanup
        doc.value.close();
    });
});
