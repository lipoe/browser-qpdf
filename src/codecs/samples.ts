/**
 * Raw PDF image samples to RGBA (ISO 32000-1 §8.9.5, colour spaces §8.6).
 *
 * Pure: depends only on the EncodedImage bytes and the ImageInfo facts. No
 * colour management: device colour spaces are mapped to sRGB directly and
 * ICCBased spaces by component count. Anything that would need a guess
 * beyond that (tint transforms, Lab ranges) is refused with
 * UNSUPPORTED_COLOR_SPACE until the facts exist.
 */

import type { ColorSpaceInfo, EncodedImage, ImageInfo } from '../types.js';
import { codecFailure, codecGuarded, codecOk, type CodecResult } from './errors.js';

/** ImageData-compatible RGBA buffer (row-major, 4 bytes per pixel). */
export interface RgbaImage {
    width: number;
    height: number;
    data: Uint8ClampedArray;
}

const SUPPORTED_BITS = new Set([1, 2, 4, 8, 16]);

/**
 * Component count of a colour space this stage can map to RGB, or null.
 * Device spaces by definition; ICCBased by its declared component count
 * (1, 3 or 4 treated as Gray, RGB, CMYK); Indexed through its base.
 */
function deviceComponents(cs: ColorSpaceInfo): 1 | 3 | 4 | null {
    switch (cs.family) {
        case 'DeviceGray':
            return 1;
        case 'DeviceRGB':
            return 3;
        case 'DeviceCMYK':
            return 4;
        case 'ICCBased':
            return cs.components === 1 || cs.components === 3 || cs.components === 4 ? cs.components : null;
        default:
            return null;
    }
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
 * - Other colour space families: `UNSUPPORTED_COLOR_SPACE`.
 */
export function decodeSamples(image: EncodedImage, info: ImageInfo): CodecResult<RgbaImage> {
    return codecGuarded(() => {
        if (image.encoding.kind !== 'samples') {
            return codecFailure('UNSUPPORTED_ENCODING', `decodeSamples needs raw samples, got ${image.encoding.kind}`);
        }
        const { width, height } = info;
        if (!(Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0)) {
            return codecFailure('INVALID_INPUT', `invalid dimensions ${width}x${height}`);
        }
        if (info.masks.isStencilMask) return decodeStencil(image.data, info);

        const bits = info.bitsPerComponent;
        if (bits === null || !SUPPORTED_BITS.has(bits)) {
            return codecFailure('INVALID_INPUT', `unsupported bits per component: ${bits}`);
        }
        const cs = info.colorSpaceInfo;
        if (cs === null) return codecFailure('UNSUPPORTED_COLOR_SPACE', 'image has no /ColorSpace');

        const indexed = cs.family === 'Indexed' ? cs : null;
        const paint = indexed ? indexed.base : cs;
        const paintComponents = deviceComponents(paint);
        if (paintComponents === null) {
            return codecFailure('UNSUPPORTED_COLOR_SPACE', `cannot map colour space family ${paint.family} to RGB`);
        }
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
