# Changelog

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
