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

/** Consumer code using every public type, including the encryption API. */
const CONSUMER_TS = `
import {
    createQpdfImageStreams,
    type CreateOptions,
    type ErrorCode,
    type ImageInfo,
    type ImageMetadata,
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

function codeOf(result: Result<unknown>): ErrorCode | 'OK' {
    return result.ok ? 'OK' : result.code;
}

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
    void codeOf(encrypted);
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
import { createQpdfImageStreams } from '@lipoe/browser-qpdf';

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
        });
        const [packInfo] = JSON.parse(packOutput) as [{ filename: string; files: { path: string }[] }];
        packedFiles = packInfo.files.map((f) => f.path).sort();

        const consumerDir = join(workDir, 'consumer');
        mkdirSync(consumerDir);
        writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({ type: 'module', private: true }));
        execFileSync(
            'npm',
            ['install', '--offline', '--no-audit', '--no-fund', '--no-package-lock', join('..', packInfo.filename)],
            { cwd: consumerDir, encoding: 'utf8', shell: process.platform === 'win32' }
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

    it('contains exactly the runtime files, all type declarations and notices', () => {
        expect(packedFiles).toEqual(
            [
                'LICENSE',
                'README.md',
                'THIRD-PARTY-NOTICES',
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
        });
    });
});
