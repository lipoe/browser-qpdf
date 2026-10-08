# @lipoe/browser-qpdf

Browser-compatible WASM module exposing qpdf's library API for reading and replacing PDF image streams.

## Features

- Load PDFs (with or without password) entirely in-browser via WebAssembly
- Encrypted PDFs: RC4 40/128-bit, AES-128 and AES-256; owner-password-only PDFs load without password
- Decrypt PDFs (`writePdf({ preserveEncryption: false })`)
- Machine-readable error codes (`PASSWORD_REQUIRED`, `INVALID_PASSWORD`, ...)
- Catalog of all image XObjects with the facts of the PDF object graph: dimensions,
  structured colour space (references resolved), filter chain, masks in both
  directions, pages each image appears on
- Read any image in its stored encoding (`readImage`): container compression removed,
  the image codec named (`samples`, `jpeg`, `jpeg2000`, `ccitt`, `jbig2`)
- Page facts (`getPageCount`, `getPageInfo`: MediaBox, rotation)
- Codec module `@lipoe/browser-qpdf/codecs`: raw samples and JPEG to pixels
  (`decodeSamples`, `applySoftMask`, `toImageBitmap`)
- Read decoded or raw image stream data (0.1.0 routes, unchanged)
- Replace image streams with new content and metadata
- Write modified PDFs back to `Uint8Array`
- No filesystem dependencies — works in browsers, web workers and Node >= 18 (random data comes from `crypto.getRandomValues`)

## Why this package?

Existing qpdf WebAssembly builds ([@neslinesli93/qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm),
[@jspawn/qpdf-wasm](https://github.com/jsscheller/qpdf-wasm) and tools built on them) expose
only the qpdf **command line** (`callMain`) and exchange files through Emscripten's virtual
file system. They offer no programmatic access to PDF objects or streams.

This package binds qpdf's **library API** via Embind instead: PDFs go in and out as
`Uint8Array`, and image XObjects can be enumerated, read and replaced directly. The build
setup (Docker, zlib/libjpeg-turbo, libjpeg-turbo patch) follows @neslinesli93/qpdf-wasm.

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

# 2. Install dependencies
npm install

# 3. Build the WASM module in Docker (artifacts land in ./dist).
#    Dependencies are cached in an image layer; re-run after changing src/wrapper.cpp.
npm run build:wasm

# 4. Build the TypeScript wrapper
npm run build
```

After this you should have `dist/qpdf-image-stream.js`, `dist/qpdf-image-stream.wasm`,
`dist/build-info.json`, `dist/index.js`, `dist/index.d.ts`, `dist/errors.js`, `dist/errors.d.ts`
and `dist/types.d.ts`.

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

    // Read an image in its stored encoding (container compression removed, codec named)
    const read = doc.readImage(images.value[0].objId, images.value[0].generation);
    if (read.ok) {
        // read.value.encoding.kind: 'samples' | 'jpeg' | 'jpeg2000' | 'ccitt' | 'jbig2'
        // read.value.data: the bytes in that encoding
    }

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

### From facts to pixels: the codec module

The core reports facts and hands out bytes in their stored encoding. Turning
them into pixels is the job of the codec module, a separate entry point that
depends on the core by types only:

```typescript
import { createQpdfImageStreams } from '@lipoe/browser-qpdf';
import { canDecode, toImageBitmap } from '@lipoe/browser-qpdf/codecs';

const images = doc.getImages({ recursive: true });
for (const info of images.ok ? images.value : []) {
    if (info.masks.isStencilMask || info.masks.softMaskOf.length > 0) continue; // a caller's rule, not the library's
    if (!canDecode(info).ok) continue;                                        // decided from facts, no bytes read
    const read = doc.readImage(info.objId, info.generation);
    if (!read.ok) continue;
    // Browser: resize while decoding, so no full-size bitmap is ever kept
    const bitmap = await toImageBitmap(read.value, info, { resizeWidth: 300 });
    if (bitmap.ok) show(bitmap.value);
    else console.log(bitmap.code); // e.g. 'UNSUPPORTED_ENCODING' for JPX in this version
}
```

What you get per image kind (ISO 32000-1 §8.9):

| Image kind in the PDF | `getImages()` facts | `readImage()` bytes | `/codecs` (stage A) |
|---|---|---|---|
| Device colour spaces, 1 to 16 bpc, unfiltered or Flate/LZW/RunLength/ASCII | `colorSpaceInfo`, `bitsPerComponent`, `decode` | `encoding.kind: 'samples'` | `decodeSamples` -> RGBA |
| ICCBased | `components` (`/N`), `iccProfile` reference | samples | mapped by component count (no colour management) |
| Indexed | `base`, `hival`, `lookup` bytes | samples (indices) | `decodeSamples` |
| Separation, DeviceN, Lab, Cal* | `names`, `alternate`, `components` | samples | `UNSUPPORTED_COLOR_SPACE` (tint transforms and Lab ranges are not facts the library has yet) |
| DCTDecode (JPEG) | `filters` | `encoding.kind: 'jpeg'`, a complete JPEG file | `toImageBitmap` (browser decoder) |
| JPXDecode | `filters`, `masks.softMaskInData` | `encoding.kind: 'jpeg2000'` | `UNSUPPORTED_ENCODING` |
| CCITTFaxDecode, JBIG2Decode | `filters` | `encoding.kind: 'ccitt'` with its parameters, `'jbig2'` with its globals reference | `UNSUPPORTED_ENCODING` |
| Stencil masks (`/ImageMask true`) | `masks.isStencilMask`, `decode` | 1-bit samples | coverage (RGB 0, alpha); the fill colour is in the page content, not in the image |
| Soft masks, stencil `/Mask`, colour-key `/Mask` | `masks.softMask`, `masks.mask`, `masks.softMaskOf`, `masks.maskOf` | the mask stream through the same methods | `applySoftMask` |

Three ways to read bytes, three different results:

| Method | Result | Defined by |
|---|---|---|
| `getRawImageStreamData` | the stream bytes as stored (still compressed) | the PDF |
| `readImage` | container compression removed, codec untouched and named | the PDF (ISO 32000 table 6) |
| `getImageStreamData` | everything the qpdf build can decode, including JPEG via libjpeg; fails on anything else | the qpdf build; frozen 0.1.0 route |

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

The catalog facts, `readImage` and the page facts are described by
`test/fixtures/manifest.json` (one entry per fixture, generated by
`node test/fixtures/generate-fixtures.mjs`), and the codec module's results by
`test/fixtures/codec-manifest.json`. Both are checked in Node, in a browser page
and in a Web Worker through the shared modules in `test/scenarios/`. An
import-graph test keeps the codec module dependent on the core by types only.

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

Enumerate all image XObjects, including stencil masks (`/ImageMask true`),
in ascending object order. Pass `{ recursive: true }` to include images
reachable through Form XObjects.

Every `ImageInfo` carries the 0.1.0 fields as written in the stream
dictionary (`width`, `height`, `bitsPerComponent`, `colorSpace`, `filter`,
`streamLength`) and, since 0.3.0, structured facts:

- `colorSpaceInfo`: a discriminated union on `family` (`DeviceGray`, `DeviceRGB`,
  `DeviceCMYK`, `CalGray`, `CalRGB`, `Lab`, `ICCBased`, `Indexed`, `Separation`,
  `DeviceN`, `Pattern`, `Unknown`) with `components`, the resolved `raw` syntax and
  per-family facts (`iccProfile`, `base`/`hival`/`lookup`, `names`/`alternate`).
  Indirect references are resolved before classifying; a colour space in a form
  the spec does not allow is `Unknown`. `null` when `/ColorSpace` is absent.
- `filters`: the filter chain as full names without slash, abbreviations expanded
  (`/Fl` -> `FlateDecode`); `[]` when unfiltered.
- `decode`: the `/Decode` array, or `null`.
- `encoding`: what the filter chain declares, read from the dictionary alone
  (the same object `readImage` returns once the container filters are removed);
  `null` when the chain has more than one filter after the codec. Lets a caller
  decide routes and counts without reading a single byte.
- `masks`: `isStencilMask`, `softMaskInData`, this image's `softMask` and `mask`
  (`{ kind: 'stencil', ref }` or `{ kind: 'colorKey' }`), and the images in the
  catalog that use this stream as a mask (`softMaskOf`, `maskOf`).
- `pages`: 0-based indices of the pages from whose resources the image is reachable
  within the requested scope; `directPages`: pages whose own resources name it.

The string fields `colorSpace` and `filter` are PDF syntax as qpdf serialises it
(an indirect reference stays `"6 0 R"`); they are kept for compatibility, prefer
`colorSpaceInfo` and `filters`. The library reports facts only: no field judges
an image, and absent keys are `null` unless the spec defines a default.

> **Known limitation:** errors while traversing the pages (e.g. a damaged page
> tree) are not reported. `getImages()` then returns `ok: true` with the images
> found up to that point, so the list can be incomplete for damaged PDFs.
> This behavior is kept for compatibility with 0.1.0. Inline images (`BI … EI`
> in content streams) are not XObjects and are not listed; masks that are not
> in any resource dictionary are referenced (`softMask`, `mask`) but not listed.

### `PdfDocument.readImage(objId, generation): Result<EncodedImage>`

The image bytes with the container compression (every filter before the first
image codec of ISO 32000 table 6) removed and the codec left untouched.
`encoding` says what the bytes are:

| `encoding.kind` | bytes are | standard |
|---|---|---|
| `'samples'` | raw samples, rows byte-aligned, components interleaved, 16 bit big-endian; layout in the `ImageInfo` | ISO 32000-1 §8.9.5 |
| `'jpeg'` | a complete JPEG file | ITU-T T.81 |
| `'jpeg2000'` | a JPEG 2000 codestream or JP2 file | ISO 15444 |
| `'ccitt'` | Group 3/4 fax data; `k`, `columns`, `rows`, `blackIs1`, `byteAlign`, `endOfLine`, `endOfBlock` (spec defaults filled in) | ITU-T T.4 / T.6 |
| `'jbig2'` | JBIG2 embedded stream; `globals` references the globals stream | ITU-T T.88 |

Works for any stream object, so soft masks and ICC profiles can be read the same
way. Fails with `UNKNOWN` (never with partially decoded bytes) on damaged data,
unknown filters, or more than one filter after the codec.

### `PdfDocument.getImageStreamData(objId, generation): Result<Uint8Array>`

Read decoded stream data: every filter the qpdf build can decode is applied
(including JPEG via libjpeg); the call fails when the chain contains one it
cannot. Frozen 0.1.0 route; prefer `readImage`.

### `PdfDocument.getRawImageStreamData(objId, generation): Result<Uint8Array>`

Read raw (compressed) image stream data.

### `PdfDocument.getPageCount(): Result<number>`

### `PdfDocument.getPageInfo(index): Result<PageInfo>`

`{ index, mediaBox: { x, y, width, height }, rotate }` for a 0-based page index
(`INVALID_INPUT` when out of range). `/MediaBox` and `/Rotate` are inherited
through the page tree; `rotate` is normalised to `0 | 90 | 180 | 270`, `0` when
absent (spec default) and `null` when not a multiple of 90. qpdf repairs a
missing or malformed `/MediaBox` to Letter (612 x 792) while reading the page
tree; the repaired value is what is reported.

### `PdfDocument.replaceImageStream(objId, generation, data, metadata?): Result<void>`

Replace image stream content. Omit a metadata field to keep its original value.

Metadata fields (all optional):
- `width` / `height` — new pixel dimensions, integer from 1 to 2^31-1
- `bitsPerComponent` — bits per color component (e.g. 8), integer from 1 to 2^31-1
- `colorSpace` — PDF color space name (e.g. `'DeviceRGB'`, `'DeviceGray'`), not empty
- `filter` — PDF filter name (e.g. `'DCTDecode'` for JPEG, `'FlateDecode'` for zlib), not empty

Both `filter` and `colorSpace` accept values with or without a leading `/` — the library normalizes automatically.
Other values (wrong type, `0`, empty names, out of range) fail with `INVALID_INPUT`.

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

### Codec module: `@lipoe/browser-qpdf/codecs`

Stage A, pure TypeScript, no WASM of its own. Imports only types from the
core; the core never imports it. Results use the same shape as the core with
its own codes: `UNSUPPORTED_ENCODING`, `UNSUPPORTED_COLOR_SPACE`,
`INVALID_INPUT`, `DECODE_FAILED`. Nothing throws.

- `canDecode(info): DecodeSupport`: whether and how this stage would decode the
  image, decided from the catalog facts alone (`{ ok: true, route: 'samples' | 'jpeg', components }`
  or the `CodecErrorCode` the decoder would return). The decoders apply exactly
  this rule, so a count of decodable images needs no bytes.
- `decodeSamples(image, info): CodecResult<RgbaImage>`: `'samples'` to RGBA for
  Device colour spaces, ICCBased (by component count, no colour management),
  Indexed, 1/2/4/8/16 bits per component, `/Decode` arrays; stencil masks become
  coverage (RGB 0, alpha 255 where the sample paints). Separation, DeviceN, Lab,
  Cal* and Unknown are refused with `UNSUPPORTED_COLOR_SPACE` rather than
  approximated.
- `applySoftMask(image, mask): CodecResult<RgbaImage>`: the decoded mask's red
  channel becomes the image's alpha (nearest-neighbour resampling).
- `toImageBitmap(image, info, { resizeWidth?, resizeHeight?, resizeQuality? })`
  (browser only): `'jpeg'` through the browser's decoder, `'samples'` through
  `decodeSamples`; resizing happens inside `createImageBitmap`. Other kinds return
  `UNSUPPORTED_ENCODING` until their codec stage ships. The image's own soft mask
  is **not** applied (the JPEG route never has pixels to write alpha into); the
  bitmap is opaque, stencil masks excepted. For transparency decode image and
  mask with `decodeSamples` and use `applySoftMask`.

## Releasing

`npm publish` packs whatever is in `dist/`. The `prepublishOnly` hook runs
`npm run build` and the unit + integration tests first, so a stale TypeScript
build or a WASM binary that does not match `src/wrapper.cpp` (build-info check)
aborts the publish. It does not rebuild the WASM module itself.

```bash
npm run build:wasm        # only if src/wrapper.cpp or build-wasm.sh changed
npm run test:browser      # browser tests are not part of prepublishOnly
npm publish --dry-run     # optional: shows the 11 packed files
npm publish
git tag v<version> && git push origin v<version>
```

## License

Apache 2.0. See [LICENSE](./LICENSE).

This package includes compiled code from:
- [qpdf](https://github.com/qpdf/qpdf) (Apache 2.0)
- [zlib](https://github.com/madler/zlib) (zlib License)
- [libjpeg-turbo](https://github.com/libjpeg-turbo/libjpeg-turbo) (BSD 3-Clause / IJG)

See [THIRD-PARTY-NOTICES](./THIRD-PARTY-NOTICES) for full license texts.
