/**
 * Property: no public operation throws and every result is well-formed, for
 * arbitrary arguments and operation sequences, against the real WASM binary
 * (Embind type conversions, qpdf exceptions).
 */

import { describe, it, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import {
    anyArgument,
    expectNeverThrows,
    LOAD_OPERATIONS,
    operationSequence,
    runStep,
} from '../support/api-invariants.js';
import { loadFixture, unwrap } from './helpers.js';

const FIXTURES = ['multi-image.pdf', 'jpeg-compressed.pdf', 'aes128-owner-only.pdf'];

describe('Property: public operations never throw (real WASM)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    it.each(Object.keys(LOAD_OPERATIONS) as (keyof typeof LOAD_OPERATIONS)[])(
        '%s with arbitrary arguments',
        (name) => {
            fc.assert(
                fc.property(
                    fc.oneof(anyArgument, fc.constantFrom(...FIXTURES.map(loadFixture))),
                    anyArgument,
                    (data, password) => {
                        const result = expectNeverThrows(() =>
                            LOAD_OPERATIONS[name].call(api, [data, password])
                        ) as { ok: boolean; value?: { close(): void } };
                        if (result.ok) result.value?.close();
                    }
                ),
                { numRuns: 100 }
            );
        }
    );

    it('arbitrary operation sequences on real documents', () => {
        fc.assert(
            fc.property(fc.constantFrom(...FIXTURES), operationSequence, (fixture, steps) => {
                const doc = unwrap(api.loadPdf(loadFixture(fixture)));
                for (const step of steps) runStep(doc, step);
                doc.close();
            }),
            { numRuns: 200 }
        );
    });
});
