/**
 * Browser adapters: the only file of the codec module that touches Web APIs
 * (Blob, ImageData, OffscreenCanvas, createImageBitmap). Everything else
 * runs in Node too.
 */

import type { EncodedImage, ImageInfo } from '../types.js';
import { codecFailure, codecGuardedAsync, codecOk, type CodecResult } from './errors.js';
import { applySoftMask } from './mask.js';
import { decodeSamples, type RgbaImage } from './samples.js';
import { canDecode } from './support.js';

export interface ToImageBitmapOptions {
    /** Target width in pixels; the browser scales (aspect ratio is kept when only one is given). */
    resizeWidth?: number;
    resizeHeight?: number;
    resizeQuality?: 'pixelated' | 'low' | 'medium' | 'high';
    /**
     * The image's soft mask (`info.masks.softMask`): its bytes from
     * `readImage` and its catalog `ImageInfo`. Composited at full resolution
     * before any resize; the mask is resampled to the image size and its
     * `/Decode` is honoured. A mask that cannot be decoded fails the call.
     */
    softMask?: { image: EncodedImage; info: ImageInfo };
}

/**
 * The image as RGBA at full size, by the route `canDecode(info)` names:
 *
 * - `'samples'`: `decodeSamples` (no Web API involved).
 * - `'jpeg'`: the browser's decoder (`createImageBitmap(Blob)`), drawn on
 *   an `OffscreenCanvas` and read back. The RGB values are "as this browser
 *   decodes the JPEG"; colour management and chroma upsampling differ
 *   between browsers.
 * - anything `canDecode` refuses is refused here with the same code.
 *
 * The result is opaque (stencil masks excepted); it is the building block
 * for compositing (`applySoftMask`) or pixel inspection. Never throws.
 */
export function toRgbaImage(image: EncodedImage, info: ImageInfo): Promise<CodecResult<RgbaImage>> {
    return codecGuardedAsync(async () => {
        const support = canDecode({ ...info, encoding: image.encoding });
        if (!support.ok) return support;
        if (support.route === 'samples') return decodeSamples(image, info);
        if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
            return codecFailure('UNSUPPORTED_ENCODING', 'JPEG decoding needs createImageBitmap and OffscreenCanvas');
        }
        const bitmap = await createImageBitmap(new Blob([image.data as BlobPart], { type: 'image/jpeg' }));
        try {
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            const ctx = canvas.getContext('2d');
            if (!ctx) return codecFailure('DECODE_FAILED', 'OffscreenCanvas 2d context unavailable');
            ctx.drawImage(bitmap, 0, 0);
            const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
            return codecOk({ width: pixels.width, height: pixels.height, data: pixels.data });
        } finally {
            bitmap.close();
        }
    });
}

/**
 * An ImageBitmap for an encoded image.
 *
 * Without `softMask`: `'jpeg'` goes straight through the browser's decoder
 * with the resize applied by `createImageBitmap`; `'samples'` through
 * `decodeSamples` -> `ImageData` -> `createImageBitmap`. The bitmap is
 * opaque (stencil masks excepted).
 *
 * With `softMask`: `toRgbaImage(image)` and `decodeSamples(mask)` are
 * composited with `applySoftMask` at full resolution, then resized. The
 * image is held once at full size as RGBA for that step. Stencil `/Mask`,
 * colour-key masks and `/Matte` are not composited; use `toRgbaImage` and
 * the pure functions for anything beyond this.
 *
 * Refusals are those of `canDecode`; decoder failures are `DECODE_FAILED`.
 * Never throws.
 */
export function toImageBitmap(
    image: EncodedImage,
    info: ImageInfo,
    options: ToImageBitmapOptions = {}
): Promise<CodecResult<ImageBitmap>> {
    return codecGuardedAsync(async () => {
        if (typeof createImageBitmap !== 'function') {
            return codecFailure('UNSUPPORTED_ENCODING', 'createImageBitmap is not available in this environment');
        }
        const support = canDecode({ ...info, encoding: image.encoding });
        if (!support.ok) return support;

        if (options.softMask) {
            const picture = await toRgbaImage(image, info);
            if (!picture.ok) return picture;
            const mask = decodeSamples(options.softMask.image, options.softMask.info);
            if (!mask.ok) return mask;
            const composited = applySoftMask(picture.value, mask.value);
            if (!composited.ok) return composited;
            return codecOk(await createImageBitmap(toImageData(composited.value), resizeOptions(options)));
        }

        if (support.route === 'jpeg') {
            const blob = new Blob([image.data as BlobPart], { type: 'image/jpeg' });
            return codecOk(await createImageBitmap(blob, resizeOptions(options)));
        }
        const decoded = decodeSamples(image, info);
        if (!decoded.ok) return decoded;
        return codecOk(await createImageBitmap(toImageData(decoded.value), resizeOptions(options)));
    });
}

/** `ImageData` over a decoded image (shares the buffer). */
export function toImageData(image: RgbaImage): ImageData {
    return new ImageData(image.data as ImageDataArray, image.width, image.height);
}

function resizeOptions(options: ToImageBitmapOptions): ImageBitmapOptions {
    const result: ImageBitmapOptions = {};
    if (options.resizeWidth !== undefined) result.resizeWidth = options.resizeWidth;
    if (options.resizeHeight !== undefined) result.resizeHeight = options.resizeHeight;
    if (options.resizeQuality !== undefined) result.resizeQuality = options.resizeQuality;
    return result;
}
