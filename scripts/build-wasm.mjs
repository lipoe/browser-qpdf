/**
 * Builds the WASM module in Docker and copies the artifacts to dist/.
 * Works on Windows, macOS and Linux (no shell-specific path syntax).
 *
 * Usage: npm run build:wasm
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const IMAGE = 'qpdf-wasm-builder';

function docker(args) {
    execFileSync('docker', args, { cwd: ROOT, stdio: 'inherit' });
}

mkdirSync(DIST, { recursive: true });
docker(['build', '-t', IMAGE, '.']);
docker(['run', '--rm', '-v', `${DIST}:/out`, IMAGE]);
