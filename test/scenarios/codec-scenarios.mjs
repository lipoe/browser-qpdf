/**
 * Browser-side codec scenario: toImageBitmap for every image of every
 * manifest fixture, and toImageBitmap with the image's soft mask where the
 * catalog has one. Reports the bitmap size on success (plus the pixels, read
 * back through a canvas, for small images decoded from raw samples; plus
 * the alpha channel of the masked bitmap) or the CodecErrorCode. Expected
 * values derive from manifest.json (dimensions, encodings) and
 * codec-manifest.json (which images decode and to what); no third table.
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

const alphaOf = (pixels) => pixels.filter((_, i) => i % 4 === 3);

/** Observation for one fixture: per image {width, height, pixels?, maskedAlpha?} or {code}. */
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
            const small = result.width * result.height <= READBACK_MAX_PIXELS;
            // Pixels only for samples (deterministic); JPEG decoders differ between browsers.
            if (read.value.encoding.kind === 'samples' && small) {
                const pixels = readPixels(bitmap.value);
                if (pixels) result.pixels = pixels;
            }
            bitmap.value.close();

            // Masked variant: the mask comes from the catalog (closure) and readImage.
            const maskRef = info.masks.softMask;
            const maskInfo = maskRef && images.value.find((i) => i.objId === maskRef.objId && i.generation === maskRef.generation);
            if (maskInfo && small) {
                const maskRead = doc.readImage(maskRef.objId, maskRef.generation);
                const masked = maskRead.ok
                    ? await codecs.toImageBitmap(read.value, info, { softMask: { image: maskRead.value, info: maskInfo } })
                    : { ok: false, code: `core:${maskRead.code}` };
                if (masked.ok) {
                    const pixels = readPixels(masked.value);
                    if (pixels) result.maskedAlpha = alphaOf(pixels);
                    masked.value.close();
                } else {
                    result.maskedCode = masked.code;
                }
            }
            results.push(result);
        }
        return results;
    } finally {
        doc.close();
    }
}

/** Full RGBA array a codec-manifest entry describes, or undefined when it has no pixel expectation. */
function expectedPixels(codecEntry) {
    if (!codecEntry) return undefined;
    if (codecEntry.pixels) return codecEntry.pixels;
    if (codecEntry.fill) return Array.from({ length: codecEntry.pixelCount }, () => codecEntry.fill).flat();
    if (codecEntry.alpha) return codecEntry.alpha.flatMap((a) => [0, 0, 0, a]);
    return undefined;
}

/** Alpha channel after soft-mask compositing, from `withSoftMask` (samples) or `withSoftMaskAlpha` (JPEG). */
function expectedMaskedAlpha(codecEntry) {
    if (!codecEntry) return undefined;
    if (codecEntry.withSoftMask) return alphaOf(codecEntry.withSoftMask);
    return codecEntry.withSoftMaskAlpha;
}

/** What observeBitmaps should report for a manifest fixture entry. */
export function expectedBitmaps(entry, codecEntries) {
    const images = Array.isArray(entry.expectedImages) ? entry.expectedImages : entry.expectedImages.recursive_true;
    return images.map((image, i) => {
        if (image.encodedLength === null) return { code: 'core:UNKNOWN' };
        const expected = codecEntries?.[i];
        const small = image.width * image.height <= READBACK_MAX_PIXELS;
        const result = { width: image.width, height: image.height };
        if (image.encoding.kind === 'jpeg') {
            const alpha = expectedMaskedAlpha(expected);
            if (image.masks.softMask && alpha && small) result.maskedAlpha = alpha;
            return result;
        }
        if (image.encoding.kind !== 'samples') return { code: 'UNSUPPORTED_ENCODING' };
        if (expected?.code) return { code: expected.code };
        const pixels = expectedPixels(expected);
        if (pixels && small) result.pixels = pixels;
        const alpha = expectedMaskedAlpha(expected);
        if (image.masks.softMask && alpha && small) result.maskedAlpha = alpha;
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
