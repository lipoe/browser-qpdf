/**
 * Property-based tests for image deduplication.
 *
 * **Validates: Requirements 11.7**
 *
 * The deduplication logic happens in the C++ WASM layer (using std::set<QPDFObjGen>).
 * The TypeScript wrapper passes through whatever the WASM returns.
 *
 * Properties tested:
 * 1. When WASM returns an array of images, the wrapper returns them faithfully as ImageInfo[].
 * 2. When WASM returns a deduplicated list (all unique objId+generation pairs),
 *    the result has no duplicates.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams } from '../../src/index.js';
import { mockWasm } from '../__mocks__/qpdf-image-stream.js';

// --- Generators ---

const objRef = fc.record({ objId: fc.integer({ min: 1, max: 100 }), generation: fc.integer({ min: 0, max: 5 }) });

const deviceColorSpace = fc.constantFrom(
    { family: 'DeviceGray', components: 1, raw: '/DeviceGray' },
    { family: 'DeviceRGB', components: 3, raw: '/DeviceRGB' },
    { family: 'DeviceCMYK', components: 4, raw: '/DeviceCMYK' }
);

/** Every variant of ColorSpaceInfo, one level deep. */
const colorSpaceInfo = fc.oneof(
    deviceColorSpace,
    fc.record({
        family: fc.constant('ICCBased'),
        components: fc.oneof(fc.constant(null), fc.constantFrom(1, 3, 4)),
        iccProfile: fc.oneof(fc.constant(null), objRef),
        raw: fc.constant('[ /ICCBased 8 0 R ]'),
    }),
    fc.record({
        family: fc.constant('Indexed'),
        components: fc.constant(1),
        base: deviceColorSpace,
        hival: fc.integer({ min: 0, max: 255 }),
        lookup: fc.uint8Array({ maxLength: 768 }),
        raw: fc.constant('[ /Indexed /DeviceRGB 3 <...> ]'),
    }),
    fc.record({
        family: fc.constantFrom('Separation', 'DeviceN'),
        components: fc.integer({ min: 1, max: 4 }),
        names: fc.array(fc.constantFrom('Spot', 'Cyan', 'Magenta'), { minLength: 1, maxLength: 4 }),
        alternate: fc.oneof(fc.constant(null), deviceColorSpace),
        raw: fc.constant('[ /Separation /Spot /DeviceCMYK 7 0 R ]'),
    }),
    fc.record({ family: fc.constant('Unknown'), components: fc.constant(null), raw: fc.string() })
);

const maskInfo = fc.record({
    isStencilMask: fc.boolean(),
    softMaskInData: fc.oneof(fc.constant(null), fc.constantFrom(0, 1, 2)),
    softMask: fc.oneof(fc.constant(null), objRef),
    mask: fc.oneof(
        fc.constant(null),
        fc.record({ kind: fc.constant('stencil'), ref: objRef }),
        fc.constant({ kind: 'colorKey' })
    ),
    softMaskOf: fc.array(objRef, { maxLength: 3 }),
    maskOf: fc.array(objRef, { maxLength: 3 }),
});

const sortedPages = fc.uniqueArray(fc.integer({ min: 0, max: 50 }), { maxLength: 5 }).map((p) => p.sort((a, b) => a - b));

/** A full 0.3.0 ImageInfo as the WASM layer produces it. */
const imageInfo = fc.record({
    objId: fc.integer({ min: 1, max: 100 }),
    generation: fc.integer({ min: 0, max: 5 }),
    width: fc.integer({ min: 1, max: 10000 }),
    height: fc.integer({ min: 1, max: 10000 }),
    bitsPerComponent: fc.oneof(fc.constant(null), fc.constantFrom(1, 2, 4, 8, 16)),
    colorSpace: fc.oneof(fc.constant(null), fc.constantFrom('/DeviceRGB', '/DeviceGray', '6 0 R')),
    filter: fc.oneof(fc.constant(null), fc.constantFrom('/DCTDecode', '/FlateDecode', '[ /FlateDecode /DCTDecode ]')),
    streamLength: fc.integer({ min: 0, max: 100000 }),
    colorSpaceInfo: fc.oneof(fc.constant(null), colorSpaceInfo),
    filters: fc.array(fc.constantFrom('FlateDecode', 'DCTDecode', 'JPXDecode', 'CCITTFaxDecode'), { maxLength: 2 }),
    decode: fc.oneof(fc.constant(null), fc.array(fc.constantFrom(0, 1), { minLength: 2, maxLength: 8 })),
    encoding: fc.oneof(
        fc.constant(null),
        fc.constant({ kind: 'samples' }),
        fc.constant({ kind: 'jpeg' }),
        fc.constant({ kind: 'jpeg2000' }),
        fc.record({ kind: fc.constant('jbig2'), globals: fc.oneof(fc.constant(null), objRef) })
    ),
    masks: maskInfo,
    pages: sortedPages,
    directPages: sortedPages,
});

const imageList = fc.array(imageInfo, { minLength: 0, maxLength: 20 });

/** Generator for deduplicated image lists (unique objId+generation pairs) */
const deduplicatedImageList = imageList.map((images) => {
    const seen = new Set<string>();
    return images.filter((img) => {
        const key = `${img.objId}:${img.generation}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
});

describe('Property 7: Image Deduplication', () => {
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

    it('wrapper returns exactly what WASM provides (faithful pass-through of ImageInfo[])', async () => {
        const qpdf = await createQpdfImageStreams();
        const loadResult = qpdf.loadPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;

        const doc = loadResult.value;

        fc.assert(
            fc.property(imageList, (generatedImages) => {
                // Configure mock to return the generated list
                mockWasm.getImages = () => generatedImages;

                const result = doc.getImages({ recursive: true });
                expect(result.ok).toBe(true);
                if (!result.ok) return;

                // The wrapper should return exactly what WASM provides
                expect(result.value).toEqual(generatedImages);
                expect(result.value.length).toBe(generatedImages.length);
            }),
            { numRuns: 100 },
        );

        doc.close();
    });

    it('when WASM returns a deduplicated list, result contains no duplicate objId+generation pairs', async () => {
        const qpdf = await createQpdfImageStreams();
        const loadResult = qpdf.loadPdf(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
        expect(loadResult.ok).toBe(true);
        if (!loadResult.ok) return;

        const doc = loadResult.value;

        fc.assert(
            fc.property(deduplicatedImageList, (uniqueImages) => {
                // Configure mock to return the deduplicated list (simulating WASM's std::set behavior)
                mockWasm.getImages = () => uniqueImages;

                const result = doc.getImages({ recursive: true });
                expect(result.ok).toBe(true);
                if (!result.ok) return;

                // Verify no duplicates in the result
                const seen = new Set<string>();
                for (const img of result.value) {
                    const key = `${img.objId}:${img.generation}`;
                    expect(seen.has(key)).toBe(false);
                    seen.add(key);
                }

                // All unique images are present
                expect(result.value.length).toBe(uniqueImages.length);
            }),
            { numRuns: 100 },
        );

        doc.close();
    });
});
