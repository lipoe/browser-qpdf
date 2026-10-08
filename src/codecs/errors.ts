/**
 * Error contract of the codec module. Same result shape as the core
 * (`ResultOf`), own code list: the core's `ErrorCode` stays frozen while this
 * module's codes may grow with its stages.
 */

import type { ResultOf } from '../types.js';

/**
 * - `UNSUPPORTED_ENCODING`: this stage has no decoder for `encoding.kind`
 * - `UNSUPPORTED_COLOR_SPACE`: samples cannot be turned into RGBA without facts this module does not have
 *   (tint transforms, Lab ranges) or the colour space is unknown
 * - `INVALID_INPUT`: inconsistent facts (bits per component, data length, dimensions)
 * - `DECODE_FAILED`: a decoder (e.g. the browser's JPEG decoder) rejected the data
 */
export const CODEC_ERROR_CODES = Object.freeze([
    'UNSUPPORTED_ENCODING',
    'UNSUPPORTED_COLOR_SPACE',
    'INVALID_INPUT',
    'DECODE_FAILED',
] as const);

export type CodecErrorCode = (typeof CODEC_ERROR_CODES)[number];

export type CodecResult<T> = ResultOf<T, CodecErrorCode>;

export function codecFailure(code: CodecErrorCode, error: string): CodecResult<never> {
    return { ok: false, code, error };
}

export function codecOk<T>(value: T): CodecResult<T> {
    return { ok: true, value };
}

/** Run `operation`; any exception becomes a `DECODE_FAILED` result, so the module never throws. */
export function codecGuarded<T>(operation: () => CodecResult<T>): CodecResult<T> {
    try {
        return operation();
    } catch (err: unknown) {
        return codecFailure('DECODE_FAILED', err instanceof Error ? err.message : String(err));
    }
}

/** Async variant of codecGuarded. */
export async function codecGuardedAsync<T>(operation: () => Promise<CodecResult<T>>): Promise<CodecResult<T>> {
    try {
        return await operation();
    } catch (err: unknown) {
        return codecFailure('DECODE_FAILED', err instanceof Error ? err.message : String(err));
    }
}
