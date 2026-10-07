/**
 * Unit tests for the error code contract (mocked WASM).
 *
 * The C++ wrapper reports a technical error `kind` derived from the exception
 * type; the TypeScript layer maps it to a public ErrorCode depending on the
 * operation. Messages are passed through unchanged.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createQpdfImageStreams, ERROR_CODES, type QpdfImageStreams, type PdfDocument } from '../../src/index.js';
import { RAW_ERROR_KINDS, errorCodeOf } from '../../src/errors.js';
import { mockWasm, resetMockWasm } from '../__mocks__/qpdf-image-stream.js';

const PDF = new Uint8Array([37, 80, 68, 70]);
const rawError = (kind: string | undefined, error = 'qpdf message') => ({ success: false, kind, error });

type MockKey = keyof typeof mockWasm;
const setMock = (key: MockKey, fn: (...args: unknown[]) => unknown) => {
    (mockWasm as Record<string, unknown>)[key] = fn;
};

describe('Error codes', () => {
    let qpdf: QpdfImageStreams;

    beforeEach(async () => {
        resetMockWasm();
        qpdf = await createQpdfImageStreams();
    });

    function openDoc(): PdfDocument {
        const result = qpdf.loadPdf(PDF);
        if (!result.ok) throw new Error(result.error);
        return result.value;
    }

    describe('loading', () => {
        it.each([
            ['password', 'loadPdf', 'PASSWORD_REQUIRED'],
            ['password', 'loadPdfWithPassword', 'INVALID_PASSWORD'],
            ['damaged_pdf', 'loadPdf', 'INVALID_INPUT'],
            ['damaged_pdf', 'loadPdfWithPassword', 'INVALID_INPUT'],
            ['invalid_argument', 'loadPdf', 'INVALID_INPUT'],
            ['disposed', 'loadPdf', 'DISPOSED'],
            ['unknown', 'loadPdf', 'UNKNOWN'],
            ['unknown', 'loadPdfWithPassword', 'UNKNOWN'],
            [undefined, 'loadPdf', 'UNKNOWN'],
            ['some-future-kind', 'loadPdfWithPassword', 'UNKNOWN'],
        ] as const)('kind %s from %s maps to %s', (kind, method, code) => {
            setMock('loadPdf', () => rawError(kind));
            setMock('loadPdfWithPassword', () => rawError(kind));

            const result =
                method === 'loadPdf' ? qpdf.loadPdf(PDF) : qpdf.loadPdfWithPassword(PDF, 'pw');

            expect(result).toEqual({ ok: false, code, error: 'qpdf message' });
        });

        it('uses the fallback message if the wrapper provides none', () => {
            setMock('loadPdf', () => ({ success: false, kind: 'unknown' }));
            expect(qpdf.loadPdf(PDF)).toEqual({ ok: false, code: 'UNKNOWN', error: 'Failed to load PDF' });
        });

        it('maps exceptions to UNKNOWN with the exception message', () => {
            setMock('loadPdfWithPassword', () => {
                throw new Error('WASM trap');
            });
            expect(qpdf.loadPdfWithPassword(PDF, 'pw')).toEqual({
                ok: false,
                code: 'UNKNOWN',
                error: 'WASM trap',
            });
        });

        it.each([
            ['loadPdf', () => qpdf.loadPdf('x' as unknown as Uint8Array)],
            ['loadPdfWithPassword', () => qpdf.loadPdfWithPassword([1] as unknown as Uint8Array, 'pw')],
        ])('%s input validation returns INVALID_INPUT', (_name, call) => {
            expect(call()).toEqual({ ok: false, code: 'INVALID_INPUT', error: 'Input must be a Uint8Array' });
        });

        it.each([undefined, null, 123, {}])('non-string password %s returns INVALID_INPUT', (password) => {
            let called = false;
            setMock('loadPdfWithPassword', () => {
                called = true;
                return { success: true };
            });
            expect(qpdf.loadPdfWithPassword(PDF, password as unknown as string)).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Password must be a string',
            });
            expect(called).toBe(false);
        });

        it('size limit returns INVALID_INPUT', () => {
            const oversized = Object.create(Uint8Array.prototype);
            Object.defineProperty(oversized, 'byteLength', { value: 256 * 1024 * 1024 + 1 });
            expect(qpdf.loadPdf(oversized)).toEqual({
                ok: false,
                code: 'INVALID_INPUT',
                error: 'Data exceeds 256 MB limit',
            });
        });
    });

    describe('document operations', () => {
        const operations: Array<[string, MockKey, (doc: PdfDocument) => unknown]> = [
            ['getImages', 'getImages', (doc) => doc.getImages()],
            ['getImageStreamData', 'getImageStreamData', (doc) => doc.getImageStreamData(1, 0)],
            ['getRawImageStreamData', 'getRawImageStreamData', (doc) => doc.getRawImageStreamData(1, 0)],
            ['replaceImageStream', 'replaceImageStream', (doc) => doc.replaceImageStream(1, 0, new Uint8Array(1))],
            ['isEncrypted', 'isEncrypted', (doc) => doc.isEncrypted()],
            ['writePdf', 'writePdf', (doc) => doc.writePdf()],
        ];

        const kindToCode = [
            ['invalid_argument', 'INVALID_INPUT'],
            ['damaged_pdf', 'INVALID_INPUT'],
            ['password', 'UNKNOWN'], // no caller-provided password involved
            ['disposed', 'DISPOSED'],
            ['unknown', 'UNKNOWN'],
            [undefined, 'UNKNOWN'],
        ] as const;

        it.each(operations)('%s maps wrapper error kinds', (_name, mockKey, call) => {
            for (const [kind, code] of kindToCode) {
                const doc = openDoc();
                setMock(mockKey, () => rawError(kind, 'msg'));
                expect(call(doc)).toEqual({ ok: false, code, error: 'msg' });
                doc.close();
            }
        });

        it.each(operations)('%s maps exceptions to UNKNOWN', (_name, mockKey, call) => {
            const doc = openDoc();
            setMock(mockKey, () => {
                throw new Error('boom');
            });
            expect(call(doc)).toEqual({ ok: false, code: 'UNKNOWN', error: 'boom' });
        });

        it.each(operations)('%s after close() returns DISPOSED without calling WASM', (_name, mockKey, call) => {
            const doc = openDoc();
            let called = false;
            setMock(mockKey, () => {
                called = true;
            });
            doc.close();
            expect(call(doc)).toEqual({ ok: false, code: 'DISPOSED', error: 'Instance has been disposed' });
            expect(called).toBe(false);
        });

        it.each([
            ['getImageStreamData', (doc: PdfDocument) => doc.getImageStreamData(-1, 0), 'Invalid object ID'],
            ['getImageStreamData', (doc: PdfDocument) => doc.getImageStreamData(2 ** 31, 0), 'Invalid object ID'],
            ['getRawImageStreamData', (doc: PdfDocument) => doc.getRawImageStreamData(1, 2 ** 31), 'Invalid generation number'],
            ['getRawImageStreamData', (doc: PdfDocument) => doc.getRawImageStreamData(1, 0.5), 'Invalid generation number'],
            [
                'replaceImageStream',
                (doc: PdfDocument) => doc.replaceImageStream(1, 0, 'x' as unknown as Uint8Array),
                'Data must be a Uint8Array',
            ],
            [
                'replaceImageStream',
                (doc: PdfDocument) => doc.replaceImageStream(1, 0, new Uint8Array(1), { height: -1 }),
                'Invalid metadata: height must not be negative',
            ],
        ])('%s argument validation returns INVALID_INPUT', (_name, call, error) => {
            expect(call(openDoc())).toEqual({ ok: false, code: 'INVALID_INPUT', error });
        });
    });

    describe('wrapper lifecycle', () => {
        function recordLifecycle(): string[] {
            const calls: string[] = [];
            setMock('close', () => calls.push('close'));
            setMock('delete', () => calls.push('delete'));
            return calls;
        }

        it('frees the wrapper when loading fails (e.g. wrong password retries)', () => {
            const calls = recordLifecycle();
            setMock('loadPdfWithPassword', () => rawError('password'));

            qpdf.loadPdfWithPassword(PDF, 'wrong');

            expect(calls).toEqual(['close', 'delete']);
        });

        it('frees the wrapper when loading throws', () => {
            const calls = recordLifecycle();
            setMock('loadPdf', () => {
                throw new Error('boom');
            });

            expect(qpdf.loadPdf(PDF)).toMatchObject({ ok: false, code: 'UNKNOWN' });
            expect(calls).toEqual(['close', 'delete']);
        });

        it('keeps the wrapper of a loaded document until close()', () => {
            const calls = recordLifecycle();

            const doc = openDoc();
            expect(calls).toEqual([]);
            doc.close();
            doc.close();
            expect(calls).toEqual(['close', 'delete']);
        });
    });
});

describe('writePdf options and isEncrypted', () => {
    let doc: PdfDocument;

    beforeEach(async () => {
        resetMockWasm();
        const loaded = (await createQpdfImageStreams()).loadPdf(PDF);
        if (!loaded.ok) throw new Error(loaded.error);
        doc = loaded.value;
    });

    it.each([
        ['no options', undefined, true],
        ['empty options', {}, true],
        ['preserveEncryption: true', { preserveEncryption: true }, true],
        ['preserveEncryption: false', { preserveEncryption: false }, false],
    ])('writePdf with %s passes preserveEncryption=%s', (_label, options, expected) => {
        let received: unknown;
        setMock('writePdf', (preserve) => {
            received = preserve;
            return new Uint8Array([1, 2, 3]);
        });
        expect(doc.writePdf(options)).toEqual({ ok: true, value: new Uint8Array([1, 2, 3]) });
        expect(received).toBe(expected);
    });

    it.each([
        [{ preserveEncryption: 'false' }, 'Invalid option: preserveEncryption must be a boolean'],
        [{ preserveEncryption: 0 }, 'Invalid option: preserveEncryption must be a boolean'],
        [{ preserveEncryption: null }, 'Invalid option: preserveEncryption must be a boolean'],
        [null, 'Invalid options: must be an object'],
        ['x', 'Invalid options: must be an object'],
    ])('writePdf(%j) returns INVALID_INPUT without calling WASM', (options, error) => {
        let called = false;
        setMock('writePdf', () => {
            called = true;
            return new Uint8Array(1);
        });
        expect(doc.writePdf(options as never)).toEqual({ ok: false, code: 'INVALID_INPUT', error });
        expect(called).toBe(false);
    });

    it.each([true, false])('isEncrypted returns %s from the wrapper', (value) => {
        setMock('isEncrypted', () => value);
        expect(doc.isEncrypted()).toEqual({ ok: true, value });
    });
});

describe('Error contract consistency', () => {
    it('ERROR_CODES cannot be modified at runtime', () => {
        expect(Object.isFrozen(ERROR_CODES)).toBe(true);
        expect(() => (ERROR_CODES as unknown as string[]).push('NEW')).toThrow(TypeError);
    });

    it('maps every wrapper error kind to a public code in every context', () => {
        for (const kind of RAW_ERROR_KINDS) {
            for (const context of ['loadPdf', 'loadPdfWithPassword', 'document'] as const) {
                expect(ERROR_CODES).toContain(errorCodeOf(kind, context));
            }
        }
    });

    it('documents exactly the exported error codes in the README table', () => {
        const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
        const documented = [...readme.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
        expect(documented).toEqual([...ERROR_CODES]);
    });
});

describe('Argument type validation (INVALID_INPUT, WASM not called)', () => {
    let doc: PdfDocument;
    let wasmCalled: boolean;

    beforeEach(async () => {
        resetMockWasm();
        const loaded = (await createQpdfImageStreams()).loadPdf(PDF);
        if (!loaded.ok) throw new Error(loaded.error);
        doc = loaded.value;
        wasmCalled = false;
        setMock('getImages', () => {
            wasmCalled = true;
            return [];
        });
        setMock('replaceImageStream', () => {
            wasmCalled = true;
            return { success: true };
        });
    });

    it.each([
        [null, 'Invalid options: must be an object'],
        [5, 'Invalid options: must be an object'],
        [{ recursive: 'false' }, 'Invalid option: recursive must be a boolean'],
        [{ recursive: 1 }, 'Invalid option: recursive must be a boolean'],
    ])('getImages(%j)', (options, error) => {
        expect(doc.getImages(options as never)).toEqual({ ok: false, code: 'INVALID_INPUT', error });
        expect(wasmCalled).toBe(false);
    });

    it.each([
        [null, 'Invalid metadata: must be an object'],
        ['x', 'Invalid metadata: must be an object'],
        [{ width: '5' }, 'Invalid metadata: width must be an integer'],
        [{ height: 1.5 }, 'Invalid metadata: height must be an integer'],
        [{ bitsPerComponent: NaN }, 'Invalid metadata: bitsPerComponent must be an integer'],
        [{ width: -1 }, 'Invalid metadata: width must not be negative'],
        [{ height: 2 ** 31 }, 'Invalid metadata: height must not exceed 2147483647'],
        [{ colorSpace: 5 }, 'Invalid metadata: colorSpace must be a string'],
        [{ filter: {} }, 'Invalid metadata: filter must be a string'],
    ])('replaceImageStream metadata %j', (metadata, error) => {
        expect(doc.replaceImageStream(1, 0, new Uint8Array(1), metadata as never)).toEqual({
            ok: false,
            code: 'INVALID_INPUT',
            error,
        });
        expect(wasmCalled).toBe(false);
    });

    it.each([
        [undefined],
        [{}],
        [{ width: 0, height: 10, bitsPerComponent: 8, colorSpace: '/DeviceRGB', filter: 'DCTDecode' }],
    ])('replaceImageStream accepts valid metadata %j', (metadata) => {
        expect(doc.replaceImageStream(1, 0, new Uint8Array(1), metadata as never)).toEqual({
            ok: true,
            value: undefined,
        });
        expect(wasmCalled).toBe(true);
    });
});
