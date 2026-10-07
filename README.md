# @lipoe/browser-qpdf

Browser-compatible WASM module exposing qpdf's library API for reading and replacing PDF image streams.

## Features

- Load PDFs (with or without password) entirely in-browser via WebAssembly
- Encrypted PDFs: RC4 40/128-bit, AES-128 and AES-256; owner-password-only PDFs load without password
- Decrypt PDFs (`writePdf({ preserveEncryption: false })`)
- Machine-readable error codes (`PASSWORD_REQUIRED`, `INVALID_PASSWORD`, ...)
- Enumerate image XObjects with full metadata (dimensions, color space, filter, stream length)
- Read decoded or raw image stream data
- Replace image streams with new content and metadata
- Write modified PDFs back to `Uint8Array`
- No filesystem dependencies — works in browsers, web workers and Node >= 18 (random data comes from `crypto.getRandomValues`)

## Prerequisites

- [Docker](https://www.docker.com/) (for building the WASM module)
- [Node.js](https://nodejs.org/) >= 18
- npm

## Building

The WASM compilation runs inside a Docker container with Emscripten pre-configured.
qpdf is pinned to a release tag (`ARG QPDF_VERSION` in the `Dockerfile`, currently `v12.4.2`)
and cloned inside the image; zlib and libjpeg-turbo are git submodules.

```bash
# 1. Fetch the submodules (zlib, libjpeg-turbo)
git submodule update --init

# 2. Build the Docker image (dependencies are built and cached in an image layer)
docker build -t qpdf-wasm-builder .

# 3. Compile WASM (artifacts land in ./dist); re-run 2 + 3 after changing src/wrapper.cpp
# PowerShell:
docker run --rm -v "${PWD}\dist:/out" qpdf-wasm-builder
# Bash:
docker run --rm -v "$(pwd)/dist:/out" qpdf-wasm-builder

# 4. Install dependencies
npm install

# 5. Build TypeScript wrapper
npm run build
```

After this you should have `dist/qpdf-image-stream.js`, `dist/qpdf-image-stream.wasm`, `dist/index.js`, `dist/index.d.ts` and `dist/types.d.ts`.

## Usage

```typescript
import { createQpdfImageStreams } from '@lipoe/browser-qpdf';

const qpdf = await createQpdfImageStreams();

// Load a PDF
const pdfBytes = new Uint8Array(/* ... */);
const result = qpdf.loadPdf(pdfBytes);

if (result.ok) {
    const doc = result.value;

    // List all images
    const images = doc.getImages();
    if (images.ok) {
        for (const img of images.value) {
            console.log(`Image ${img.objId}: ${img.width}x${img.height}, ${img.filter}`);
        }
    }

    // Read decoded image stream data
    const streamData = doc.getImageStreamData(images.value[0].objId, images.value[0].generation);

    // Replace an image stream
    doc.replaceImageStream(objId, generation, newImageData, {
        width: 800,
        height: 600,
        colorSpace: 'DeviceRGB',
        filter: 'DCTDecode',
    });

    // Write modified PDF
    const output = doc.writePdf();
    if (output.ok) {
        // output.value is a Uint8Array with the new PDF
    }

    // Release WASM memory
    doc.close();
}
```

### Password-protected PDFs

```typescript
const result = qpdf.loadPdfWithPassword(pdfBytes, 'secret');
```

`loadPdf` (without password) also opens encrypted PDFs that have no open
password ("owner password only", i.e. only permissions are restricted).
Both the user and the owner password are accepted by `loadPdfWithPassword`.

Errors carry a machine-readable `code`, so no message text needs to be checked:

```typescript
const loaded = qpdf.loadPdf(pdfBytes);
if (!loaded.ok && loaded.code === 'PASSWORD_REQUIRED') {
    // ask the user for a password
}

const retry = qpdf.loadPdfWithPassword(pdfBytes, password);
if (!retry.ok && retry.code === 'INVALID_PASSWORD') {
    // ask again
}
```

### Decrypting PDFs

By default `writePdf()` keeps the encryption of the source PDF (e.g. after
replacing images). To write an unencrypted copy, open the document and pass
`preserveEncryption: false`:

```typescript
function decryptPdf(bytes: Uint8Array, password: string): Result<Uint8Array> {
    const loaded = qpdf.loadPdfWithPassword(bytes, password);
    if (!loaded.ok) return loaded; // loaded.code: 'INVALID_PASSWORD', 'INVALID_INPUT', ...
    const plain = loaded.value.writePdf({ preserveEncryption: false });
    loaded.value.close();
    return plain;
}
```

`doc.isEncrypted()` tells whether the loaded source PDF is encrypted.

### Custom WASM location

```typescript
const qpdf = await createQpdfImageStreams({
    locateFile: (filename) => `/assets/wasm/${filename}`,
});
```

## Bundler Usage (Vite, Webpack, etc.)

When using this package with a bundler, the WASM file cannot be resolved automatically. You need to tell the library where to find it using `locateFile`.

### Vite

```typescript
// Import the WASM URL as a static asset
import wasmUrl from '@lipoe/browser-qpdf/qpdf-image-stream.wasm?url';
import { createQpdfImageStreams } from '@lipoe/browser-qpdf';

const qpdf = await createQpdfImageStreams({
    locateFile: (name) => name.endsWith('.wasm') ? wasmUrl : name,
});
```

In your `vite.config.ts`:

```typescript
export default defineConfig({
    assetsInclude: ['**/*.wasm'],
    optimizeDeps: {
        exclude: ['@lipoe/browser-qpdf'],
    },
});
```

### Webpack / other bundlers

Copy the `.wasm` file to your public/static directory and point `locateFile` to it:

```typescript
import { createQpdfImageStreams } from '@lipoe/browser-qpdf';

const qpdf = await createQpdfImageStreams({
    locateFile: (filename) => `/static/${filename}`,
});
```

### Why is `locateFile` needed?

Emscripten's generated glue code resolves the `.wasm` file relative to the JS module. After bundling, the JS is typically relocated/renamed while the `.wasm` stays behind, breaking the relative path. `locateFile` gives you explicit control over where the WASM is loaded from.

## Playground

A browser-based playground is included for quick testing:

```bash
npm run playground
```

This serves the project root with a static file server. Open the displayed URL and navigate to `playground/index.html`.

## Local development (npm link)

To use this package locally in another project:

```bash
# In this repo
npm link

# In your consumer project
npm link @lipoe/browser-qpdf
```

## Testing

```bash
npm test                  # unit (mocked WASM) + integration (real WASM in dist/)
npm run test:unit         # only the TypeScript wrapper against a mocked WASM module
npm run test:integration  # real WASM in Node, incl. an npm pack + install check
npm run test:browser      # real WASM in Chromium and Firefox, main thread and Web Worker
npm run test:all          # build + all of the above
```

Integration and browser tests need a built `dist/` (WASM + `npm run build`).
The WASM build writes `dist/build-info.json` (hashes of `src/wrapper.cpp` and
`build-wasm.sh`, qpdf version); an integration test fails if `dist/` is stale,
so a test run can never silently check an outdated binary.
Browser tests need Playwright browsers once: `npx playwright install chromium firefox`.

The encryption behavior is described by one expectation table
(`test/scenarios/expected-observations.mjs`) that Node, browser and worker
tests share. Encrypted fixtures are generated from `multi-image.pdf` with the
qpdf CLI (local or via Docker): `npm run fixtures:encrypted`.

## API

All load and document operations return a `Result<T>` and never throw (`close()` returns nothing and never throws either). The only exception is the factory `createQpdfImageStreams()`, whose promise rejects if the WASM module cannot be loaded:

```typescript
type Result<T> =
    | { ok: true; value: T }
    | { ok: false; code: ErrorCode; error: string };
```

`code` is the stable contract; `error` is a human-readable message whose
wording may change.

| `code` | Meaning |
|---|---|
| `PASSWORD_REQUIRED` | `loadPdf` on a PDF that needs a password to open |
| `INVALID_PASSWORD` | `loadPdfWithPassword` with a password that does not open the PDF (also an empty password) |
| `INVALID_INPUT` | Invalid arguments (wrong type, 256 MB limit, object ID/generation, negative or non-integer metadata, object is not a stream) or data that cannot be read as a PDF |
| `DISPOSED` | The document was already closed |
| `UNKNOWN` | Anything else, see `error` |

New codes may be added in minor versions; treat unknown codes like `UNKNOWN`.
All codes are also exported at runtime:

```typescript
import { ERROR_CODES, type ErrorCode } from '@lipoe/browser-qpdf';
// ERROR_CODES: readonly ['PASSWORD_REQUIRED', 'INVALID_PASSWORD', 'INVALID_INPUT', 'DISPOSED', 'UNKNOWN']
```

### `createQpdfImageStreams(options?): Promise<QpdfImageStreams>`

Factory function that loads and initializes the WASM module.

### `QpdfImageStreams.loadPdf(data): Result<PdfDocument>`

Load a PDF from a `Uint8Array` without password. Encrypted PDFs without an
open password load as well; otherwise fails with `PASSWORD_REQUIRED`.

### `QpdfImageStreams.loadPdfWithPassword(data, password): Result<PdfDocument>`

Load a password-protected PDF with its user or owner password. Fails with
`INVALID_PASSWORD` if the password does not open the PDF. The password is
ignored for unencrypted PDFs.

### `PdfDocument.getImages(options?): Result<ImageInfo[]>`

Enumerate all image XObjects. Pass `{ recursive: true }` to include nested images.

> **Known limitation:** errors while traversing the pages (e.g. a damaged page
> tree) are not reported. `getImages()` then returns `ok: true` with the images
> found up to that point, so the list can be incomplete for damaged PDFs.
> This behavior is kept for compatibility with 0.1.0.

### `PdfDocument.getImageStreamData(objId, generation): Result<Uint8Array>`

Read decoded (decompressed) image stream data.

### `PdfDocument.getRawImageStreamData(objId, generation): Result<Uint8Array>`

Read raw (compressed) image stream data.

### `PdfDocument.replaceImageStream(objId, generation, data, metadata?): Result<void>`

Replace image stream content. Omitted metadata fields preserve original values.

Metadata fields:
- `width` / `height` — new pixel dimensions
- `bitsPerComponent` — bits per color component (e.g. 8)
- `colorSpace` — PDF color space name without leading slash (e.g. `'DeviceRGB'`, `'DeviceGray'`)
- `filter` — PDF filter name without leading slash (e.g. `'DCTDecode'` for JPEG, `'FlateDecode'` for zlib)

Both `filter` and `colorSpace` accept values with or without a leading `/` — the library normalizes automatically.

### `PdfDocument.isEncrypted(): Result<boolean>`

Whether the loaded source PDF is encrypted (not the output of `writePdf`).

### `PdfDocument.writePdf(options?): Result<Uint8Array>`

Serialize the (possibly modified) PDF to a new `Uint8Array`.

Options:
- `preserveEncryption` (default `true`) — keep the encryption of the source PDF.
  `false` writes an unencrypted PDF.

Like qpdf's default, writing renumbers objects and compresses previously
unfiltered streams with `FlateDecode`; image pixel data is unchanged.

### `PdfDocument.close(): void`

Release all WASM memory. After this call, all other methods return a `DISPOSED` error. Multiple calls are no-ops.

## License

Apache 2.0. See [LICENSE](./LICENSE).

This package includes compiled code from:
- [qpdf](https://github.com/qpdf/qpdf) (Apache 2.0)
- [zlib](https://github.com/madler/zlib) (zlib License)
- [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) (BSD 3-Clause / IJG)

See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES) for full license texts.
