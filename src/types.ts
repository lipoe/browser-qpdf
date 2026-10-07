/**
 * Public type definitions for the qpdf-image-streams TypeScript wrapper.
 *
 * These types define the ergonomic, type-safe API surface exposed to consumers.
 */

import type { ErrorCode } from './errors.js';

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
 * Metadata for a single image XObject found in the PDF, as read from the
 * image stream dictionary.
 */
export interface ImageInfo {
    /** PDF object ID */
    objId: number;
    /** PDF generation number */
    generation: number;
    /** Image width in pixels (/Width), 0 if missing or not an integer */
    width: number;
    /** Image height in pixels (/Height), 0 if missing or not an integer */
    height: number;
    /** Bits per color component (/BitsPerComponent), or null if not specified */
    bitsPerComponent: number | null;
    /**
     * Color space (/ColorSpace) as PDF name with leading slash (e.g. "/DeviceRGB"),
     * the PDF syntax of an array color space (e.g. "[ /ICCBased 7 0 R ]"),
     * or null if not specified
     */
    colorSpace: string | null;
    /**
     * Compression filter (/Filter) as PDF name with leading slash (e.g. "/DCTDecode"),
     * the PDF syntax of a filter array, or null if the stream is not filtered
     */
    filter: string | null;
    /** Encoded (raw) stream length in bytes (/Length), 0 if missing */
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
    /**
     * Enumerate all image XObjects in the PDF.
     *
     * Known limitation: errors while traversing the pages are not reported;
     * the result is then `ok` with the images found up to that point.
     */
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
