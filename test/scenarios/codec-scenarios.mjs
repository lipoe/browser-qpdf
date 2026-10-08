/**
 * Browser-side codec scenario: toImageBitmap for every image of every
 * manifest fixture. Reports the bitmap size on success or the CodecErrorCode.
 * Expected values derive from manifest.json (dimensions) and
 * codec-manifest.json (which images decode); no third table.
 *
 * Plain ESM without Node APIs.
 */

/** Observation for one fixture: per image {width, height} or {code}. */
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
            if (bitmap.ok) {
                results.push({ width: bitmap.value.width, height: bitmap.value.height });
                bitmap.value.close();
            } else {
                results.push({ code: bitmap.code });
            }
        }
        return results;
    } finally {
        doc.close();
    }
}

/** What observeBitmaps should report for a manifest fixture entry. */
export function expectedBitmaps(entry, codecEntry) {
    const images = Array.isArray(entry.expectedImages) ? entry.expectedImages : entry.expectedImages.recursive_true;
    return images.map((image, i) => {
        if (image.encoding === null) return { code: 'core:UNKNOWN' };
        if (image.encoding.kind === 'jpeg') return { width: image.width, height: image.height };
        if (image.encoding.kind !== 'samples') return { code: 'UNSUPPORTED_ENCODING' };
        const expected = codecEntry?.[i];
        return expected?.code ? { code: expected.code } : { width: image.width, height: image.height };
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
