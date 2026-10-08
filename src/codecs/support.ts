/**
 * The one rule for "can this stage turn an image into pixels", computed from
 * the catalog facts alone (no bytes read). `canDecode` reports it; the
 * decoders consult the same function before doing any work, so what is
 * promised and what happens cannot drift apart.
 */

import type { ColorSpaceInfo, ImageInfo } from '../types.js';
import type { CodecErrorCode } from './errors.js';

/** How this stage would decode an image: as raw samples, or through the browser's JPEG decoder. */
export type DecodeRoute = 'samples' | 'jpeg';

export type DecodeSupport =
    | { ok: true; route: DecodeRoute; components: 1 | 3 | 4 | null }
    | { ok: false; code: CodecErrorCode; error: string };

const SUPPORTED_BITS = new Set([1, 2, 4, 8, 16]);

/**
 * Component count of a colour space this stage can map to RGB, or null.
 * Device spaces by definition; ICCBased by its declared component count
 * (1, 3 or 4 treated as Gray, RGB, CMYK); Indexed through its base.
 */
export function deviceComponents(cs: ColorSpaceInfo): 1 | 3 | 4 | null {
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

function unsupported(code: CodecErrorCode, error: string): DecodeSupport {
    return { ok: false, code, error };
}

/**
 * Whether stage A can decode the image described by `info`, decided from
 * facts only. `route: 'jpeg'` needs a browser (`createImageBitmap`);
 * `route: 'samples'` works everywhere. The decoders apply exactly this rule.
 */
export function canDecode(info: ImageInfo): DecodeSupport {
    const { encoding } = info;
    if (encoding === null) return unsupported('UNSUPPORTED_ENCODING', 'filter chain is not describable (readImage refuses it)');
    if (encoding.kind === 'jpeg') return { ok: true, route: 'jpeg', components: null };
    if (encoding.kind !== 'samples') {
        return unsupported('UNSUPPORTED_ENCODING', `no decoder for ${encoding.kind} in this version of the codec module`);
    }
    if (!(Number.isInteger(info.width) && info.width > 0 && Number.isInteger(info.height) && info.height > 0)) {
        return unsupported('INVALID_INPUT', `invalid dimensions ${info.width}x${info.height}`);
    }
    if (info.masks.isStencilMask) return { ok: true, route: 'samples', components: null };

    const bits = info.bitsPerComponent;
    if (bits === null || !SUPPORTED_BITS.has(bits)) {
        return unsupported('INVALID_INPUT', `unsupported bits per component: ${bits}`);
    }
    const cs = info.colorSpaceInfo;
    if (cs === null) return unsupported('UNSUPPORTED_COLOR_SPACE', 'image has no /ColorSpace');
    const paint = cs.family === 'Indexed' ? cs.base : cs;
    const components = deviceComponents(paint);
    if (components === null) {
        return unsupported('UNSUPPORTED_COLOR_SPACE', `cannot map colour space family ${paint.family} to RGB`);
    }
    return { ok: true, route: 'samples', components };
}
