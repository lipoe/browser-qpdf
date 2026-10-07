/**
 * Characterization tests for unencrypted PDFs against the real WASM binary.
 *
 * These pin the behavior of v0.1.0 (metadata, stream data, round trips and
 * error texts). They must stay green unchanged when the encryption support
 * is extended.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
    createQpdfImageStreams,
    type QpdfImageStreams,
    type PdfDocument,
    type ImageInfo,
} from '../../src/index.js';
import { containsEncryptDict } from '../scenarios/encryption-scenarios.mjs';
import { loadFixture, pageCount, readJson, unwrap } from './helpers.js';

interface ExpectedImage {
    width: number;
    height: number;
    bitsPerComponent: number | null;
    colorSpace: string | null;
    filter: string | null;
    decodedStreamLength: number;
    rawStreamLength: number | null;
}

interface FixtureManifest {
    fixtures: Record<
        string,
        {
            pageCount: number;
            expectedImages: ExpectedImage[] | { recursive_false: ExpectedImage[]; recursive_true: ExpectedImage[] };
        }
    >;
}

const manifest = readJson<FixtureManifest>('manifest.json');
const FIXTURE_NAMES = Object.keys(manifest.fixtures);

function expectedImagesOf(name: string, recursive: boolean): ExpectedImage[] {
    const images = manifest.fixtures[name].expectedImages;
    if (Array.isArray(images)) return images;
    return recursive ? images.recursive_true : images.recursive_false;
}


/** Image metadata without object location and encoded length (both change when writing). */
function withoutLocation(info: ImageInfo) {
    const { objId: _objId, generation: _generation, streamLength: _streamLength, ...shape } = info;
    return shape;
}

/**
 * Expected metadata after writePdf(): QPDFWriter renumbers objects and
 * compresses previously unfiltered streams with FlateDecode (qpdf default).
 */
function writtenShape(info: ImageInfo) {
    return { ...withoutLocation(info), filter: info.filter ?? '/FlateDecode' };
}

function imagesOf(doc: PdfDocument, recursive = false): ImageInfo[] {
    return unwrap(doc.getImages({ recursive }));
}

describe('Unencrypted PDFs (real WASM, characterization)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    function open(name: string): PdfDocument {
        return unwrap(api.loadPdf(loadFixture(name)));
    }

    describe.each(FIXTURE_NAMES)('%s', (name) => {
        it('loads with the expected page count', async () => {
            const doc = open(name);
            doc.close();
            expect(await pageCount(loadFixture(name))).toBe(manifest.fixtures[name].pageCount);
        });

        it.each([false, true])('getImages(recursive=%s) matches the manifest', (recursive) => {
            const doc = open(name);
            const images = imagesOf(doc, recursive);
            const expected = expectedImagesOf(name, recursive);

            expect(images).toHaveLength(expected.length);
            images.forEach((info, i) => {
                expect(info).toEqual({
                    objId: expect.any(Number),
                    generation: 0,
                    width: expected[i].width,
                    height: expected[i].height,
                    bitsPerComponent: expected[i].bitsPerComponent,
                    colorSpace: expected[i].colorSpace,
                    filter: expected[i].filter,
                    streamLength: expected[i].rawStreamLength ?? expect.any(Number),
                });
            });
            doc.close();
        });

        it('returns decoded and raw stream data with the expected lengths', () => {
            const doc = open(name);
            const expected = expectedImagesOf(name, true);
            imagesOf(doc, true).forEach((info, i) => {
                const decoded = unwrap(doc.getImageStreamData(info.objId, info.generation));
                const raw = unwrap(doc.getRawImageStreamData(info.objId, info.generation));
                expect(decoded.byteLength).toBe(expected[i].decodedStreamLength);
                expect(raw.byteLength).toBe(expected[i].rawStreamLength ?? info.streamLength);
            });
            doc.close();
        });

        it('writePdf() keeps pages, image order and pixel data; output is unencrypted', async () => {
            const doc = open(name);
            const before = imagesOf(doc, true).map((info) => ({
                info,
                decoded: unwrap(doc.getImageStreamData(info.objId, info.generation)),
            }));
            const written = unwrap(doc.writePdf());
            doc.close();

            expect(containsEncryptDict(written)).toBe(false);
            expect(await pageCount(written)).toBe(manifest.fixtures[name].pageCount);

            const reloaded = unwrap(api.loadPdf(written));
            const after = imagesOf(reloaded, true);
            expect(after.map(withoutLocation)).toEqual(before.map((b) => writtenShape(b.info)));
            after.forEach((info, i) =>
                expect(unwrap(reloaded.getImageStreamData(info.objId, info.generation))).toEqual(before[i].decoded)
            );
            reloaded.close();
        });
    });

    describe('replaceImageStream + writePdf', () => {
        it('replaces data and metadata of one image and leaves the others untouched', () => {
            const doc = open('multi-image.pdf');
            const [first, ...others] = imagesOf(doc);
            const othersDecoded = others.map((info) => unwrap(doc.getImageStreamData(info.objId, info.generation)));
            const replacement = new Uint8Array(2 * 2 * 1).fill(0x7f);

            expect(
                doc.replaceImageStream(first.objId, first.generation, replacement, {
                    width: 2,
                    height: 2,
                    colorSpace: 'DeviceGray',
                })
            ).toEqual({ ok: true, value: undefined });

            const reloaded = unwrap(api.loadPdf(unwrap(doc.writePdf())));
            doc.close();
            const [firstAfter, ...othersAfter] = imagesOf(reloaded);
            expect(withoutLocation(firstAfter)).toEqual(
                writtenShape({ ...first, width: 2, height: 2, colorSpace: '/DeviceGray' })
            );
            expect(unwrap(reloaded.getImageStreamData(firstAfter.objId, firstAfter.generation))).toEqual(replacement);
            expect(othersAfter.map(withoutLocation)).toEqual(others.map(writtenShape));
            othersAfter.forEach((info, i) =>
                expect(unwrap(reloaded.getImageStreamData(info.objId, info.generation))).toEqual(othersDecoded[i])
            );
            reloaded.close();
        });

        it('accepts JPEG data with DCTDecode filter and new metadata', () => {
            const jpegDoc = open('jpeg-compressed.pdf');
            const [jpegInfo] = imagesOf(jpegDoc);
            const jpeg = unwrap(jpegDoc.getRawImageStreamData(jpegInfo.objId, jpegInfo.generation));
            jpegDoc.close();

            const doc = open('simple-one-image.pdf');
            const [target] = imagesOf(doc);
            expect(
                doc.replaceImageStream(target.objId, target.generation, jpeg, {
                    width: 2,
                    height: 2,
                    colorSpace: '/DeviceGray',
                    filter: '/DCTDecode',
                }).ok
            ).toBe(true);
            const reloaded = unwrap(api.loadPdf(unwrap(doc.writePdf())));
            doc.close();

            const [after] = imagesOf(reloaded);
            expect(after).toMatchObject({ filter: '/DCTDecode', colorSpace: '/DeviceGray', streamLength: jpeg.byteLength });
            expect(unwrap(reloaded.getRawImageStreamData(after.objId, after.generation))).toEqual(jpeg);
            expect(unwrap(reloaded.getImageStreamData(after.objId, after.generation)).byteLength).toBe(4);
            reloaded.close();
        });
    });

    describe('loadPdfWithPassword on an unencrypted PDF', () => {
        it('ignores the password', () => {
            const result = api.loadPdfWithPassword(loadFixture('multi-image.pdf'), 'irrelevant');
            expect(result.ok).toBe(true);
            if (result.ok) result.value.close();
        });
    });

    describe('error results (codes are the contract; texts unchanged since v0.1.0)', () => {
        it.each([
            ['empty input', new Uint8Array(0)],
            ['random bytes', new Uint8Array([1, 2, 3, 4, 5])],
            ['truncated PDF', loadFixture('multi-image.pdf').slice(0, 400)],
        ])('loadPdf rejects %s', (_label, bytes) => {
            expect(api.loadPdf(bytes)).toEqual({ ok: false, code: 'INVALID_INPUT', error: "input.pdf: can't find startxref" });
        });

        it('rejects wrong option and metadata types as INVALID_INPUT instead of coercing them', () => {
            const doc = open('nested-forms.pdf');
            const [image] = imagesOf(doc);
            const invalid = (error: string) => ({ ok: false, code: 'INVALID_INPUT', error });

            // previously treated as recursive: true
            expect(doc.getImages({ recursive: 'false' as unknown as boolean })).toEqual(
                invalid('Invalid option: recursive must be a boolean')
            );
            // previously coerced / truncated
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { width: '5' as unknown as number })).toEqual(
                invalid('Invalid metadata: width must be an integer')
            );
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { height: 1.5 })).toEqual(
                invalid('Invalid metadata: height must be an integer')
            );
            // regression: threw a TypeError instead of returning a Result
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { filter: 5 as unknown as string })).toEqual(
                invalid('Invalid metadata: filter must be a string')
            );
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), 'x' as never)).toEqual(
                invalid('Invalid metadata: must be an object')
            );
            // 32-bit overflow: 2^32 + objId used to address object objId, and a
            // width >= 2^31 was silently ignored
            const wrapped = 2 ** 32 + image.objId;
            expect(doc.getRawImageStreamData(wrapped, 0)).toEqual(invalid('Invalid object ID'));
            expect(doc.replaceImageStream(wrapped, 0, new Uint8Array(1))).toEqual(invalid('Invalid object ID'));
            expect(doc.getImageStreamData(image.objId, 2 ** 31)).toEqual(invalid('Invalid generation number'));
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { width: 2 ** 31 })).toEqual(
                invalid('Invalid metadata: width must not exceed 2147483647')
            );
            // the largest representable value is still accepted and reaches qpdf
            expect(doc.getImageStreamData(2 ** 31 - 1, 0)).toEqual(
                invalid('Object 2147483647 0 is not a stream')
            );
            // 0 / '' were the internal "keep original" markers and silently ignored
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { width: 0 })).toEqual(
                invalid('Invalid metadata: width must not be 0 (omit it to keep the original)')
            );
            expect(doc.replaceImageStream(image.objId, 0, new Uint8Array(1), { colorSpace: '' })).toEqual(
                invalid('Invalid metadata: colorSpace must not be empty (omit it to keep the original)')
            );
            // the document is unchanged by rejected calls
            expect(imagesOf(doc)).toEqual([image]);
            doc.close();
        });

        it('rejects invalid password and write option types as INVALID_INPUT (not Embind errors)', () => {
            const pdf = loadFixture('aes128-user.pdf');
            expect(api.loadPdfWithPassword(pdf, undefined as unknown as string)).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Password must be a string',
            });

            const doc = unwrap(api.loadPdfWithPassword(pdf, 'geheim'));
            expect(doc.writePdf({ preserveEncryption: 'false' as unknown as boolean })).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Invalid option: preserveEncryption must be a boolean',
            });
            doc.close();
        });

        it('rejects non-Uint8Array input', () => {
            expect(api.loadPdf([1, 2, 3] as unknown as Uint8Array)).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Input must be a Uint8Array',
            });
            expect(api.loadPdfWithPassword('x' as unknown as Uint8Array, 'pw')).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Input must be a Uint8Array',
            });
        });

        it('reports missing and non-stream objects', () => {
            const doc = open('multi-image.pdf');
            expect(doc.getImageStreamData(99, 0)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Object 99 0 is not a stream' });
            expect(doc.getRawImageStreamData(99, 0)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Object 99 0 is not a stream' });
            expect(doc.getImageStreamData(1, 0)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Object 1 0 is not a stream' });
            expect(doc.replaceImageStream(99, 0, new Uint8Array(1))).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Object is not a stream',
            });
            expect(doc.getImageStreamData(-1, 0)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Invalid object ID' });
            expect(doc.getRawImageStreamData(1, 1.5)).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Invalid generation number' });
            expect(doc.replaceImageStream(7, 0, [1] as unknown as Uint8Array)).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Data must be a Uint8Array',
            });
            expect(doc.replaceImageStream(7, 0, new Uint8Array(1), { width: -1 })).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Invalid metadata: width must not be negative',
            });
            doc.close();
        });

        it('returns the disposed error for every operation after close()', () => {
            const doc = open('multi-image.pdf');
            doc.close();
            doc.close(); // idempotent
            const disposed = { ok: false, code: 'DISPOSED', error: 'Instance has been disposed' };
            expect(doc.getImages()).toEqual(disposed);
            expect(doc.getImageStreamData(7, 0)).toEqual(disposed);
            expect(doc.getRawImageStreamData(7, 0)).toEqual(disposed);
            expect(doc.replaceImageStream(7, 0, new Uint8Array(1))).toEqual(disposed);
            expect(doc.writePdf()).toEqual(disposed);
        });
    });
});
