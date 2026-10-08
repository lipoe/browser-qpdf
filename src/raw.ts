/**
 * Internal types of the Embind-generated WASM module (src/wrapper.cpp).
 * Not part of the public API; shared by the wrapper and the integration tests.
 */

import type { RawError } from './errors.js';

/** Status object returned by C++ wrapper operations without a value. */
export type RawStatus = { success: true } | RawError;

/** Embind-exposed C++ class QpdfWasmWrapper. Value-returning methods return the value or a RawError. */
export interface RawWrapper {
    loadPdf(data: Uint8Array): RawStatus;
    loadPdfWithPassword(data: Uint8Array, password: string): RawStatus;
    getImages(recursive: boolean): unknown;
    getImageStreamData(objId: number, gen: number): unknown;
    getRawImageStreamData(objId: number, gen: number): unknown;
    readImage(objId: number, gen: number): unknown;
    replaceImageStream(objId: number, gen: number, data: Uint8Array, metadata: unknown): RawStatus;
    isEncrypted(): unknown;
    writePdf(preserveEncryption: boolean): unknown;
    close(): void;
    getPageCount(): unknown;
    getPageInfo(index: number): unknown;
    /** Embind: frees the C++ object itself. */
    delete(): void;
}

/** Instantiated WASM module. */
export interface WasmModule {
    QpdfWasmWrapper: new () => RawWrapper;
}

/** Default export of the Emscripten-generated glue code (qpdf-image-stream.js). */
export interface WasmModuleFactory {
    (options?: { locateFile?: (filename: string) => string }): Promise<WasmModule>;
}
