/**
 * Property: no public operation throws, for arbitrary arguments, against the
 * real WASM binary (Embind type conversions, qpdf exceptions).
 */

import { describe, it, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import {
    anyArgument,
    DOCUMENT_OPERATIONS,
    expectNeverThrows,
    LOAD_OPERATIONS,
} from '../support/api-invariants.js';
import { loadFixture, unwrap } from './helpers.js';

const FIXTURES = ['multi-image.pdf', 'jpeg-compressed.pdf', 'aes128-owner-only.pdf'];

describe('Property: public operations never throw (real WASM)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    it.each(Object.keys(LOAD_OPERATIONS))('%s with arbitrary arguments', (name) => {
        fc.assert(
            fc.property(
                fc.oneof(anyArgument, fc.constantFrom(...FIXTURES.map(loadFixture))),
                anyArgument,
                (data, password) => {
                    const result = expectNeverThrows(() => LOAD_OPERATIONS[name](api, [data, password])) as {
                        ok: boolean;
                        value?: { close(): void };
                    };
                    if (result.ok) result.value?.close();
                }
            ),
            { numRuns: 100 }
        );
    });

    it.each(Object.keys(DOCUMENT_OPERATIONS))('%s with arbitrary arguments', (name) => {
        fc.assert(
            fc.property(
                fc.constantFrom(...FIXTURES),
                fc.array(anyArgument, { maxLength: 4 }),
                (fixture, args) => {
                    const doc = unwrap(api.loadPdf(loadFixture(fixture)));
                    expectNeverThrows(() => DOCUMENT_OPERATIONS[name](doc, args));
                    doc.close();
                }
            ),
            { numRuns: 100 }
        );
    });
});
