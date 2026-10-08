/**
 * Raw PDF image samples to RGBA (ISO 32000-1 §8.9.5, colour spaces §8.6).
 *
 * Pure: depends only on the EncodedImage bytes and the ImageInfo facts. No
 * colour management: device colour spaces are mapped to sRGB directly and
 * ICCBased spaces by component count. Anything that would need a guess
 * beyond that (tint transforms, Lab ranges) is refused with
 * UNSUPPORTED_COLOR_SPACE until the facts exist. Which images are decodable
 * is decided by `canDecode` (support.ts); this file only does the work.
 */

import type { EncodedImage, ImageInfo } from '../types.js';
import { codecFailure, codecGuarded, codecOk, type CodecResult } from './errors.js';
import { canDecode } from './support.js';

/** ImageData-compatible RGBA buffer (row-major, 4 bytes per pixel). */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

/** Reads sample `index` (0-based over the whole row) of `bits` bits from a row buffer. */
function readSample(row: Uint8Array, index: number, bits: number): number {
    switch (bits) {
        case 8:
            return row[index];
        case 16:
            return (row[index * 2] << 8) | row[index * 2 + 1];
        default: {
            // 1, 2, 4 bits: most significant bit first
            const bitPos = index * bits;
            const byte = row[bitPos >> 3];
            const shift = 8 - bits - (bitPos & 7);
            return (byte >> shift) & ((1 << bits) - 1);
        }
    }
}

/** Writes one device colour (components in 0..1) as RGB into `out` at `offset`. */
function writeDeviceColor(out: Uint8ClampedArray, offset: number, components: 1 | 3 | 4, c: number[]): void {
    if (components === 1) {
        const v = c[0] * 255;
        out[offset] = v;
        out[offset + 1] = v;
        out[offset + 2] = v;
    } else if (components === 3) {
        out[offset] = c[0] * 255;
        out[offset + 1] = c[1] * 255;
        out[offset + 2] = c[2] * 255;
    } else {
        // naive CMYK -> RGB (no colour management)
        const k = c[3];
        out[offset] = (1 - c[0]) * (1 - k) * 255;
        out[offset + 1] = (1 - c[1]) * (1 - k) * 255;
        out[offset + 2] = (1 - c[2]) * (1 - k) * 255;
    }
    out[offset + 3] = 255;
}

/**
 * Decode raw samples (`encoding.kind === 'samples'`) to RGBA.
 *
 * - Device*, ICCBased (by component count), Indexed over those; 1/2/4/8/16
 *   bits per component; `/Decode` arrays honoured.
 * - Stencil masks (`masks.isStencilMask`): RGB 0, alpha 255 where the
 *   sample paints (after `/Decode`), 0 elsewhere. The caller recolours.
 * - Refusals are exactly those of `canDecode(info)`, plus `INVALID_INPUT`
 *   when the data is shorter than the facts require.
 */
export function decodeSamples(image: EncodedImage, info: ImageInfo): CodecResult<RgbaImage> {
    return codecGuarded(() => {
        if (image.encoding.kind !== 'samples') {
            return codecFailure('UNSUPPORTED_ENCODING', `decodeSamples needs raw samples, got ${image.encoding.kind}`);
        }
        const support = canDecode({ ...info, encoding: image.encoding });
        if (!support.ok) return support;
        const { width, height } = info;
        if (info.masks.isStencilMask) return decodeStencil(image.data, info);

        const bits = info.bitsPerComponent as number;
        const cs = info.colorSpaceInfo!;
        const indexed = cs.family === 'Indexed' ? cs : null;
        const paintComponents = support.components as 1 | 3 | 4;
        const sampleComponents = indexed ? 1 : paintComponents;

        const stride = Math.ceil((width * sampleComponents * bits) / 8);
        if (image.data.byteLength < stride * height) {
            return codecFailure(
                'INVALID_INPUT',
                `sample data too short: ${image.data.byteLength} bytes, need ${stride * height}`
            );
        }

        const maxValue = (1 << bits) - 1;
        const decode = decodeRanges(info.decode, sampleComponents, indexed ? maxValue : 1);
        const out = new Uint8ClampedArray(width * height * 4);
        const color: number[] = new Array(paintComponents).fill(0);

        for (let y = 0; y < height; y++) {
            const row = image.data.subarray(y * stride, (y + 1) * stride);
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 4;
                if (indexed) {
                    const raw = readSample(row, x, bits);
                    const index = Math.round(decode[0] + (raw * (decode[1] - decode[0])) / maxValue);
                    const clamped = Math.max(0, Math.min(indexed.hival, index));
                    for (let c = 0; c < paintComponents; c++) {
                        color[c] = (indexed.lookup[clamped * paintComponents + c] ?? 0) / 255;
                    }
                } else {
                    for (let c = 0; c < paintComponents; c++) {
                        const raw = readSample(row, x * paintComponents + c, bits);
                        color[c] = decode[c * 2] + (raw * (decode[c * 2 + 1] - decode[c * 2])) / maxValue;
                    }
                }
                writeDeviceColor(out, offset, paintComponents, color);
            }
        }
        return codecOk({ width, height, data: out });
    });
}

/** /Decode ranges per component, or the defaults ([0 1] per component; [0 max] for Indexed). */
function decodeRanges(decode: number[] | null, components: number, defaultMax: number): number[] {
    if (decode && decode.length >= components * 2) return decode.slice(0, components * 2);
    const ranges: number[] = [];
    for (let c = 0; c < components; c++) ranges.push(0, defaultMax);
    return ranges;
}

/** Stencil mask: 1 bit per sample; sample 0 paints unless /Decode [1 0]. */
function decodeStencil(data: Uint8Array, info: ImageInfo): CodecResult<RgbaImage> {
    const { width, height } = info;
    const stride = Math.ceil(width / 8);
    if (data.byteLength < stride * height) {
        return codecFailure('INVALID_INPUT', `stencil data too short: ${data.byteLength} bytes, need ${stride * height}`);
    }
    const paintsOnOne = info.decode !== null && info.decode[0] === 1;
    const out = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        const row = data.subarray(y * stride, (y + 1) * stride);
        for (let x = 0; x < width; x++) {
            const bit = readSample(row, x, 1);
            const paints = paintsOnOne ? bit === 1 : bit === 0;
            out[(y * width + x) * 4 + 3] = paints ? 255 : 0;
        }
    }
    return codecOk({ width, height, data: out });
}
