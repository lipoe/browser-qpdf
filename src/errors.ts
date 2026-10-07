/**
 * Error contract: the single place where error codes and their mapping from
 * the C++ wrapper are defined.
 *
 * The C++ wrapper reports a technical error `kind` derived from the exception
 * type (QPDFExc error code), never from message texts. This module maps it to
 * the public, stable `ErrorCode`.
 */

/**
 * All public error codes. `ErrorCode` is derived from this list, so the type,
 * runtime checks and tests cannot drift apart.
 *
 * - `PASSWORD_REQUIRED`: `loadPdf` was called on a PDF that needs a password to open
 * - `INVALID_PASSWORD`: `loadPdfWithPassword` was called with a password that does not open the PDF
 * - `INVALID_INPUT`: invalid arguments (wrong type, size limit, object IDs, metadata)
 *   or data that cannot be read as a PDF
 * - `DISPOSED`: the document was already closed
 * - `UNKNOWN`: any other failure; see `error` for details
 *
 * New codes may be added in minor versions. Handle unknown codes like `UNKNOWN`.
 */
export const ERROR_CODES = Object.freeze([
    'PASSWORD_REQUIRED',
    'INVALID_PASSWORD',
    'INVALID_INPUT',
    'DISPOSED',
    'UNKNOWN',
] as const);

/** Machine-readable error category of a failed operation, see `ERROR_CODES`. */
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Error kinds reported by the C++ wrapper (`kind` field of its error objects).
 * Must match the literals in src/wrapper.cpp; an integration test checks every
 * kind against the real WASM binary.
 */
export const RAW_ERROR_KINDS = [
    'password',
    'damaged_pdf',
    'invalid_argument',
    'disposed',
    'unknown',
] as const;

export type RawErrorKind = (typeof RAW_ERROR_KINDS)[number];

/** Error object returned by the C++ wrapper. */
export interface RawError {
    success: false;
    kind?: string;
    error?: string;
}

/** Which public operation produced a raw error; decides how password errors are reported. */
export type ErrorContext = 'loadPdf' | 'loadPdfWithPassword' | 'document';

/**
 * Code for a password error, by operation: only the load operations involve a
 * password chosen by the caller.
 */
const PASSWORD_CODE_BY_CONTEXT = {
    loadPdf: 'PASSWORD_REQUIRED',
    loadPdfWithPassword: 'INVALID_PASSWORD',
    document: 'UNKNOWN',
} as const satisfies Record<ErrorContext, ErrorCode>;

/** Code for every kind whose meaning does not depend on the operation. */
const CODE_BY_KIND = {
    damaged_pdf: 'INVALID_INPUT',
    invalid_argument: 'INVALID_INPUT',
    disposed: 'DISPOSED',
    unknown: 'UNKNOWN',
} as const satisfies Record<Exclude<RawErrorKind, 'password'>, ErrorCode>;

function isRawErrorKind(kind: unknown): kind is RawErrorKind {
    return (RAW_ERROR_KINDS as readonly unknown[]).includes(kind);
}

/** Map a wrapper error kind to the public error code. Unknown kinds map to UNKNOWN. */
export function errorCodeOf(kind: unknown, context: ErrorContext): ErrorCode {
    if (!isRawErrorKind(kind)) return 'UNKNOWN';
    if (kind === 'password') return PASSWORD_CODE_BY_CONTEXT[context];
    return CODE_BY_KIND[kind];
}

export const DISPOSED_MESSAGE = 'Instance has been disposed';

export type Failure = { ok: false; code: ErrorCode; error: string };

export function failure(code: ErrorCode, error: string): Failure {
    return { ok: false, code, error };
}

export const invalidInput = (error: string) => failure('INVALID_INPUT', error);
export const disposed = () => failure('DISPOSED', DISPOSED_MESSAGE);

export function isRawError(result: unknown): result is RawError {
    return (
        result !== null &&
        typeof result === 'object' &&
        'success' in result &&
        !(result as { success: unknown }).success
    );
}

export function fromRawError(raw: RawError, fallbackMessage: string, context: ErrorContext): Failure {
    return failure(errorCodeOf(raw.kind, context), raw.error || fallbackMessage);
}

export function fromException(err: unknown, fallbackMessage: string): Failure {
    const message = err instanceof Error ? err.message : String(err);
    return failure('UNKNOWN', message || fallbackMessage);
}
