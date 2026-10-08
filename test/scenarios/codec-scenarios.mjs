/**
 * Browser-side codec scenario: toImageBitmap for every image of every
 * manifest fixture. Reports the bitmap size on success (plus the pixels, read
 * back through a canvas, for small images decoded from raw samples) or the
 * CodecErrorCode. Expected values derive from manifest.json (dimensions,
 * encodings) and codec-manifest.json (which images decode and to what); no
 * third table.
 *
 * Plain ESM without Node APIs.
 */

/** Images up to this many pixels are read back and compared pixel by pixel. */
const READBACK_MAX_PIXELS = 16;

/** RGBA bytes of a bitmap, through an OffscreenCanvas (page and Worker). */
function readPixels(bitmap) {
    if (typeof OffscreenCanvas !== 'function') return undefined;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    return Array.from(ctx.getImageData(0, 0, bitmap.width, bitmap.height).data);
}

/** Observation for one fixture: per image {width, height, pixels?} or {code}. */
export async function observeBitmaps(api, codecs, bytes) {
    const loaded = api.loadPdf(bytes);
    if (!loaded.ok) return { load: loaded.code };
    const doc = loaded.value;
    try {
        const images = doc.getImages({ recursive: true });
        if (!images.ok) return { images: images.code };
        const results = [];
        for (const info of images.value) {
            const read = doc.readImage(info.objId, info.generation);
            if (!read.ok) {
                results.push({ code: `core:${read.code}` });
                continue;
            }
            const bitmap = await codecs.toImageBitmap(read.value, info);
            if (!bitmap.ok) {
                results.push({ code: bitmap.code });
                continue;
            }
            const result = { width: bitmap.value.width, height: bitmap.value.height };
            // Pixels only for samples (deterministic); JPEG decoders differ between browsers.
            if (read.value.encoding.kind === 'samples' && result.width * result.height <= READBACK_MAX_PIXELS) {
                const pixels = readPixels(bitmap.value);
                if (pixels) result.pixels = pixels;
            }
            bitmap.value.close();
            results.push(result);
        }
        return results;
    } finally {
        doc.close();
    }
}

/** Full RGBA array a codec-manifest entry describes, or undefined when it has no pixel expectation. */
function expectedPixels(codecEntry, pixelCount) {
    if (!codecEntry) return undefined;
    if (codecEntry.pixels) return codecEntry.pixels;
    if (codecEntry.fill) return Array.from({ length: codecEntry.pixelCount }, () => codecEntry.fill).flat();
    if (codecEntry.alpha) return codecEntry.alpha.flatMap((a) => [0, 0, 0, a]);
    return undefined;
}

/** What observeBitmaps should report for a manifest fixture entry. */
export function expectedBitmaps(entry, codecEntries) {
    const images = Array.isArray(entry.expectedImages) ? entry.expectedImages : entry.expectedImages.recursive_true;
    return images.map((image, i) => {
        if (image.encodedLength === null) return { code: 'core:UNKNOWN' };
        if (image.encoding.kind === 'jpeg') return { width: image.width, height: image.height };
        if (image.encoding.kind !== 'samples') return { code: 'UNSUPPORTED_ENCODING' };
        const expected = codecEntries?.[i];
        if (expected?.code) return { code: expected.code };
        const result = { width: image.width, height: image.height };
        const pixels = expectedPixels(expected, image.width * image.height);
        if (pixels && image.width * image.height <= READBACK_MAX_PIXELS) result.pixels = pixels;
        return result;
    });
}

export async function runCodecScenarios(api, codecs, manifest, readFixture) {
    const results = {};
    for (const name of Object.keys(manifest.fixtures)) {
        results[name] = await observeBitmaps(api, codecs, await readFixture(name));
    }
    return results;
}

export function expectedCodecScenarios(manifest, codecManifest) {
    return Object.fromEntries(
        Object.keys(manifest.fixtures).map((name) => [
            name,
            expectedBitmaps(manifest.fixtures[name], codecManifest.fixtures[name]),
        ])
    );
}
