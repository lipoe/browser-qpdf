/**
 * Properties of decodeSamples:
 * 1. For every bit depth and device family, samples packed by a reference
 *    packer decode to the values they were packed from (round trip).
 * 2. The function never throws and always returns a well-formed CodecResult,
 *    for arbitrary inputs.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { CODEC_ERROR_CODES, decodeSamples } from '../../src/codecs/index.js';
import type { ColorSpaceInfo, EncodedImage, ImageInfo } from '../../src/types.js';

const FAMILIES: Record<1 | 3 | 4, ColorSpaceInfo> = {
    1: { family: 'DeviceGray', components: 1, raw: '/DeviceGray' },
    3: { family: 'DeviceRGB', components: 3, raw: '/DeviceRGB' },
    4: { family: 'DeviceCMYK', components: 4, raw: '/DeviceCMYK' },
};

const NO_MASKS = { isStencilMask: false, softMaskInData: null, softMask: null, mask: null, softMaskOf: [], maskOf: [] };

function imageInfo(width: number, height: number, bits: number, cs: ColorSpaceInfo): ImageInfo {
    return {
        objId: 1, generation: 0, width, height, bitsPerComponent: bits, colorSpace: cs.raw, filter: null,
        streamLength: 0, colorSpaceInfo: cs, filters: [], decode: null, encoding: { kind: 'samples' }, masks: NO_MASKS, pages: [0], directPages: [0],
    };
}

/** Reference packer: MSB-first bit packing, rows padded to byte boundaries, 16 bit big-endian. */
function pack(values: number[][], width: number, components: number, bits: number): Uint8Array {
    const stride = Math.ceil((width * components * bits) / 8);
    const out = new Uint8Array(stride * values.length);
    values.forEach((row, y) => {
        let bitPos = 0;
        for (const v of row) {
            if (bits === 16) {
                out[y * stride + (bitPos >> 3)] = v >> 8;
                out[y * stride + (bitPos >> 3) + 1] = v & 0xff;
            } else if (bits === 8) {
                out[y * stride + (bitPos >> 3)] = v;
            } else {
                const shift = 8 - bits - (bitPos & 7);
                out[y * stride + (bitPos >> 3)] |= v << shift;
            }
            bitPos += bits;
        }
    });
    return out;
}

describe('decodeSamples properties', () => {
    it('round-trips every bit depth and device family through the reference packer (gray and RGB exactly)', () => {
        fc.assert(
            fc.property(
                fc.constantFrom(1, 2, 4, 8, 16),
                fc.constantFrom(1, 3) as fc.Arbitrary<1 | 3>,
                fc.integer({ min: 1, max: 5 }),
                fc.integer({ min: 1, max: 3 }),
                fc.nat(),
                (bits, components, width, height, seed) => {
                    const max = (1 << bits) - 1;
                    const rows = Array.from({ length: height }, (_, y) =>
                        Array.from({ length: width * components }, (_, i) => (seed + y * 31 + i * 17) % (max + 1))
                    );
                    const image: EncodedImage = { data: pack(rows, width, components, bits), encoding: { kind: 'samples' } };
                    const result = decodeSamples(image, imageInfo(width, height, bits, FAMILIES[components]));
                    expect(result.ok).toBe(true);
                    if (!result.ok) return;
                    rows.forEach((row, y) => {
                        for (let x = 0; x < width; x++) {
                            const expected = Array.from({ length: 3 }, (_, c) =>
                                Math.round((row[x * components + (components === 1 ? 0 : c)] * 255) / max)
                            );
                            const offset = (y * width + x) * 4;
                            expect(Array.from(result.value.data.subarray(offset, offset + 4))).toEqual([...expected, 255]);
                        }
                    });
                }
            ),
            { numRuns: 200 }
        );
    });

    it('never throws and always returns a well-formed result for arbitrary inputs', () => {
        fc.assert(
            fc.property(
                fc.uint8Array({ maxLength: 64 }),
                fc.record({
                    width: fc.oneof(fc.integer({ min: -2, max: 10 }), fc.double()),
                    height: fc.oneof(fc.integer({ min: -2, max: 10 }), fc.double()),
                    bitsPerComponent: fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 32 })),
                    decode: fc.oneof(fc.constant(null), fc.array(fc.double({ min: -1, max: 2, noNaN: true }), { maxLength: 8 })),
                    stencil: fc.boolean(),
                    cs: fc.oneof(fc.constant(null), fc.constantFrom(...Object.values(FAMILIES)), fc.constant({ family: 'Unknown', components: null, raw: '' } as ColorSpaceInfo)),
                }),
                (data, p) => {
                    const info: ImageInfo = {
                        ...imageInfo(p.width as number, p.height as number, p.bitsPerComponent as number, FAMILIES[1]),
                        bitsPerComponent: p.bitsPerComponent,
                        decode: p.decode,
                        colorSpaceInfo: p.cs,
                        masks: { ...NO_MASKS, isStencilMask: p.stencil },
                    };
                    let result: ReturnType<typeof decodeSamples> | undefined;
                    expect(() => {
                        result = decodeSamples({ data, encoding: { kind: 'samples' } }, info);
                    }).not.toThrow();
                    expect(typeof result!.ok).toBe('boolean');
                    if (!result!.ok) {
                        expect(CODEC_ERROR_CODES).toContain(result!.code);
                        expect(result!.error.length).toBeGreaterThan(0);
                    } else {
                        expect(result!.value.data.length).toBe(result!.value.width * result!.value.height * 4);
                    }
                }
            ),
            { numRuns: 300 }
        );
    });
});
