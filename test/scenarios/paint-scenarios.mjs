/**
 * Environment-independent image paint scenarios.
 *
 * Observes getImagePaints(i) for every page of a fixture: the paints, or the
 * error code. The expectation table is test/fixtures/paint-manifest.json;
 * the same observation runs in Node (Vitest), in a browser page and in a Web
 * Worker (Playwright).
 *
 * Plain ESM without Node APIs so it can be served to the browser as-is.
 */

/** Observe one fixture through the public API. */
export function observePaints(api, bytes) {
    const loaded = api.loadPdf(bytes);
    if (!loaded.ok) return { load: loaded.code };
    const doc = loaded.value;
    try {
        const pageCount = doc.getPageCount();
        if (!pageCount.ok) return { pageCount: pageCount.code };
        const pages = [];
        for (let i = 0; i < pageCount.value; i++) {
            const paints = doc.getImagePaints(i);
            pages.push(paints.ok ? { paints: paints.value } : { error: paints.code });
        }
        return { pages };
    } finally {
        doc.close();
    }
}

/** The observation a paint-manifest entry describes. */
export function expectedPaints(entry) {
    return { pages: entry.pages };
}

/** Names of the fixtures the paint manifest describes. */
export function paintFixtureNames(manifest) {
    return Object.keys(manifest.fixtures);
}

/**
 * Observe every fixture of the paint manifest.
 *
 * @param api - QpdfImageStreams instance
 * @param manifest - parsed paint-manifest.json
 * @param readFixture - (fileName) => Uint8Array (sync) or Promise<Uint8Array>
 */
export async function runPaintScenarios(api, manifest, readFixture) {
    const results = {};
    for (const name of paintFixtureNames(manifest)) {
        results[name] = observePaints(api, await readFixture(name));
    }
    return results;
}

/** Expected observations for every fixture of the paint manifest. */
export function expectedPaintObservations(manifest) {
    return Object.fromEntries(
        paintFixtureNames(manifest).map((name) => [name, expectedPaints(manifest.fixtures[name])])
    );
}
