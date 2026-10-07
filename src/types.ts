/**
 * Public type definitions for the qpdf-image-streams TypeScript wrapper.
 *
 * These types define the ergonomic, type-safe API surface exposed to consumers.
 */

/**
 * Machine-readable error category of a failed operation.
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
export type ErrorCode =
    | 'PASSWORD_REQUIRED'
    | 'INVALID_PASSWORD'
    | 'INVALID_INPUT'
    | 'DISPOSED'
    | 'UNKNOWN';

/**
 * Discriminated union representing either a successful result or an error.
 * All operations return this type instead of throwing exceptions.
 *
 * On failure, `code` is the stable, machine-readable error category and
 * `error` a human-readable message (wording may change between versions).
 */
export type Result<T> =
    | { ok: true; value: T }
    | { ok: false; code: ErrorCode; error: string };

/**
 * Metadata for a single image XObject found in the PDF.
 */
export interface ImageInfo {
    /** PDF object ID */
    objId: number;
    /** PDF generation number */
    generation: number;
    /** Image width in pixels */
    width: number;
    /** Image height in pixels */
    height: number;
    /** Bits per color component, or null if not specified */
    bitsPerComponent: number | null;
    /** Color space name (e.g. "DeviceRGB"), or null if not specified */
    colorSpace: string | null;
    /** Compression filter name (e.g. "DCTDecode"), or null if not specified */
    filter: string | null;
    /** Encoded stream length in bytes */
    streamLength: number;
}

/**
 * Metadata fields for stream replacement. All fields are optional during replacement;
 * omitted fields preserve the original values.
 */
export interface ImageMetadata {
    width: number;
    height: number;
    bitsPerComponent: number;
    colorSpace: string;
    filter: string;
}

/**
 * Options for PdfDocument.writePdf().
 */
export interface WriteOptions {
    /**
     * Keep the encryption of the source PDF in the output (default: true).
     * Set to false to write an unencrypted PDF; this requires the document
     * to have been opened (with the user or owner password if needed).
     */
    preserveEncryption?: boolean;
}

/**
 * Handle to a loaded PDF document. Provides methods for image enumeration,
 * stream reading/replacement, PDF writing, and resource cleanup.
 */
export interface PdfDocument {
    /** Enumerate all image XObjects in the PDF. */
    getImages(options?: { recursive?: boolean }): Result<ImageInfo[]>;
    /** Read decoded (decompressed) stream data for an image. */
    getImageStreamData(objId: number, generation: number): Result<Uint8Array>;
    /** Read raw (compressed/encoded) stream data for an image. */
    getRawImageStreamData(objId: number, generation: number): Result<Uint8Array>;
    /**
     * Replace image stream content and optionally update metadata.
     * Omitted metadata fields preserve original values.
     */
    replaceImageStream(
        objId: number,
        generation: number,
        data: Uint8Array,
        metadata?: Partial<ImageMetadata>
    ): Result<void>;
    /**
     * Whether the loaded (source) PDF is encrypted. Reflects the input
     * document, not the output of writePdf().
     */
    isEncrypted(): Result<boolean>;
    /**
     * Write the (possibly modified) PDF to a new Uint8Array.
     * By default the encryption of the source PDF is preserved.
     */
    writePdf(options?: WriteOptions): Result<Uint8Array>;
    /**
     * Release all WASM memory held by this document.
     * After calling close(), all other methods will return an error result.
     * Multiple calls to close() are no-ops.
     */
    close(): void;
}

/**
 * Top-level API object returned by the factory function.
 * Use loadPdf or loadPdfWithPassword to open a PDF document.
 */
export interface QpdfImageStreams {
    /**
     * Load a PDF from binary data without a password. PDFs that are encrypted
     * without an open password (owner password only) load as well.
     * Fails with `PASSWORD_REQUIRED` if a password is needed.
     */
    loadPdf(data: Uint8Array): Result<PdfDocument>;
    /**
     * Load a password-protected PDF with its user or owner password.
     * Fails with `INVALID_PASSWORD` if the password does not open the PDF.
     */
    loadPdfWithPassword(data: Uint8Array, password: string): Result<PdfDocument>;
}

/**
 * Options for the createQpdfImageStreams factory function.
 */
export interface CreateOptions {
    /**
     * Override WASM file URL resolution for CDN or bundler compatibility.
     * Called by Emscripten to resolve the .wasm file path.
     */
    locateFile?: (filename: string) => string;
}
