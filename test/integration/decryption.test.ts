/**
 * Acceptance criteria for decrypting PDFs (real WASM):
 * bytes + password -> plain PDF bytes, without string matching on errors.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    createQpdfImageStreams,
    type ImageInfo,
    type QpdfImageStreams,
    type Result,
} from '../../src/index.js';
import { containsEncryptDict } from '../scenarios/encryption-scenarios.mjs';
import { loadFixture, pageCount, readJson } from './helpers.js';

interface EncryptedManifest {
    source: string;
    ownerPassword: string;
    fixtures: Record<string, { userPassword: string; requiresPassword: boolean }>;
}

const manifest = readJson<EncryptedManifest>('encrypted-manifest.json');
const FIXTURES = Object.entries(manifest.fixtures);
const PASSWORD_PROTECTED = FIXTURES.filter(([, f]) => f.requiresPassword);

function unwrap<T>(result: Result<T>): T {
    if (!result.ok) throw new Error(`unexpected error result: ${result.code} ${result.error}`);
    return result.value;
}

const shape = ({ objId: _o, generation: _g, streamLength: _s, ...rest }: ImageInfo) => rest;

describe('Decrypting PDFs (real WASM)', () => {
    let qpdf: QpdfImageStreams;
    let sourcePages: number;
    let sourceImages: ReturnType<typeof shape>[];

    beforeAll(async () => {
        qpdf = await createQpdfImageStreams();
        const source = loadFixture(manifest.source);
        sourcePages = await pageCount(source);
        const doc = unwrap(qpdf.loadPdf(source));
        sourceImages = unwrap(doc.getImages()).map(shape);
        doc.close();
    });

    /** Consumer code from the handoff, verbatim apart from the test harness. */
    function decryptPdf(bytes: Uint8Array, password: string): Result<Uint8Array> {
        const loaded = qpdf.loadPdfWithPassword(bytes, password);
        if (!loaded.ok) return loaded;
        const out = loaded.value.writePdf({ preserveEncryption: false });
        loaded.value.close();
        return out;
    }

    describe.each(PASSWORD_PROTECTED)('%s', (file, fixture) => {
        it('asks for a password via code, not via message text', () => {
            const withoutPassword = qpdf.loadPdf(loadFixture(file));
            expect(withoutPassword.ok || withoutPassword.code).toBe('PASSWORD_REQUIRED');

            const wrong = decryptPdf(loadFixture(file), 'falsch');
            expect(wrong.ok || wrong.code).toBe('INVALID_PASSWORD');
        });

        it.each([
            ['user', fixture.userPassword],
            ['owner', manifest.ownerPassword],
        ])('decrypts with the %s password to a plain PDF with identical pages and images', async (_kind, password) => {
            const plain = unwrap(decryptPdf(loadFixture(file), password));

            expect(containsEncryptDict(plain)).toBe(false);
            expect(await pageCount(plain)).toBe(sourcePages);

            const reloaded = unwrap(qpdf.loadPdf(plain));
            expect(unwrap(reloaded.isEncrypted())).toBe(false);
            expect(unwrap(reloaded.getImages()).map(shape)).toEqual(
                sourceImages.map((img) => ({ ...img, filter: img.filter ?? '/FlateDecode' }))
            );
            reloaded.close();
        });
    });

    describe.each(FIXTURES)('%s: isEncrypted() and writePdf() options', (file, fixture) => {
        function open() {
            return unwrap(
                fixture.requiresPassword
                    ? qpdf.loadPdfWithPassword(loadFixture(file), fixture.userPassword)
                    : qpdf.loadPdf(loadFixture(file))
            );
        }

        it('reports the source document as encrypted', () => {
            const doc = open();
            expect(doc.isEncrypted()).toEqual({ ok: true, value: true });
            doc.close();
        });

        it.each([
            ['no options', undefined],
            ['empty options', {}],
            ['preserveEncryption: true', { preserveEncryption: true }],
        ])('keeps the encryption with %s', (_label, options) => {
            const doc = open();
            const written = unwrap(doc.writePdf(options));
            doc.close();
            expect(containsEncryptDict(written)).toBe(true);
            const reloaded = qpdf.loadPdf(written);
            if (fixture.requiresPassword) {
                expect(reloaded.ok || reloaded.code).toBe('PASSWORD_REQUIRED');
            } else {
                expect(reloaded.ok && unwrap(reloaded.value.isEncrypted())).toBe(true);
            }
            if (reloaded.ok) reloaded.value.close();
        });
    });

    describe('unencrypted PDFs', () => {
        it.each(['simple-one-image.pdf', 'multi-image.pdf', 'no-images.pdf', 'jpeg-compressed.pdf', 'nested-forms.pdf'])(
            '%s: isEncrypted() is false and preserveEncryption makes no difference',
            async (file) => {
                const doc = unwrap(qpdf.loadPdf(loadFixture(file)));
                expect(doc.isEncrypted()).toEqual({ ok: true, value: false });
                const preserved = unwrap(doc.writePdf());
                const plain = unwrap(doc.writePdf({ preserveEncryption: false }));
                doc.close();
                expect(containsEncryptDict(preserved)).toBe(false);
                expect(containsEncryptDict(plain)).toBe(false);
                expect(await pageCount(plain)).toBe(await pageCount(preserved));
            }
        );

        it('isEncrypted() after close() returns DISPOSED', () => {
            const doc = unwrap(qpdf.loadPdf(loadFixture('multi-image.pdf')));
            doc.close();
            expect(doc.isEncrypted()).toEqual({
                ok: false,
                code: 'DISPOSED',
                error: 'Instance has been disposed',
            });
        });
    });
});
