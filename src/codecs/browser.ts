/**
 * Browser adapters: the only file of the codec module that touches Web APIs
 * (Blob, ImageData, createImageBitmap). Everything else runs in Node too.
 */

import type { EncodedImage, ImageInfo } from '../types.js';
import { codecFailure, codecGuardedAsync, codecOk, type CodecResult } from './errors.js';
import { decodeSamples, type RgbaImage } from './samples.js';

export interface ToImageBitmapOptions {
    /** Target width in pixels; the browser scales (aspect ratio is kept when only one is given). */
    resizeWidth?: number;
    resizeHeight?: number;
    resizeQuality?: 'pixelated' | 'low' | 'medium' | 'high';
}

/**
 * An ImageBitmap for an encoded image.
 *
 * - `jpeg`: the browser's native decoder (`createImageBitmap(Blob)`).
 * - `samples`: `decodeSamples` -> `ImageData` -> `createImageBitmap`.
 * - other kinds: `UNSUPPORTED_ENCODING` until their codec stage ships.
 *
 * Resizing happens inside `createImageBitmap`, before any full-size bitmap
 * is kept. Never throws; decoder failures are `DECODE_FAILED`.
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
        switch (image.encoding.kind) {
            case 'jpeg': {
                const blob = new Blob([image.data as BlobPart], { type: 'image/jpeg' });
                return codecOk(await createImageBitmap(blob, resizeOptions(options)));
            }
            case 'samples': {
                const decoded = decodeSamples(image, info);
                if (!decoded.ok) return decoded;
                return codecOk(await createImageBitmap(toImageData(decoded.value), resizeOptions(options)));
            }
            default:
                return codecFailure(
                    'UNSUPPORTED_ENCODING',
                    `no decoder for ${image.encoding.kind} in this version of the codec module`
                );
        }
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
