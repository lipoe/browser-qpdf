/**
 * @module @lipoe/browser-qpdf
 *
 * Browser-compatible WASM module exposing qpdf's library API for reading
 * and replacing PDF image streams.
 *
 * Usage:
 * ```typescript
 * import { createQpdfImageStreams } from '@lipoe/browser-qpdf';
 *
 * const qpdf = await createQpdfImageStreams();
 * const result = qpdf.loadPdf(pdfBytes);
 * if (result.ok) {
 *     const images = result.value.getImages();
 *     // ...
 *     result.value.close();
 * }
 * ```
 *
 * Memory ownership: The caller is responsible for calling `close()` on
 * the PdfDocument to release WASM memory. Failure to do so will leak memory.
 */

import type {
    CreateOptions,
    ErrorCode,
    QpdfImageStreams,
    Result,
    PdfDocument,
    ImageInfo,
    ImageMetadata,
    WriteOptions,
} from './types.js';

// Re-export all public types
export type {
    ErrorCode,
    Result,
    ImageInfo,
    ImageMetadata,
    PdfDocument,
    QpdfImageStreams,
    CreateOptions,
    WriteOptions,
} from './types.js';

// --- Internal types for the raw WASM module ---

/** Shape of the Emscripten-generated module factory default export. */
interface WasmModuleFactory {
    (options?: { locateFile?: (filename: string) => string }): Promise<WasmModule>;
}

/** Internal type for the instantiated WASM module. */
interface WasmModule {
    QpdfWasmWrapper: new () => RawWrapper;
}

/**
 * Technical error category reported by the C++ wrapper, derived from the
 * exception type (QPDFExc error code), never from message texts.
 */
type RawErrorKind = 'password' | 'damaged_pdf' | 'invalid_argument' | 'disposed' | 'unknown';

/** Error object returned by the C++ wrapper. */
interface RawError {
    success: false;
    kind?: RawErrorKind;
    error?: string;
}

/** Status object returned by C++ wrapper operations without a value. */
type RawStatus = { success: true } | RawError;

/** Internal type matching the Embind-exposed C++ class methods. */
interface RawWrapper {
    loadPdf(data: Uint8Array): RawStatus;
    loadPdfWithPassword(data: Uint8Array, password: string): RawStatus;
    getImages(recursive: boolean): unknown;
    getImageStreamData(objId: number, gen: number): unknown;
    getRawImageStreamData(objId: number, gen: number): unknown;
    replaceImageStream(objId: number, gen: number, data: Uint8Array, metadata: unknown): RawStatus;
    isEncrypted(): unknown;
    writePdf(preserveEncryption: boolean): unknown;
    close(): void;
    getPageCount(): number;
    /** Embind: frees the C++ object itself. */
    delete?(): void;
}

// --- Error mapping (single place where error codes are decided) ---

/** Which public operation produced a raw error; decides how password errors are reported. */
type ErrorContext = 'loadPdf' | 'loadPdfWithPassword' | 'document';

const DISPOSED_MESSAGE = 'Instance has been disposed';

function failure(code: ErrorCode, error: string): { ok: false; code: ErrorCode; error: string } {
    return { ok: false, code, error };
}

const invalidInput = (error: string) => failure('INVALID_INPUT', error);
const disposed = () => failure('DISPOSED', DISPOSED_MESSAGE);

function errorCodeOf(kind: RawErrorKind | undefined, context: ErrorContext): ErrorCode {
    switch (kind) {
        case 'password':
            return context === 'loadPdf' ? 'PASSWORD_REQUIRED' : 'INVALID_PASSWORD';
        case 'damaged_pdf':
        case 'invalid_argument':
            return 'INVALID_INPUT';
        case 'disposed':
            return 'DISPOSED';
        default:
            return 'UNKNOWN';
    }
}

function isRawError(result: unknown): result is RawError {
    return (
        result !== null &&
        typeof result === 'object' &&
        'success' in result &&
        !(result as { success: unknown }).success
    );
}

function fromRawError(raw: RawError, fallbackMessage: string, context: ErrorContext) {
    return failure(errorCodeOf(raw.kind, context), raw.error || fallbackMessage);
}

function fromException(err: unknown, fallbackMessage: string) {
    const message = err instanceof Error ? err.message : String(err);
    return failure('UNKNOWN', message || fallbackMessage);
}

/**
 * Call a raw wrapper method and convert its result: error objects and
 * exceptions become error results, anything else is passed to `convert`.
 */
function callRaw<T>(
    call: () => unknown,
    convert: (value: unknown) => T,
    fallbackMessage: string,
    context: ErrorContext = 'document'
): Result<T> {
    try {
        const result = call();
        if (isRawError(result)) return fromRawError(result, fallbackMessage, context);
        return { ok: true, value: convert(result) };
    } catch (err: unknown) {
        return fromException(err, fallbackMessage);
    }
}

/** Release all WASM memory of a wrapper, including the Embind object itself. */
function destroy(wrapper: RawWrapper): void {
    wrapper.close();
    wrapper.delete?.();
}

/** Copy a typed_memory_view into a new Uint8Array so the data outlives the WASM buffer. */
const copyBytes = (value: unknown) => new Uint8Array(value as Uint8Array);

// --- Input validation ---

/** Maximum input PDF size: 256 MB */
const MAX_PDF_SIZE = 256 * 1024 * 1024;

function validatePdfInput(data: Uint8Array): Result<never> | undefined {
    if (!(data instanceof Uint8Array)) return invalidInput('Input must be a Uint8Array');
    if (data.byteLength > MAX_PDF_SIZE) return invalidInput('Data exceeds 256 MB limit');
    return undefined;
}

function validateObjectRef(objId: number, generation: number): Result<never> | undefined {
    if (!Number.isInteger(objId) || objId < 0) return invalidInput('Invalid object ID');
    if (!Number.isInteger(generation) || generation < 0)
        return invalidInput('Invalid generation number');
    return undefined;
}

function validateMetadata(metadata?: Partial<ImageMetadata>): Result<never> | undefined {
    if (!metadata) return undefined;
    if (metadata.width !== undefined && metadata.width < 0)
        return invalidInput('Invalid metadata: width must not be negative');
    if (metadata.height !== undefined && metadata.height < 0)
        return invalidInput('Invalid metadata: height must not be negative');
    if (metadata.bitsPerComponent !== undefined && metadata.bitsPerComponent < 0)
        return invalidInput('Invalid metadata: bitsPerComponent must not be negative');
    return undefined;
}

/**
 * Create and initialize the qpdf WASM image streams API.
 *
 * This async factory function loads the WASM module, awaits initialization,
 * and returns a ready-to-use API object. If WASM loading fails (e.g. network
 * error fetching the .wasm file), the returned promise rejects with a
 * descriptive Error.
 *
 * @param options - Optional configuration for WASM loading.
 * @returns A promise that resolves to the QpdfImageStreams API object.
 *
 * @example
 * ```typescript
 * const qpdf = await createQpdfImageStreams({
 *     locateFile: (name) => `/assets/wasm/${name}`
 * });
 * ```
 */
export async function createQpdfImageStreams(
    options?: CreateOptions
): Promise<QpdfImageStreams> {
    try {
        // Dynamically import the Emscripten-generated glue code.
        // Both index.js and qpdf-image-stream.js reside in dist/ after build.
        const { default: createQpdfModule }: { default: WasmModuleFactory } =
            await import('./qpdf-image-stream.js' as string);

        const moduleOptions: { locateFile?: (filename: string) => string } = {};
        if (options?.locateFile) {
            moduleOptions.locateFile = options.locateFile;
        }

        const wasmModule: WasmModule = await createQpdfModule(moduleOptions);

        /**
         * Creates a PdfDocument implementation wrapping a raw WASM wrapper instance.
         * The returned object provides lifecycle-guarded access to all PDF operations.
         */
        function createPdfDocument(wrapper: RawWrapper): PdfDocument {
            let closed = false;

            return {
                getImages(options?: { recursive?: boolean }): Result<ImageInfo[]> {
                    if (closed) return disposed();
                    const recursive = options?.recursive ?? false;
                    return callRaw(
                        () => wrapper.getImages(recursive),
                        (value) => value as ImageInfo[],
                        'Failed to get images'
                    );
                },

                getImageStreamData(objId: number, generation: number): Result<Uint8Array> {
                    if (closed) return disposed();
                    const invalid = validateObjectRef(objId, generation);
                    if (invalid) return invalid;
                    return callRaw(
                        () => wrapper.getImageStreamData(objId, generation),
                        copyBytes,
                        'Failed to get stream data'
                    );
                },

                getRawImageStreamData(objId: number, generation: number): Result<Uint8Array> {
                    if (closed) return disposed();
                    const invalid = validateObjectRef(objId, generation);
                    if (invalid) return invalid;
                    return callRaw(
                        () => wrapper.getRawImageStreamData(objId, generation),
                        copyBytes,
                        'Failed to get raw stream data'
                    );
                },

                replaceImageStream(
                    objId: number,
                    generation: number,
                    data: Uint8Array,
                    metadata?: Partial<ImageMetadata>
                ): Result<void> {
                    if (closed) return disposed();
                    if (!(data instanceof Uint8Array))
                        return invalidInput('Data must be a Uint8Array');
                    const invalid =
                        validateObjectRef(objId, generation) ?? validateMetadata(metadata);
                    if (invalid) return invalid;

                    // Build metadata object for WASM:
                    // 0 for integers and empty string for strings means "preserve original"
                    // Normalize: strip leading slash from filter/colorSpace if provided,
                    // the C++ wrapper adds the PDF name prefix automatically.
                    const normalizeName = (v: string) => (v.startsWith('/') ? v.slice(1) : v);

                    const wasmMetadata = {
                        width: metadata?.width ?? 0,
                        height: metadata?.height ?? 0,
                        bitsPerComponent: metadata?.bitsPerComponent ?? 0,
                        colorSpace: metadata?.colorSpace ? normalizeName(metadata.colorSpace) : '',
                        filter: metadata?.filter ? normalizeName(metadata.filter) : '',
                    };

                    return callRaw(
                        () => wrapper.replaceImageStream(objId, generation, data, wasmMetadata),
                        () => undefined,
                        'Failed to replace stream'
                    );
                },

                isEncrypted(): Result<boolean> {
                    if (closed) return disposed();
                    return callRaw(
                        () => wrapper.isEncrypted(),
                        (value) => value === true,
                        'Failed to determine encryption'
                    );
                },

                writePdf(options?: WriteOptions): Result<Uint8Array> {
                    if (closed) return disposed();
                    const preserveEncryption = options?.preserveEncryption ?? true;
                    return callRaw(
                        () => wrapper.writePdf(preserveEncryption),
                        copyBytes,
                        'Failed to write PDF'
                    );
                },

                close(): void {
                    if (closed) return; // no-op on subsequent calls
                    closed = true;
                    destroy(wrapper);
                },
            };
        }

        /** Load a PDF into a fresh wrapper instance (one per document). */
        function load(
            data: Uint8Array,
            context: 'loadPdf' | 'loadPdfWithPassword',
            loadInto: (wrapper: RawWrapper) => RawStatus
        ): Result<PdfDocument> {
            const invalid = validatePdfInput(data);
            if (invalid) return invalid;

            return callRaw(
                () => {
                    const wrapper = new wasmModule.QpdfWasmWrapper();
                    try {
                        const result = loadInto(wrapper);
                        if (result.success) return wrapper;
                        destroy(wrapper);
                        return result;
                    } catch (err: unknown) {
                        destroy(wrapper);
                        throw err;
                    }
                },
                (wrapper) => createPdfDocument(wrapper as RawWrapper),
                'Failed to load PDF',
                context
            );
        }

        return {
            loadPdf(data: Uint8Array): Result<PdfDocument> {
                return load(data, 'loadPdf', (wrapper) => wrapper.loadPdf(data));
            },

            loadPdfWithPassword(data: Uint8Array, password: string): Result<PdfDocument> {
                return load(data, 'loadPdfWithPassword', (wrapper) =>
                    wrapper.loadPdfWithPassword(data, password)
                );
            },
        };
    } catch (err: unknown) {
        throw new Error(
            `Failed to initialize WASM module: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}
