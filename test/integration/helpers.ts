/**
 * Shared helpers for integration tests against the real WASM binary.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(__dirname, '..', 'fixtures');

export function loadFixture(filename: string): Uint8Array {
    return new Uint8Array(readFileSync(join(FIXTURES_DIR, filename)));
}

export function readJson<T>(filename: string): T {
    return JSON.parse(readFileSync(join(FIXTURES_DIR, filename), 'utf8')) as T;
}

/** Raw Embind wrapper from dist/, used only for internals not in the public API (page count). */
interface RawModule {
    QpdfWasmWrapper: new () => {
        loadPdf(data: Uint8Array): { success: boolean };
        loadPdfWithPassword(data: Uint8Array, password: string): { success: boolean };
        getPageCount(): number;
        close(): void;
        delete(): void;
    };
}

let rawModule: Promise<RawModule> | undefined;

/** Page count of a PDF, read via the raw wrapper (not part of the public API). */
export async function pageCount(bytes: Uint8Array, password?: string): Promise<number> {
    rawModule ??= import('../../dist/qpdf-image-stream.js' as string).then(
        (m: { default: () => Promise<RawModule> }) => m.default()
    );
    const wrapper = new (await rawModule).QpdfWasmWrapper();
    try {
        const loaded =
            password === undefined ? wrapper.loadPdf(bytes) : wrapper.loadPdfWithPassword(bytes, password);
        if (!loaded.success) throw new Error('raw load failed');
        return wrapper.getPageCount();
    } finally {
        wrapper.close();
        wrapper.delete();
    }
}
