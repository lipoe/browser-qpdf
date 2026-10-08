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
export type Result<T> = ResultOf<T, ErrorCode>;

/**
 * The one result shape of this package, parameterised by its code union.
 * The core uses `Result<T>` (= `ResultOf<T, ErrorCode>`); the codec module
 * uses it with its own codes, so both share the shape by reference.
 */
export type ResultOf<T, Code extends string> =
    | { ok: true; value: T }
    | { ok: false; code: Code; error: string };

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
    /**
     * The encoding the filter chain declares, read from the dictionary alone
     * (no bytes are read): what `readImage()` will report once the container
     * filters are removed, with the codec's parameters. `null` when the chain
     * has more than one filter after the codec (readImage refuses it).
     * Whether the container filters can actually be applied (unknown names,
     * damaged data) is only known when `readImage()` runs.
     */
    encoding: ImageEncoding | null;
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
 * What the bytes of an EncodedImage are, once the container filters are
 * removed. Every kind names a public standard. Codec parameters are typed
 * per kind (ISO 32000-1 §7.4.6, §7.4.7); keys the spec gives a default are
 * reported with that default.
 */
export type ImageEncoding =
    /** Raw samples; layout described by the ImageInfo (width, height, bitsPerComponent, colorSpaceInfo, decode) */
    | { kind: 'samples' }
    /** A complete JPEG file (ITU-T T.81), was /DCTDecode */
    | { kind: 'jpeg' }
    /** A JPEG 2000 codestream or JP2 file (ISO 15444), was /JPXDecode */
    | { kind: 'jpeg2000' }
    /** Group 3/4 fax data (ITU-T T.4 / T.6), was /CCITTFaxDecode */
    | {
          kind: 'ccitt';
          /** <0: pure 2D (G4), 0: pure 1D, >0: mixed (G3 2D). Default 0 */
          k: number;
          /** Default 1728 */
          columns: number;
          /** 0: height not predetermined, data ends with EOFB or at the end (spec default 0) */
          rows: number;
          blackIs1: boolean;
          byteAlign: boolean;
          endOfLine: boolean;
          endOfBlock: boolean;
      }
    /** JBIG2 embedded stream (ITU-T T.88), was /JBIG2Decode */
    | { kind: 'jbig2'; globals: ObjRef | null };

/** An image in its stored encoding: container compression removed, codec untouched. */
export interface EncodedImage {
    data: Uint8Array;
    encoding: ImageEncoding;
}

/** Facts of one page. */
export interface PageInfo {
    /** 0-based index in page tree order (the argument echoed) */
    index: number;
    /**
     * Inherited /MediaBox, normalised to origin and size in PDF user units
     * (/Rotate not applied). qpdf repairs a missing or malformed /MediaBox to
     * Letter (612 x 792) while reading the page tree; the repaired value is
     * what is reported.
     */
    mediaBox: { x: number; y: number; width: number; height: number };
    /** Inherited /Rotate normalised; 0 when absent (spec default); null when not a multiple of 90 */
    rotate: 0 | 90 | 180 | 270 | null;
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
    /**
     * Read decoded stream data: every filter the qpdf build can decode is
     * applied; the call fails when the chain contains one it cannot. Frozen
     * 0.1.0 route ("samples or error"); prefer readImage(), which reports the
     * stored encoding instead of depending on qpdf's decoders.
     */
    getImageStreamData(objId: number, generation: number): Result<Uint8Array>;
    /** Read raw (compressed/encoded) stream data for an image. */
    getRawImageStreamData(objId: number, generation: number): Result<Uint8Array>;
    /**
     * Read an image in its stored encoding: container compression (Flate,
     * LZW, ...) removed, the image codec left untouched and named in
     * `encoding`. Works for any stream object, e.g. soft masks and ICC
     * profiles too. Fails (never returns partially decoded bytes) on damaged
     * data, unknown filters, or more than one filter after the codec.
     */
    readImage(objId: number, generation: number): Result<EncodedImage>;
    /** Number of pages. */
    getPageCount(): Result<number>;
    /** Facts of the page at a 0-based index; `INVALID_INPUT` when out of range. */
    getPageInfo(index: number): Result<PageInfo>;
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
