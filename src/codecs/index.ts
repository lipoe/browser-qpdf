/**
 * @module @lipoe/browser-qpdf/codecs
 *
 * Turns the encoded images of the core (`readImage`) and their facts
 * (`getImages`) into pixels. Structurally separate from the core: it imports
 * only types from it, never the WASM module, and the core never imports it.
 * Stage A: raw samples (Device*, ICCBased by component count, Indexed,
 * stencil masks, 1 to 16 bits per component) and JPEG via the browser.
 *
 * Usage:
 * ```typescript
 * import { toImageBitmap } from '@lipoe/browser-qpdf/codecs';
 *
 * const read = doc.readImage(info.objId, info.generation);
 * if (read.ok) {
 *     const bitmap = await toImageBitmap(read.value, info, { resizeWidth: 300 });
 *     // bitmap.ok ? bitmap.value : bitmap.code
 * }
 * ```
 */

export { decodeSamples, type RgbaImage } from './samples.js';
export { applySoftMask } from './mask.js';
export { toImageBitmap, toImageData, type ToImageBitmapOptions } from './browser.js';
export { CODEC_ERROR_CODES, type CodecErrorCode, type CodecResult } from './errors.js';
