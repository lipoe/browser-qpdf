/**
 * Structural rule of the package (PLAN-0.3.0 §3.12): the codec module depends
 * on the core by types only, and the core never depends on the codec module.
 * This keeps the module extractable into its own package by moving a
 * directory.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

function listTs(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listTs(path) : name.endsWith('.ts') ? [path] : [];
    });
}

/** Every import/export-from statement of a file: [isTypeOnly, specifier]. */
function imports(file: string): Array<{ typeOnly: boolean; from: string }> {
    const source = readFileSync(file, 'utf8');
    const statements = source.match(/^\s*(import|export)[^;]*?from\s+['"][^'"]+['"]/gm) ?? [];
    return statements.map((statement) => ({
        typeOnly: /^\s*(import|export)\s+type\b/.test(statement),
        from: /from\s+['"]([^'"]+)['"]/.exec(statement)![1],
    }));
}

const files = listTs(SRC);
const coreFiles = files.filter((f) => !relative(SRC, f).startsWith('codecs'));
const codecFiles = files.filter((f) => relative(SRC, f).startsWith('codecs'));

describe('Import graph: core and codec module', () => {
    it('finds both parts', () => {
        expect(coreFiles.length).toBeGreaterThan(0);
        expect(codecFiles.length).toBeGreaterThan(0);
    });

    it('the core never imports from src/codecs/', () => {
        for (const file of coreFiles) {
            for (const { from } of imports(file)) {
                expect(from, `${relative(SRC, file)} imports ${from}`).not.toMatch(/codecs/);
            }
        }
    });

    it('the codec module imports from the core by types only', () => {
        for (const file of codecFiles) {
            for (const { typeOnly, from } of imports(file)) {
                const leavesModule = from.startsWith('../');
                if (leavesModule) {
                    expect(typeOnly, `${relative(SRC, file)} imports a value from ${from}`).toBe(true);
                    expect(from, `${relative(SRC, file)} must not import the WASM glue`).not.toMatch(/qpdf-image-stream/);
                }
            }
        }
    });
});
