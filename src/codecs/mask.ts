/**
 * Soft-mask compositing on decoded images. Pure.
 */

import { codecFailure, codecGuarded, codecOk, type CodecResult } from './errors.js';
import type { RgbaImage } from './samples.js';

/**
 * Apply a decoded soft mask to a decoded image: the mask's red channel
 * (gray decodes to R = G = B) becomes the image's alpha. The mask is
 * resampled to the image size with nearest-neighbour lookup. The mask's
 * `/Decode` was already applied by `decodeSamples`; nothing is re-applied.
 * Returns a new image; inputs are not modified.
 */
export function applySoftMask(image: RgbaImage, mask: RgbaImage): CodecResult<RgbaImage> {
    return codecGuarded(() => {
        for (const [name, img] of [
            ['image', image],
            ['mask', mask],
        ] as const) {
            if (!(img.width > 0 && img.height > 0) || img.data.length !== img.width * img.height * 4) {
                return codecFailure('INVALID_INPUT', `${name}: data length does not match ${img.width}x${img.height} RGBA`);
            }
        }
        const out = new Uint8ClampedArray(image.data);
        for (let y = 0; y < image.height; y++) {
            const my = Math.min(mask.height - 1, Math.floor((y * mask.height) / image.height));
            for (let x = 0; x < image.width; x++) {
                const mx = Math.min(mask.width - 1, Math.floor((x * mask.width) / image.width));
                out[(y * image.width + x) * 4 + 3] = mask.data[(my * mask.width + mx) * 4];
            }
        }
        return codecOk({ width: image.width, height: image.height, data: out });
    });
}
