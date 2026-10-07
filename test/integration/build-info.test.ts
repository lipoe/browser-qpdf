/**
 * Guards against testing a stale binary: dist/build-info.json (written by
 * build-wasm.sh) must match the current build inputs. If this fails, rebuild
 * the WASM module (see README, "Building").
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_INFO = join(ROOT, 'dist', 'build-info.json');

interface BuildInfo {
    qpdfVersion: string;
    emscriptenVersion: string;
    sources: Record<string, string>;
}

/** SHA-256 of a source file as the Docker build sees it (LF line endings). */
function sourceHash(relativePath: string): string {
    const content = readFileSync(join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
    return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** The pinned qpdf version from the Dockerfile (single source). */
function pinnedQpdfVersion(): string {
    const match = /^ARG QPDF_VERSION=(\S+)$/m.exec(readFileSync(join(ROOT, 'Dockerfile'), 'utf8'));
    if (!match) throw new Error('ARG QPDF_VERSION not found in Dockerfile');
    return match[1];
}

describe('WASM build info (dist/ matches the sources)', () => {
    it('dist/build-info.json exists', () => {
        expect(existsSync(BUILD_INFO), 'dist/ was not built by build-wasm.sh; rebuild the WASM module').toBe(true);
    });

    const info = existsSync(BUILD_INFO)
        ? (JSON.parse(readFileSync(BUILD_INFO, 'utf8')) as BuildInfo)
        : undefined;

    it.each(['src/wrapper.cpp', 'build-wasm.sh'])('%s is unchanged since the WASM build', (file) => {
        expect(info?.sources[file], `${file} changed after the WASM build; rebuild the WASM module`).toBe(
            sourceHash(file)
        );
    });

    it('was built with the pinned qpdf version', () => {
        expect(info?.qpdfVersion).toBe(pinnedQpdfVersion());
    });
});
