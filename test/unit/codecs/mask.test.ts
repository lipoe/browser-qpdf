import { describe, it, expect } from 'vitest';
import { applySoftMask, type RgbaImage } from '../../../src/codecs/index.js';

const rgba = (width: number, height: number, bytes: number[]): RgbaImage => ({
    width,
    height,
    data: Uint8ClampedArray.from(bytes),
});

describe('applySoftMask', () => {
    it('takes the mask red channel as alpha, same size', () => {
        const image = rgba(2, 1, [10, 20, 30, 255, 40, 50, 60, 255]);
        const mask = rgba(2, 1, [255, 255, 255, 255, 64, 64, 64, 255]);
        const result = applySoftMask(image, mask);
        expect(result.ok && Array.from(result.value.data)).toEqual([10, 20, 30, 255, 40, 50, 60, 64]);
        expect(Array.from(image.data)[7]).toBe(255); // input untouched
    });

    it('resamples a smaller mask with nearest-neighbour lookup', () => {
        const image = rgba(4, 1, new Array(16).fill(0));
        const mask = rgba(2, 1, [0, 0, 0, 255, 255, 255, 255, 255]);
        const result = applySoftMask(image, mask);
        expect(result.ok && Array.from(result.value.data).filter((_, i) => i % 4 === 3)).toEqual([0, 0, 255, 255]);
    });

    it('rejects inconsistent buffers', () => {
        expect(applySoftMask(rgba(2, 1, [0, 0, 0, 0]), rgba(1, 1, [0, 0, 0, 0]))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(applySoftMask(rgba(1, 1, [0, 0, 0, 0]), rgba(0, 0, []))).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    });
});
