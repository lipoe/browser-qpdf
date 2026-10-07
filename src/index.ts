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
    QpdfImageStreams,
    Result,
    PdfDocument,
    ImageInfo,
    ImageMetadata,
    WriteOptions,
} from './types.js';

import {
    disposed,
    fromException,
    fromRawError,
    invalidInput,
    isRawError,
    type ErrorContext,
} from './errors.js';
import type { RawStatus, RawWrapper, WasmModule, WasmModuleFactory } from './raw.js';

// Public error contract
export { ERROR_CODES, type ErrorCode } from './errors.js';

// Re-export all public types
export type {
    Result,
    ImageInfo,
    ImageMetadata,
    PdfDocument,
    QpdfImageStreams,
    CreateOptions,
    WriteOptions,
} from './types.js';

// --- Calling the raw wrapper (error mapping: see errors.ts) ---

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
    wrapper.delete();
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

function validatePassword(password: string): Result<never> | undefined {
    if (typeof password !== 'string') return invalidInput('Password must be a string');
    return undefined;
}

function validateWriteOptions(options?: WriteOptions): Result<never> | undefined {
    if (options === undefined) return undefined;
    if (options === null || typeof options !== 'object')
        return invalidInput('Invalid options: must be an object');
    if (options.preserveEncryption !== undefined && typeof options.preserveEncryption !== 'boolean')
        return invalidInput('Invalid option: preserveEncryption must be a boolean');
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

            /**
             * Run an operation on the open document. After close() the C++
             * object is freed, so every operation is rejected here.
             */
            function withDocument<T>(operation: () => Result<T>): Result<T> {
                return closed ? disposed() : operation();
            }

            return {
                getImages(options?: { recursive?: boolean }): Result<ImageInfo[]> {
                    return withDocument(() => {
                        const recursive = options?.recursive ?? false;
                        return callRaw(
                            () => wrapper.getImages(recursive),
                            (value) => value as ImageInfo[],
                            'Failed to get images'
                        );
                    });
                },

                getImageStreamData(objId: number, generation: number): Result<Uint8Array> {
                    return withDocument(
                        () =>
                            validateObjectRef(objId, generation) ??
                            callRaw(
                                () => wrapper.getImageStreamData(objId, generation),
                                copyBytes,
                                'Failed to get stream data'
                            )
                    );
                },

                getRawImageStreamData(objId: number, generation: number): Result<Uint8Array> {
                    return withDocument(
                        () =>
                            validateObjectRef(objId, generation) ??
                            callRaw(
                                () => wrapper.getRawImageStreamData(objId, generation),
                                copyBytes,
                                'Failed to get raw stream data'
                            )
                    );
                },

                replaceImageStream(
                    objId: number,
                    generation: number,
                    data: Uint8Array,
                    metadata?: Partial<ImageMetadata>
                ): Result<void> {
                    return withDocument(() => {
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
                    });
                },

                isEncrypted(): Result<boolean> {
                    return withDocument(() =>
                        callRaw(
                            () => wrapper.isEncrypted(),
                            (value) => value === true,
                            'Failed to determine encryption'
                        )
                    );
                },

                writePdf(options?: WriteOptions): Result<Uint8Array> {
                    return withDocument(() => {
                        const invalid = validateWriteOptions(options);
                        if (invalid) return invalid;
                        const preserveEncryption = options?.preserveEncryption ?? true;
                        return callRaw(
                            () => wrapper.writePdf(preserveEncryption),
                            copyBytes,
                            'Failed to write PDF'
                        );
                    });
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
                return (
                    validatePassword(password) ??
                    load(data, 'loadPdfWithPassword', (wrapper) =>
                        wrapper.loadPdfWithPassword(data, password)
                    )
                );
            },
        };
    } catch (err: unknown) {
        throw new Error(
            `Failed to initialize WASM module: ${err instanceof Error ? err.message : String(err)}`
        );
    }
}
