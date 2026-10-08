# Changelog

## 0.3.0 (unreleased)

Additive: every 0.2.0 field of `ImageInfo` keeps its type and value. Check
the two entries under "Changed" (stencil masks are now listed; the catalog
is sorted by object id).

### Added
- `ImageInfo` reports structured facts next to the unchanged 0.2.0 fields:
  `colorSpaceInfo` (colour space family, component count, resolved
  references, ICC profile reference, Indexed base/hival/lookup, Separation
  and DeviceN names and alternate space), `filters` (filter chain as full
  names, abbreviations expanded), `decode`, `masks` (`isStencilMask`,
  `softMask`, `mask`, `softMaskOf`, `maskOf`, `softMaskInData`), `pages` and
  `directPages` (0-based page indices), and `encoding` (what the filter
  chain declares, read from the dictionary alone, so a caller can decide
  without reading bytes). Exported types `ObjRef`, `ColorSpaceFamily`,
  `ColorSpaceInfo`, `ImageMaskInfo`.
- `PdfDocument.readImage(objId, generation): Result<EncodedImage>`: the
  image bytes with the container compression (Flate, LZW, RunLength, ASCII)
  removed and the image codec left untouched; `encoding.kind` names what the
  bytes are (`samples`, `jpeg`, `jpeg2000`, `ccitt` with its parameters,
  `jbig2` with its globals reference). Works for any stream object (soft
  masks, ICC profiles). Unlike `getImageStreamData` it does not fail on
  JPX, CCITT or JBIG2. Exported types `EncodedImage`, `ImageEncoding`.
- `PdfDocument.getPageCount(): Result<number>` and
  `PdfDocument.getPageInfo(index): Result<PageInfo>` (inherited `/MediaBox`
  as origin and size, `/Rotate` normalised to 0/90/180/270 or `null` when
  invalid). qpdf repairs a missing or malformed `/MediaBox` to Letter while
  reading the page tree; the repaired value is reported. Exported type
  `PageInfo`.
- Codec module as subpath export `@lipoe/browser-qpdf/codecs` (stage A):
  `canDecode(info)` (whether and how this stage would decode an image,
  from the catalog facts alone; the decoders apply the same rule),
  `decodeSamples` (Device colour spaces, ICCBased by component count,
  Indexed, 1 to 16 bits per component, `/Decode`, stencil masks as
  coverage), `applySoftMask`, and the browser adapter `toImageBitmap`
  (JPEG via the browser, samples via `decodeSamples`; the image's own soft
  mask is not applied, the bitmap is opaque). Own error codes
  `CodecErrorCode` on the shared result shape; `ResultOf<T, Code>` is
  exported from the core and `Result<T>` is now an alias of it (no change
  for callers). JPX, CCITT and JBIG2 return `UNSUPPORTED_ENCODING` in this
  version; Separation, DeviceN, Lab and Cal* return `UNSUPPORTED_COLOR_SPACE`.

### Changed
- **Compatibility:** `getImages()` lists stencil masks (`/ImageMask true`),
  which qpdf's `forEachImage` excluded in 0.1.0 and 0.2.0. They have
  `masks.isStencilMask: true`. **Migration:** to restore the 0.2.0 list use
  `images.filter((i) => !i.masks.isStencilMask)`; code that replaces every
  listed stream should apply that filter.
- **Compatibility:** `getImages()` returns the catalog in ascending
  `(objId, generation)` order instead of qpdf's traversal order.
  **Migration:** order by `pages[0]` (then `objId`) for page order.

Type-level notes: `ColorSpaceInfo` and `ImageEncoding` are discriminated
unions; narrow on `family` / `kind` before reading the per-variant fields
(`cs.family === 'Indexed' && cs.lookup`). `Result<T>` is now an alias of
`ResultOf<T, ErrorCode>`; nothing changes for code that reads results.

### Known limitations
- `getImages()` does not report errors while traversing the pages; it returns
  the images found so far as a successful result (unchanged since 0.1.0).
- Inline images (`BI … EI` in content streams) are not XObjects and are not
  listed. Masks that are not in any resource dictionary are referenced
  (`masks.softMask`, `masks.mask`) but not listed. Paint order within a page
  is not reported.
- qpdf repairs a missing or malformed `/MediaBox` to Letter while reading the
  page tree and warns on the console (as it does for a missing `/Resources`);
  `getPageInfo` reports the repaired value.
- Codec module stage A decodes raw samples and JPEG. JPX, CCITT and JBIG2
  return `UNSUPPORTED_ENCODING`; Separation, DeviceN, Lab and Cal* colour
  spaces return `UNSUPPORTED_COLOR_SPACE`. The facts for all of them are
  reported by the core (`readImage`, `colorSpaceInfo`), so a caller can
  route them to another decoder.
- Colour handling in the codec module is uncalibrated: device colour spaces
  map to sRGB directly, ICCBased by component count.

### Build
- qpdf stays at `v12.4.2`; the WASM module was rebuilt for the new wrapper
  (`dist/build-info.json`).
- TypeScript emits the codec module to `dist/codecs/`, published as the
  subpath export `./codecs`; nothing else in the package layout changed.

## 0.2.0

Mostly backward compatible: unencrypted PDFs behave as in 0.1.0, existing
error messages are unchanged, `writePdf()` without options keeps the
encryption. Check the **Compatibility** entry under "Changed": `0` and empty
strings in `replaceImageStream` metadata are now rejected.

Type-level note: the failure branch of `Result<T>` now requires `code`. Code
that only reads results is unaffected; code that *creates* failure results
typed as `Result<T>` (e.g. test doubles) must add a `code`.

### Added
- `Result` failures carry a machine-readable `code: ErrorCode`
  (`PASSWORD_REQUIRED` | `INVALID_PASSWORD` | `INVALID_INPUT` | `DISPOSED` | `UNKNOWN`)
  next to the unchanged `error` message. Exported type `ErrorCode` and the
  runtime list `ERROR_CODES` (single source of the codes).
- `PdfDocument.writePdf(options?: WriteOptions)` with `preserveEncryption`
  (default `true`); `false` writes an unencrypted PDF. Exported type `WriteOptions`.
- `PdfDocument.isEncrypted(): Result<boolean>`.

### Changed
- All arguments are type-checked and rejected with `INVALID_INPUT` instead of
  being coerced. This only affects calls the TypeScript types already forbid,
  e.g. from plain JavaScript: `getImages({ recursive: 'false' })` used to
  enumerate recursively, `replaceImageStream(..., { width: '5' })` or
  `{ height: 1.5 }` were silently converted.
- **Compatibility:** `replaceImageStream` metadata no longer accepts `0` for
  `width` / `height` / `bitsPerComponent` or empty strings (also `'/'`) for
  `colorSpace` / `filter`. In 0.1.0 these values were silently treated as
  "keep the original value" (an undocumented internal marker). They now fail
  with `INVALID_INPUT`. **Migration:** omit the field instead, e.g.
  `{ filter: '' }` -> `{}`. This also affects TypeScript callers, because
  the types allow these values.

### Fixed
- AES-256 PDFs could not be opened at all (also owner-password-only ones),
  and writing any AES-encrypted PDF failed ("unable to read N bytes from
  random number device"). The WASM build now uses `crypto.getRandomValues`
  as qpdf's random source (browser, Web Worker, Node >= 18).
- Type declarations were missing from the npm package (`dist/types.d.ts`).
- A failed load (e.g. a wrong password) kept a copy of the whole PDF in WASM
  memory; the wrapper is now freed.
- Object IDs, generation numbers and metadata integers >= 2^31 overflowed in
  the 32-bit WASM interface: e.g. object ID 2^32 + 5 read or replaced object 5,
  and a width >= 2^31 was silently ignored. Such values are now rejected with
  `INVALID_INPUT`.

### Known limitations
- `getImages()` does not report errors while traversing the pages; it returns
  the images found so far as a successful result (unchanged since 0.1.0).

### Build
- qpdf pinned to `v12.4.2`, cloned inside the Docker build. Dependencies are
  built in a cached image layer.
- `dist/build-info.json` records the build inputs; tests fail on a stale `dist/`.
