/**
 * Environment-independent catalog scenarios.
 *
 * Observes, for one fixture, everything the 0.3.0 catalog API reports:
 * getPageCount, getPageInfo for every page, getImages({recursive: true}) and
 * readImage / getImageStreamData for every image. The observation is
 * JSON-comparable so the same code runs in Node (Vitest), in a browser page
 * and in a Web Worker (Playwright).
 *
 * There is one expectation table for these facts, test/fixtures/manifest.json;
 * expectedCatalog() turns a manifest entry into the observation shape, so
 * Node and browser runs compare against the same file.
 *
 * Plain ESM without Node APIs so it can be served to the browser as-is.
 */

/** Reduce a Result to a comparable outcome: 'ok' or { code, error }. */
function outcome(result) {
    return result.ok ? 'ok' : { code: result.code, error: result.error };
}

/** Typed arrays as plain arrays, recursively, so observations survive JSON and structured clone. */
function plain(value) {
    if (value instanceof Uint8Array) return Array.from(value);
    if (Array.isArray(value)) return value.map(plain);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    }
    return value;
}

/** ImageInfo without object location and encoded length (the manifest does not record them). */
function imageFacts(info) {
    const { objId, generation, streamLength, ...facts } = info;
    return plain(facts);
}

/** Observe one fixture through the public API. */
export function observeCatalog(api, bytes) {
    const loaded = api.loadPdf(bytes);
    if (!loaded.ok) return { load: outcome(loaded) };
    const doc = loaded.value;
    try {
        const pageCount = doc.getPageCount();
        const pages = [];
        if (pageCount.ok) {
            for (let i = 0; i < pageCount.value; i++) {
                const page = doc.getPageInfo(i);
                pages.push(page.ok ? page.value : outcome(page));
            }
        }
        const images = doc.getImages({ recursive: true });
        return {
            pageCount: pageCount.ok ? pageCount.value : outcome(pageCount),
            pages,
            images: images.ok
                ? images.value.map((info) => {
                      const read = doc.readImage(info.objId, info.generation);
                      const decoded = doc.getImageStreamData(info.objId, info.generation);
                      return {
                          ...imageFacts(info),
                          encoding: read.ok ? read.value.encoding : null,
                          encodedLength: read.ok ? read.value.data.byteLength : null,
                          decodedStreamLength: decoded.ok ? decoded.value.byteLength : null,
                      };
                  })
                : outcome(images),
        };
    } finally {
        doc.close();
    }
}

/** The observation a manifest entry describes. */
export function expectedCatalog(entry) {
    const images = Array.isArray(entry.expectedImages) ? entry.expectedImages : entry.expectedImages.recursive_true;
    return {
        pageCount: entry.pageCount,
        pages: entry.pageInfos,
        images: images.map(({ rawStreamLength, ...image }) => image),
    };
}

/** Names of the fixtures the manifest describes. */
export function catalogFixtureNames(manifest) {
    return Object.keys(manifest.fixtures);
}

/**
 * Observe every manifest fixture.
 *
 * @param api - QpdfImageStreams instance
 * @param manifest - parsed manifest.json
 * @param readFixture - (fileName) => Uint8Array (sync) or Promise<Uint8Array>
 */
export async function runCatalogScenarios(api, manifest, readFixture) {
    const results = {};
    for (const name of catalogFixtureNames(manifest)) {
        results[name] = observeCatalog(api, await readFixture(name));
    }
    return results;
}

/** Expected observations for every manifest fixture. */
export function expectedCatalogs(manifest) {
    return Object.fromEntries(
        catalogFixtureNames(manifest).map((name) => [name, expectedCatalog(manifest.fixtures[name])])
    );
}
