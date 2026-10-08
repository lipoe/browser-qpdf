/**
 * generate-encrypted-fixtures.mjs
 *
 * Generates encrypted PDF fixtures from multi-image.pdf (2 pages, 3 images)
 * using the qpdf CLI. Uses a local `qpdf` binary if available, otherwise runs
 * qpdf inside a Debian Docker container.
 *
 * Streams are not recompressed (--compress-streams=n, --decode-level=none) so
 * that image metadata of every fixture matches multi-image.pdf exactly.
 *
 * Writes the PDFs plus encrypted-manifest.json (expected properties and the
 * qpdf version used) into test/fixtures/.
 *
 * Reproducibility: the Docker image is pinned by digest, and generation fails
 * if the qpdf version differs from QPDF_VERSION (the Debian package repository
 * can change independently of the image). Update both deliberately.
 *
 * Fixtures may name their own `source`; the default is multi-image.pdf.
 *
 * Usage: node test/fixtures/generate-encrypted-fixtures.mjs [--only <file>]
 *   --only  generate just that fixture (the manifest is always written in full)
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = 'multi-image.pdf';
// debian:trixie-slim, pinned by digest
const DOCKER_IMAGE =
    'debian@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f';
const QPDF_VERSION = 'qpdf version 12.2.0';

const USER_PASSWORD = 'geheim';
const OWNER_PASSWORD = 'owner';

/** Each fixture: file name, qpdf --encrypt arguments, expected properties. */
const FIXTURES = [
    {
        file: 'aes256-user.pdf',
        encrypt: [USER_PASSWORD, OWNER_PASSWORD, '256'],
        algorithm: 'AES-256',
        userPassword: USER_PASSWORD,
    },
    {
        file: 'aes128-user.pdf',
        encrypt: [USER_PASSWORD, OWNER_PASSWORD, '128', '--use-aes=y'],
        algorithm: 'AES-128',
        userPassword: USER_PASSWORD,
    },
    {
        file: 'rc4-128-user.pdf',
        encrypt: [USER_PASSWORD, OWNER_PASSWORD, '128', '--use-aes=n'],
        weak: true,
        algorithm: 'RC4-128',
        userPassword: USER_PASSWORD,
    },
    {
        file: 'rc4-40-user.pdf',
        encrypt: [USER_PASSWORD, OWNER_PASSWORD, '40'],
        weak: true,
        algorithm: 'RC4-40',
        userPassword: USER_PASSWORD,
    },
    {
        file: 'aes256-owner-only.pdf',
        encrypt: ['', OWNER_PASSWORD, '256', '--print=none'],
        algorithm: 'AES-256',
        userPassword: '',
    },
    {
        file: 'aes128-owner-only.pdf',
        encrypt: ['', OWNER_PASSWORD, '128', '--use-aes=y', '--print=none'],
        algorithm: 'AES-128',
        userPassword: '',
    },
    // A Flate + DCT chain under encryption: exercises readImage's scratch path
    // on decrypted raw bytes. Not part of the encryption scenarios (different source).
    {
        file: 'aes256-jpeg-chain.pdf',
        source: 'flate-dct-chain.pdf',
        encrypt: [USER_PASSWORD, OWNER_PASSWORD, '256'],
        algorithm: 'AES-256',
        userPassword: USER_PASSWORD,
    },
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const TO_GENERATE = only ? FIXTURES.filter((f) => f.file === only) : FIXTURES;
if (only && TO_GENERATE.length === 0) throw new Error(`unknown fixture: ${only}`);

function hasLocalQpdf() {
    try {
        execFileSync('qpdf', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

function qpdfArgs(fixture) {
    return [
        '--compress-streams=n',
        '--decode-level=none',
        ...(fixture.weak ? ['--allow-weak-crypto'] : []),
        '--encrypt',
        ...fixture.encrypt,
        '--',
        fixture.source ?? SOURCE,
        fixture.file,
    ];
}

function shellQuote(arg) {
    return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function firstLine(text) {
    return text.split('\n')[0].trim();
}

function versionMismatch(found) {
    return new Error(
        `Expected ${QPDF_VERSION}, found ${found}. ` +
            'Update QPDF_VERSION deliberately and review the regenerated fixtures.'
    );
}

function generate() {
    let qpdfVersion;

    if (hasLocalQpdf()) {
        qpdfVersion = firstLine(execFileSync('qpdf', ['--version'], { encoding: 'utf8' }));
        if (qpdfVersion !== QPDF_VERSION) throw versionMismatch(qpdfVersion);
        for (const fixture of TO_GENERATE) {
            execFileSync('qpdf', qpdfArgs(fixture), { cwd: FIXTURES_DIR, stdio: 'inherit' });
        }
    } else {
        const commands = [
            'export DEBIAN_FRONTEND=noninteractive',
            'apt-get update -qq >/dev/null',
            'apt-get install -y -qq qpdf >/dev/null',
            'qpdf --version | head -n 1',
            `test "$(qpdf --version | head -n 1)" = ${shellQuote(QPDF_VERSION)}`,
            ...TO_GENERATE.map((f) => ['qpdf', ...qpdfArgs(f)].map(shellQuote).join(' ')),
        ];
        let output;
        try {
            output = execFileSync(
                'docker',
                ['run', '--rm', '-v', `${FIXTURES_DIR}:/fixtures`, '-w', '/fixtures', DOCKER_IMAGE,
                    'sh', '-c', commands.join(' && ')],
                { encoding: 'utf8' }
            );
        } catch (err) {
            const found = firstLine(String(err.stdout ?? ''));
            if (found && found !== QPDF_VERSION) throw versionMismatch(found);
            throw err;
        }
        qpdfVersion = firstLine(output);
    }

    const manifest = {
        description:
            'Encrypted variants of multi-image.pdf (same pages and images). Generated by generate-encrypted-fixtures.mjs.',
        source: SOURCE,
        generator: qpdfVersion,
        ownerPassword: OWNER_PASSWORD,
        fixtures: Object.fromEntries(
            FIXTURES.map((f) => [
                f.file,
                {
                    source: f.source ?? SOURCE,
                    algorithm: f.algorithm,
                    userPassword: f.userPassword,
                    requiresPassword: f.userPassword !== '',
                },
            ])
        ),
    };
    writeFileSync(
        `${FIXTURES_DIR}/encrypted-manifest.json`,
        JSON.stringify(manifest, null, 2) + '\n'
    );
    console.log(`Generated ${TO_GENERATE.length} encrypted fixture(s) with ${manifest.generator}`);
}

generate();
