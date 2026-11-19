/**
 * Image paints against the real WASM binary (Node), through the shared
 * scenario module. The same module runs in the browser page and in a Web
 * Worker (test/browser/paints.spec.ts); all three compare against
 * test/fixtures/paint-manifest.json.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import { expectedPaints, observePaints, paintFixtureNames } from '../scenarios/paint-scenarios.mjs';
import { loadFixture, readJson, unwrap } from './helpers.js';

const paintManifest = readJson<{ fixtures: Record<string, { pages: unknown[] }> }>('paint-manifest.json');
const catalogManifest = readJson<{ fixtures: Record<string, unknown> }>('manifest.json');

describe('Image paint scenarios (real WASM, Node)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    for (const name of paintFixtureNames(paintManifest)) {
        it(`${name} is observed as the paint manifest describes`, () => {
            expect(observePaints(api, loadFixture(name))).toEqual(expectedPaints(paintManifest.fixtures[name]));
        });
    }

    it.each(Object.keys(catalogManifest.fixtures))(
        '%s: every page is readable and every paint is an image of the catalog that lists the page',
        (name) => {
            const doc = unwrap(api.loadPdf(loadFixture(name)));
            const catalog = unwrap(doc.getImages({ recursive: true }));
            const pageCount = unwrap(doc.getPageCount());
            for (let page = 0; page < pageCount; page++) {
                for (const paint of unwrap(doc.getImagePaints(page))) {
                    const info = catalog.find(
                        (image) => image.objId === paint.ref.objId && image.generation === paint.ref.generation
                    );
                    expect(info?.pages).toContain(page);
                }
            }
            doc.close();
        }
    );

    it('the page index is validated', () => {
        const doc = unwrap(api.loadPdf(loadFixture('paint-transforms.pdf')));
        expect(doc.getImagePaints(1)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
        expect(doc.getImagePaints(-1)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Invalid page index' });
        expect(doc.getImagePaints(0.5)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Invalid page index' });
        doc.close();
    });

    it('a page that cannot be read fails on every call and does not affect the document or other pages', () => {
        const doc = unwrap(api.loadPdf(loadFixture('paint-unreadable-content.pdf')));
        for (let round = 0; round < 2; round++) {
            expect(doc.getImagePaints(0).ok).toBe(false);
            expect(doc.getImagePaints(1).ok).toBe(false);
            expect(doc.getImagePaints(2).ok).toBe(true);
        }
        expect(unwrap(doc.getImages()).length).toBe(1);
        doc.close();
    });

    it('paints are unchanged by replacing the painted image stream', () => {
        const doc = unwrap(api.loadPdf(loadFixture('paint-transforms.pdf')));
        const before = unwrap(doc.getImagePaints(0));
        unwrap(doc.replaceImageStream(5, 0, new Uint8Array(3), { width: 1, height: 1 }));
        expect(unwrap(doc.getImagePaints(0))).toEqual(before);
        doc.close();
    });

    it('a closed document reports DISPOSED', () => {
        const doc = unwrap(api.loadPdf(loadFixture('paint-transforms.pdf')));
        doc.close();
        expect(doc.getImagePaints(0)).toMatchObject({ ok: false, code: 'DISPOSED' });
    });
});
