/**
 * decodeSamples with hand-built inputs: every supported bit depth and colour
 * family, /Decode handling, stencil masks, and the refusals.
 */

import { describe, it, expect } from 'vitest';
import { decodeSamples } from '../../../src/codecs/index.js';
import type { ColorSpaceInfo, EncodedImage, ImageInfo } from '../../../src/types.js';

const GRAY: ColorSpaceInfo = { family: 'DeviceGray', components: 1, raw: '/DeviceGray' };
const RGB: ColorSpaceInfo = { family: 'DeviceRGB', components: 3, raw: '/DeviceRGB' };
const CMYK: ColorSpaceInfo = { family: 'DeviceCMYK', components: 4, raw: '/DeviceCMYK' };

const NO_MASKS = { isStencilMask: false, softMaskInData: null, softMask: null, mask: null, softMaskOf: [], maskOf: [] };

function info(partial: Partial<ImageInfo>): ImageInfo {
    return {
        objId: 1,
        generation: 0,
        width: 1,
        height: 1,
        bitsPerComponent: 8,
        colorSpace: '/DeviceRGB',
        filter: null,
        streamLength: 0,
        colorSpaceInfo: RGB,
        filters: [],
        decode: null,
        masks: NO_MASKS,
        pages: [0],
        directPages: [0],
        ...partial,
    };
}

const samples = (bytes: number[]): EncodedImage => ({ data: Uint8Array.from(bytes), encoding: { kind: 'samples' } });

function pixels(result: ReturnType<typeof decodeSamples>): number[] {
    if (!result.ok) throw new Error(`${result.code}: ${result.error}`);
    return Array.from(result.value.data);
}

describe('decodeSamples', () => {
    it('8-bit RGB', () => {
        expect(pixels(decodeSamples(samples([255, 0, 0, 0, 255, 0]), info({ width: 2 })))).toEqual([
            255, 0, 0, 255, 0, 255, 0, 255,
        ]);
    });

    it('8-bit gray', () => {
        expect(pixels(decodeSamples(samples([0, 128]), info({ width: 2, colorSpaceInfo: GRAY })))).toEqual([
            0, 0, 0, 255, 128, 128, 128, 255,
        ]);
    });

    it('8-bit CMYK, naive conversion', () => {
        expect(pixels(decodeSamples(samples([0, 0, 0, 0, 0, 0, 0, 255]), info({ width: 2, colorSpaceInfo: CMYK })))).toEqual([
            255, 255, 255, 255, 0, 0, 0, 255,
        ]);
    });

    it('16-bit big-endian gray', () => {
        expect(pixels(decodeSamples(samples([0xff, 0xff, 0x80, 0x00]), info({ width: 2, bitsPerComponent: 16, colorSpaceInfo: GRAY })))).toEqual([
            255, 255, 255, 255, 128, 128, 128, 255,
        ]);
    });

    it('1-bit gray, rows padded to bytes', () => {
        // two rows of 3 pixels: 101xxxxx, 010xxxxx
        const result = decodeSamples(samples([0b10100000, 0b01000000]), info({ width: 3, height: 2, bitsPerComponent: 1, colorSpaceInfo: GRAY }));
        expect(pixels(result).filter((_, i) => i % 4 === 0)).toEqual([255, 0, 255, 0, 255, 0]);
    });

    it('4-bit gray with /Decode [1 0] inverts', () => {
        const result = decodeSamples(samples([0x0f]), info({ width: 2, bitsPerComponent: 4, colorSpaceInfo: GRAY, decode: [1, 0] }));
        expect(pixels(result).filter((_, i) => i % 4 === 0)).toEqual([255, 0]);
    });

    it('2-bit Indexed over RGB with a 4-entry lookup', () => {
        const indexed: ColorSpaceInfo = {
            family: 'Indexed',
            components: 1,
            base: RGB,
            hival: 3,
            lookup: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]),
            raw: '[ /Indexed /DeviceRGB 3 <...> ]',
        };
        // indices 0,1,2,3 in one byte: 00 01 10 11
        const result = decodeSamples(samples([0b00011011]), info({ width: 4, bitsPerComponent: 2, colorSpaceInfo: indexed }));
        expect(pixels(result)).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255]);
    });

    it('ICCBased is mapped by component count', () => {
        const icc: ColorSpaceInfo = { family: 'ICCBased', components: 3, iccProfile: { objId: 8, generation: 0 }, raw: '[ /ICCBased 8 0 R ]' };
        expect(pixels(decodeSamples(samples([10, 20, 30]), info({ colorSpaceInfo: icc })))).toEqual([10, 20, 30, 255]);
    });

    it('stencil mask: sample 0 paints, /Decode [1 0] inverts; RGB stays 0', () => {
        const stencil = info({ width: 8, height: 1, bitsPerComponent: 1, colorSpace: null, colorSpaceInfo: null, masks: { ...NO_MASKS, isStencilMask: true } });
        const alpha = (result: ReturnType<typeof decodeSamples>) => pixels(result).filter((_, i) => i % 4 === 3);
        expect(alpha(decodeSamples(samples([0b11110000]), stencil))).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
        expect(alpha(decodeSamples(samples([0b11110000]), { ...stencil, decode: [1, 0] }))).toEqual([255, 255, 255, 255, 0, 0, 0, 0]);
        expect(pixels(decodeSamples(samples([0]), stencil)).filter((_, i) => i % 4 !== 3).every((v) => v === 0)).toBe(true);
    });

    it.each([
        ['Separation', { family: 'Separation', components: 1, names: ['Spot'], alternate: CMYK, raw: '' } as ColorSpaceInfo],
        ['Lab', { family: 'Lab', components: 3, raw: '' } as ColorSpaceInfo],
        ['Unknown', { family: 'Unknown', components: null, raw: '' } as ColorSpaceInfo],
        ['ICCBased without /N', { family: 'ICCBased', components: null, iccProfile: null, raw: '' } as ColorSpaceInfo],
    ])('refuses %s with UNSUPPORTED_COLOR_SPACE instead of guessing', (_name, cs) => {
        expect(decodeSamples(samples([0, 0, 0, 0]), info({ colorSpaceInfo: cs }))).toMatchObject({ ok: false, code: 'UNSUPPORTED_COLOR_SPACE' });
    });

    it('refuses other encodings, missing colour space, odd bit depths and short data', () => {
        expect(decodeSamples({ data: new Uint8Array(1), encoding: { kind: 'jpeg' } }, info({}))).toMatchObject({ ok: false, code: 'UNSUPPORTED_ENCODING' });
        expect(decodeSamples(samples([0]), info({ colorSpaceInfo: null }))).toMatchObject({ ok: false, code: 'UNSUPPORTED_COLOR_SPACE' });
        expect(decodeSamples(samples([0]), info({ bitsPerComponent: 12 }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(decodeSamples(samples([0]), info({ bitsPerComponent: null }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(decodeSamples(samples([255, 0]), info({ width: 1 }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(decodeSamples(samples([]), info({ width: 0 }))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    });
});
