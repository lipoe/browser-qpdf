/**
 * readImage() on encrypted PDFs: the scratch-document path (codec chains)
 * and the direct path (container filters only) must see decrypted bytes and
 * produce exactly what the unencrypted source produces.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams, type PdfDocument, type EncodedImage } from '../../src/index.js';
import { loadFixture, readJson, unwrap } from './helpers.js';

interface EncryptedManifest {
    source: string;
    fixtures: Record<string, { source?: string; userPassword: string; requiresPassword: boolean }>;
}

const manifest = readJson<EncryptedManifest>('encrypted-manifest.json');

/** readImage() of every image of a document, in catalog order. */
function readAll(doc: PdfDocument): EncodedImage[] {
    return unwrap(doc.getImages({ recursive: true })).map((info) => unwrap(doc.readImage(info.objId, info.generation)));
}

describe('readImage() on encrypted PDFs (real WASM)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    it('includes a fixture whose source has a codec chain (scratch path under encryption)', () => {
        expect(Object.values(manifest.fixtures).some((f) => f.source === 'flate-dct-chain.pdf')).toBe(true);
    });

    for (const [file, fixture] of Object.entries(manifest.fixtures)) {
        it(`${file}: encodings and bytes equal its source ${fixture.source ?? manifest.source}`, () => {
            const source = unwrap(api.loadPdf(loadFixture(fixture.source ?? manifest.source)));
            const expected = readAll(source);
            source.close();

            const encrypted = fixture.requiresPassword
                ? unwrap(api.loadPdfWithPassword(loadFixture(file), fixture.userPassword))
                : unwrap(api.loadPdf(loadFixture(file)));
            const actual = readAll(encrypted);
            encrypted.close();

            expect(actual.map((e) => e.encoding)).toEqual(expected.map((e) => e.encoding));
            actual.forEach((image, i) => expect(image.data).toEqual(expected[i].data));
            expect(actual.length).toBeGreaterThan(0);
        });
    }
});
