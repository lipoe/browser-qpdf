import { defineWorkspace } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Two test projects:
 * - unit:        TypeScript wrapper against a mocked WASM module (fast, no binary needed)
 * - integration: TypeScript wrapper against the real WASM binary in dist/
 */
export default defineWorkspace([
    {
        resolve: {
            alias: {
                './qpdf-image-stream.js': resolve(__dirname, 'test/__mocks__/qpdf-image-stream.js'),
            },
        },
        test: {
            name: 'unit',
            include: ['test/unit/**/*.test.ts', 'test/pbt/**/*.test.ts'],
            globals: false,
        },
    },
    {
        resolve: {
            alias: {
                './qpdf-image-stream.js': resolve(__dirname, 'dist/qpdf-image-stream.js'),
            },
        },
        test: {
            name: 'integration',
            include: ['test/integration/**/*.test.ts'],
            globals: false,
        },
    },
]);
