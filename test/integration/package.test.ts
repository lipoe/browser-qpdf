/**
 * Verifies the published package as a consumer sees it: `npm pack` the
 * current dist/, install the tarball into a temporary consumer
 * project via npm install, type-check consumer code against the shipped .d.ts files and
 * run it in Node.
 *
 * Requires an up-to-date dist/ (`npm run build`).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES_DIR } from './helpers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * Environment for nested npm calls. When this test runs inside an npm
 * lifecycle (e.g. prepublishOnly of `npm publish --dry-run`), the dry-run
 * setting is inherited and `npm pack` would write no tarball. The variable
 * name's case varies (npm_config_dry_run / NPM_CONFIG_DRY_RUN) and Windows
 * treats both as one, so every spelling is removed.
 */
const NPM_ENV = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_dry_run')
);

/** Consumer code using every public type, including the encryption API. */
const CONSUMER_TS = `
import {
    createQpdfImageStreams,
    ERROR_CODES,
    type ColorSpaceFamily,
    type ColorSpaceInfo,
    type CreateOptions,
    type EncodedImage,
    type ErrorCode,
    type ImageEncoding,
    type ImageInfo,
    type ImageMaskInfo,
    type ImageMetadata,
    type ObjRef,
    type PageInfo,
    type PdfDocument,
    type QpdfImageStreams,
    type Result,
    type WriteOptions,
} from '@lipoe/browser-qpdf';

const options: CreateOptions = { locateFile: (name) => name };
const write: WriteOptions = { preserveEncryption: false };
const metadata: Partial<ImageMetadata> = { width: 1, filter: '/DCTDecode' };

function describeImage(info: ImageInfo): string {
    const length: number = info.streamLength;
    const objId: number = info.objId;
    const generation: number = info.generation;
    const width: number = info.width;
    const height: number = info.height;
    const bpc: number | null = info.bitsPerComponent;
    const colorSpace: string | null = info.colorSpace;
    const filter: string | null = info.filter;
    return [objId, generation, width, height, bpc, colorSpace, filter, length].join(' ');
}

/** Uses every 0.3.0 fact type, so a missing or renamed declaration fails to compile. */
function describeFacts(info: ImageInfo, doc?: PdfDocument): string {
    const cs: ColorSpaceInfo | null = info.colorSpaceInfo;
    const family: ColorSpaceFamily | null = cs ? cs.family : null;
    const lookup: Uint8Array | null = cs && cs.family === 'Indexed' ? cs.lookup : null;
    const masks: ImageMaskInfo = info.masks;
    const soft: ObjRef | null = masks.softMask;
    const pages: number[] = info.pages.concat(info.directPages);
    const read: Result<EncodedImage> | undefined = doc?.readImage(info.objId, info.generation);
    const encoding: ImageEncoding | undefined = read && read.ok ? read.value.encoding : undefined;
    const kind = encoding ? encoding.kind : 'none';
    const rows = encoding && encoding.kind === 'ccitt' ? encoding.rows : null;
    return [family, lookup?.length, soft?.objId, pages.length, kind, rows, info.filters.join('+'), info.decode].join(' ');
}

function codeOf(result: Result<unknown>): ErrorCode | 'OK' {
    return result.ok ? 'OK' : result.code;
}

const knownCodes: readonly ErrorCode[] = ERROR_CODES;

export async function decryptPdf(bytes: Uint8Array, password: string): Promise<Result<Uint8Array>> {
    const qpdf: QpdfImageStreams = await createQpdfImageStreams();
    const loaded = qpdf.loadPdfWithPassword(bytes, password);
    if (!loaded.ok && loaded.code === 'INVALID_PASSWORD') {
        return loaded;
    }
    if (!loaded.ok) return loaded;
    const doc: PdfDocument = loaded.value;
    const encrypted: Result<boolean> = doc.isEncrypted();
    const images = doc.getImages();
    if (images.ok) images.value.map(describeImage);
    if (images.ok) images.value.map((img) => describeFacts(img, doc));
    const pages: Result<number> = doc.getPageCount();
    const page: Result<PageInfo> = doc.getPageInfo(0);
    if (page.ok) { const box: { x: number; width: number } = page.value.mediaBox; void box; }
    void pages;
    void codeOf(encrypted);
    void knownCodes;
    void metadata;
    void options;
    const out = doc.writePdf(write);
    doc.close();
    return out;
}
`;

/** Node smoke test against the installed package. */
const CONSUMER_MJS = `
import { readFileSync } from 'node:fs';
import { createQpdfImageStreams, ERROR_CODES } from '@lipoe/browser-qpdf';

const [fixture, password] = process.argv.slice(2);
const qpdf = await createQpdfImageStreams();
const bytes = new Uint8Array(readFileSync(fixture));
const required = qpdf.loadPdf(bytes);
const wrong = qpdf.loadPdfWithPassword(bytes, 'falsch');
const loaded = qpdf.loadPdfWithPassword(bytes, password);
const plain = loaded.value.writePdf({ preserveEncryption: false });
const reloaded = qpdf.loadPdf(plain.value);
console.log(JSON.stringify({
    required: required.code,
    wrong: wrong.code,
    plainOpens: reloaded.ok,
    plainEncrypted: reloaded.ok && reloaded.value.isEncrypted().value,
    images: reloaded.ok && reloaded.value.getImages().value.length,
    errorCodes: ERROR_CODES,
}));
`;

describe('Published package (npm pack)', () => {
    let workDir: string;
    let packedFiles: string[];

    beforeAll(() => {
        workDir = mkdtempSync(join(tmpdir(), 'browser-qpdf-pack-'));
        const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', workDir], {
            cwd: ROOT,
            encoding: 'utf8',
            shell: process.platform === 'win32',
            env: NPM_ENV,
        });
        const [packInfo] = JSON.parse(packOutput) as [{ filename: string; files: { path: string }[] }];
        packedFiles = packInfo.files.map((f) => f.path).sort();

        const consumerDir = join(workDir, 'consumer');
        mkdirSync(consumerDir);
        writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        execFileSync(
            'npm',
            ['install', '--offline', '--no-audit', '--no-fund', '--no-package-lock', join('..', packInfo.filename)],
            { cwd: consumerDir, encoding: 'utf8', shell: process.platform === 'win32', env: NPM_ENV }
        );

        writeFileSync(join(consumerDir, 'consumer.ts'), CONSUMER_TS);
        writeFileSync(join(consumerDir, 'consumer.mjs'), CONSUMER_MJS);
        writeFileSync(
            join(consumerDir, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    noEmit: true,
                    skipLibCheck: false,
                    types: [],
                },
                files: ['consumer.ts'],
            })
        );
    }, 60_000);

    afterAll(() => {
        if (workDir) rmSync(workDir, { recursive: true, force: true });
    });

    it('contains exactly the runtime modules, all type declarations and notices', () => {
        expect(packedFiles).toEqual(
            [
                'LICENSE',
                'README.md',
                'THIRD-PARTY-NOTICES',
                'dist/errors.d.ts',
                'dist/errors.js',
                'dist/index.d.ts',
                'dist/index.js',
                'dist/qpdf-image-stream.js',
                'dist/qpdf-image-stream.wasm',
                'dist/types.d.ts',
                'package.json',
            ].sort()
        );
    });

    it('type-checks consumer code against the shipped declarations (incl. skipLibCheck=false)', () => {
        const consumerDir = join(workDir, 'consumer');
        let output = '';
        try {
            execFileSync(process.execPath, [TSC, '-p', consumerDir], { encoding: 'utf8' });
        } catch (err) {
            output = String((err as { stdout?: string }).stdout ?? err);
        }
        expect(output).toBe('');
    });

    it('decrypts a PDF when installed as a dependency (Node)', () => {
        const consumerDir = join(workDir, 'consumer');
        const output = execFileSync(
            process.execPath,
            ['consumer.mjs', join(FIXTURES_DIR, 'aes256-user.pdf'), 'geheim'],
            { cwd: consumerDir, encoding: 'utf8' }
        );
        expect(JSON.parse(output)).toEqual({
            required: 'PASSWORD_REQUIRED',
            wrong: 'INVALID_PASSWORD',
            plainOpens: true,
            plainEncrypted: false,
            images: 3,
            errorCodes: ['PASSWORD_REQUIRED', 'INVALID_PASSWORD', 'INVALID_INPUT', 'DISPOSED', 'UNKNOWN'],
        });
    });
});
