/**
 * canDecode: the capability rule, decided from facts only, and its agreement
 * with decodeSamples.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { canDecode, decodeSamples } from '../../../src/codecs/index.js';
import type { ColorSpaceInfo, ImageInfo } from '../../../src/types.js';

const RGB: ColorSpaceInfo = { family: 'DeviceRGB', components: 3, raw: '/DeviceRGB' };
const NO_MASKS = { isStencilMask: false, softMaskInData: null, softMask: null, mask: null, softMaskOf: [], maskOf: [] };

function info(partial: Partial<ImageInfo>): ImageInfo {
    return {
        objId: 1, generation: 0, width: 2, height: 2, bitsPerComponent: 8, colorSpace: '/DeviceRGB', filter: null,
        streamLength: 0, colorSpaceInfo: RGB, filters: [], decode: null, encoding: { kind: 'samples' },
        masks: NO_MASKS, pages: [0], directPages: [0], ...partial,
    };
}

describe('canDecode', () => {
    it('names the route for samples and jpeg, from facts only', () => {
        expect(canDecode(info({}))).toEqual({ ok: true, route: 'samples', components: 3 });
        expect(canDecode(info({ encoding: { kind: 'jpeg' }, filters: ['DCTDecode'] }))).toEqual({ ok: true, route: 'jpeg', components: null });
        expect(canDecode(info({ colorSpaceInfo: null, bitsPerComponent: 1, masks: { ...NO_MASKS, isStencilMask: true } }))).toEqual({
            ok: true, route: 'samples', components: null,
        });
    });

    it.each([
        ['jpeg2000', info({ encoding: { kind: 'jpeg2000' } }), 'UNSUPPORTED_ENCODING'],
        ['ccitt', info({ encoding: { kind: 'ccitt', k: 0, columns: 1728, rows: 0, blackIs1: false, byteAlign: false, endOfLine: false, endOfBlock: true } }), 'UNSUPPORTED_ENCODING'],
        ['undescribable chain', info({ encoding: null }), 'UNSUPPORTED_ENCODING'],
        ['Separation', info({ colorSpaceInfo: { family: 'Separation', components: 1, names: ['Spot'], alternate: RGB, raw: '' } }), 'UNSUPPORTED_COLOR_SPACE'],
        ['no colour space', info({ colorSpaceInfo: null }), 'UNSUPPORTED_COLOR_SPACE'],
        ['12 bpc', info({ bitsPerComponent: 12 }), 'INVALID_INPUT'],
        ['zero width', info({ width: 0 }), 'INVALID_INPUT'],
    ])('refuses %s with the code the decoders would return', (_name, image, code) => {
        expect(canDecode(image)).toMatchObject({ ok: false, code });
    });

    it('agrees with decodeSamples whenever enough data is supplied (property)', () => {
        const colorSpace = fc.oneof(
            fc.constant(null),
            fc.constant(RGB),
            fc.constant({ family: 'DeviceGray', components: 1, raw: '/DeviceGray' } as ColorSpaceInfo),
            fc.constant({ family: 'ICCBased', components: 4, iccProfile: null, raw: '' } as ColorSpaceInfo),
            fc.constant({ family: 'ICCBased', components: null, iccProfile: null, raw: '' } as ColorSpaceInfo),
            fc.constant({ family: 'Lab', components: 3, raw: '' } as ColorSpaceInfo),
            fc.constant({ family: 'Unknown', components: null, raw: '' } as ColorSpaceInfo)
        );
        fc.assert(
            fc.property(
                fc.record({
                    width: fc.integer({ min: 0, max: 4 }),
                    height: fc.integer({ min: 0, max: 4 }),
                    bitsPerComponent: fc.oneof(fc.constant(null), fc.constantFrom(1, 2, 4, 8, 12, 16)),
                    stencil: fc.boolean(),
                    cs: colorSpace,
                }),
                (p) => {
                    const image = info({
                        width: p.width, height: p.height, bitsPerComponent: p.bitsPerComponent, colorSpaceInfo: p.cs,
                        masks: { ...NO_MASKS, isStencilMask: p.stencil },
                    });
                    const support = canDecode(image);
                    // generous data: 16 bits x 4 components per pixel is always enough
                    const data = new Uint8Array(Math.max(1, p.width * p.height * 8));
                    const decoded = decodeSamples({ data, encoding: { kind: 'samples' } }, image);
                    expect(decoded.ok).toBe(support.ok);
                    if (!support.ok && !decoded.ok) expect(decoded.code).toBe(support.code);
                }
            ),
            { numRuns: 300 }
        );
    });
});
