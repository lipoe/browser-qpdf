/**
 * Shared helpers for integration tests against the real WASM binary.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RawWrapper, WasmModule } from '../../src/raw.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

export function loadFixture(filename: string): Uint8Array {
    return new Uint8Array(readFileSync(join(FIXTURES_DIR, filename)));
}

export function readJson<T>(filename: string): T {
    return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), 'utf8')) as T;
}

/**
 * Filter facts of an image after writePdf(): QPDFWriter compresses previously
 * unfiltered streams with FlateDecode (qpdf default) and keeps every other
 * /Filter as written (including the abbreviation /Fl and codec chains).
 */
export function filterFactsAsWritten(info: { filter: string | null; filters: string[] }) {
    return {
        filter: info.filter ?? '/FlateDecode',
        filters: info.filters.length > 0 ? info.filters : ['FlateDecode'],
    };
}

/** Value of a successful result; throws with code and message otherwise. */
export function unwrap<T>(result: { ok: true; value: T } | { ok: false; code?: string; error: string }): T {
    if (!result.ok) throw new Error(`unexpected error result: ${result.code ?? ''} ${result.error}`);
    return result.value;
}

export type { RawError } from '../../src/errors.js';
export type { RawWrapper } from '../../src/raw.js';

let rawModule: Promise<WasmModule> | undefined;

/** Run `use` with a fresh raw wrapper instance and free it afterwards. */
export async function withRawWrapper<T>(use: (wrapper: RawWrapper) => T): Promise<T> {
    rawModule ??= import('../../dist/qpdf-image-stream.js' as string).then(
        (m: { default: () => Promise<WasmModule> }) => m.default()
    );
    const wrapper = new (await rawModule).QpdfWasmWrapper();
    try {
        return use(wrapper);
    } finally {
        wrapper.close();
        wrapper.delete();
    }
}

/** Page count of a PDF, read via the raw wrapper (not part of the public API). */
export function pageCount(bytes: Uint8Array, password?: string): Promise<number> {
    return withRawWrapper((wrapper) => {
        const loaded =
            password === undefined ? wrapper.loadPdf(bytes) : wrapper.loadPdfWithPassword(bytes, password);
        if (!loaded.success) throw new Error(`raw load failed: ${loaded.error ?? ''}`);
        return wrapper.getPageCount();
    });
}
