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

/** Reference to a PDF object. */
export interface ObjRef {
    objId: number;
    generation: number;
}

/** Colour space families of ISO 32000-1 §8.6, plus 'Unknown' for anything else. */
export type ColorSpaceFamily = ColorSpaceInfo['family'];

/**
 * Structured colour space facts (ISO 32000-1 §8.6). Indirect references are
 * resolved before classifying; `raw` is the PDF syntax resolved one level.
 * Forms the spec does not allow (e.g. a bare `/CalRGB` name) are reported as
 * `'Unknown'` with their raw syntax. `components` is the number of colour
 * components per sample as the PDF declares them; `null` when it cannot be
 * determined (ICCBased without `/N`, Pattern, Unknown).
 */
export type ColorSpaceInfo =
    | {
          family: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' | 'CalGray' | 'CalRGB' | 'Lab' | 'Pattern' | 'Unknown';
          components: number | null;
          raw: string;
      }
    | {
          family: 'ICCBased';
          /** `/N` of the profile stream */
          components: number | null;
          /** The ICC profile stream; readable with the stream methods. null when not a stream. */
          iccProfile: ObjRef | null;
          raw: string;
      }
    | {
          family: 'Indexed';
          /** One index per sample */
          components: 1;
          base: ColorSpaceInfo;
          hival: number;
          /** Lookup table as stored: (hival + 1) entries of the base space's components */
          lookup: Uint8Array;
          raw: string;
      }
    | {
          family: 'Separation' | 'DeviceN';
          /** Separation: 1; DeviceN: number of colorant names */
          components: number;
          names: string[];
          /** The alternate colour space; null when missing */
          alternate: ColorSpaceInfo | null;
          raw: string;
      };

/** Mask facts of an image: its own mask entries and which images use it as a mask. */
export interface ImageMaskInfo {
    /** `/ImageMask true`: the stream is a 1-bit stencil mask, not a picture */
    isStencilMask: boolean;
    /** `/SMaskInData` (JPX images whose alpha is inside the codestream), or null */
    softMaskInData: number | null;
    /** This image's `/SMask` stream, or null */
    softMask: ObjRef | null;
    /** This image's `/Mask`: a stencil mask stream, or a colour-key array, or null */
    mask: { kind: 'stencil'; ref: ObjRef } | { kind: 'colorKey' } | null;
    /** Images in the catalog whose `/SMask` is this stream (empty for ordinary pictures) */
    softMaskOf: ObjRef[];
    /** Images in the catalog whose `/Mask` is this stream */
    maskOf: ObjRef[];
}

/**
 * Facts about a single image XObject found in the PDF: the values of its
 * stream dictionary as written, plus its relations to pages and to other
 * images. The library reports facts only; it never derives values from the
 * decoded data and never judges an image.
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

    // --- added in 0.3.0 ---

    /** Structured colour space; null when /ColorSpace is absent (stencil masks, some JPX images) */
    colorSpaceInfo: ColorSpaceInfo | null;
    /**
     * Filter chain in application order, full names without leading slash
     * (abbreviations like /Fl are expanded); [] when the stream is unfiltered
     */
    filters: string[];
    /** /Decode array as written, or null */
    decode: number[] | null;
    masks: ImageMaskInfo;
    /**
     * 0-based indices of the pages from whose resources this image is
     * reachable within the requested scope (`recursive` decides whether Form
     * XObjects count). Sorted ascending.
     */
    pages: number[];
    /** Pages whose own /Resources /XObject names this image. Sorted ascending. */
    directPages: number[];
}

/**
 * Metadata fields for stream replacement. All fields are optional during
 * replacement; omit a field to keep its original value. Provided values are
 * validated, invalid ones fail with `INVALID_INPUT`.
 */
export interface ImageMetadata {
    /** New /Width in pixels: integer from 1 to 2^31-1 */
    width: number;
    /** New /Height in pixels: integer from 1 to 2^31-1 */
    height: number;
    /** New /BitsPerComponent (e.g. 8): integer from 1 to 2^31-1 */
    bitsPerComponent: number;
    /** New /ColorSpace name, with or without leading slash (e.g. "DeviceRGB"); not empty */
    colorSpace: string;
    /** New /Filter name, with or without leading slash (e.g. "DCTDecode"); not empty */
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
