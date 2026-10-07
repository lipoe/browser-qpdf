/**
 * Environment-independent encryption scenarios.
 *
 * Runs a fixed set of operations against the public API and returns a
 * JSON-serializable observation per fixture. The same code runs in Node
 * (Vitest), in a browser page and in a Web Worker (Playwright); all three
 * compare against expected-observations.mjs.
 *
 * Plain ESM without Node APIs so it can be served to the browser as-is.
 */

export const WRONG_PASSWORD = 'falsch';

/** Reduce a Result to a comparable outcome: 'ok' or { error }. */
export function outcome(result) {
    return result.ok ? 'ok' : { error: result.error };
}

/** Outcome of a load attempt; closes the document again if it opened. */
function loadOutcome(result) {
    if (result.ok) result.value.close();
    return outcome(result);
}

/** True if the bytes contain an /Encrypt dictionary reference. */
export function containsEncryptDict(bytes) {
    return indexOfAscii(bytes, '/Encrypt') !== -1;
}

function indexOfAscii(bytes, text) {
    const needle = Array.from(text, (c) => c.charCodeAt(0));
    outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (bytes[i + j] !== needle[j]) continue outer;
        }
        return i;
    }
    return -1;
}

function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Image metadata without object numbers (qpdf renumbers objects when encrypting). */
function imageShape(info) {
    return {
        width: info.width,
        height: info.height,
        bitsPerComponent: info.bitsPerComponent,
        colorSpace: info.colorSpace,
        filter: info.filter,
    };
}

/** Decoded stream data of every image, in getImages() order. */
function decodedImages(doc) {
    const images = doc.getImages();
    if (!images.ok) throw new Error(`getImages failed: ${images.error}`);
    return images.value.map((info) => {
        const data = doc.getImageStreamData(info.objId, info.generation);
        if (!data.ok) throw new Error(`getImageStreamData failed: ${data.error}`);
        return data.value;
    });
}

/** Load bytes with the given password (null = loadPdf without password). */
function load(api, bytes, password) {
    return password === null ? api.loadPdf(bytes) : api.loadPdfWithPassword(bytes, password);
}

/**
 * Observe how a written PDF can be reopened: without password and with the
 * user password, plus whether decoded images match `expectedImages`.
 */
function observeWritten(api, written, userPassword, expectedImages) {
    const withoutPassword = api.loadPdf(written);
    const observation = {
        encrypted: containsEncryptDict(written),
        reloadWithoutPassword: outcome(withoutPassword),
        reloadWithUserPassword: loadOutcome(api.loadPdfWithPassword(written, userPassword)),
    };
    const reopen = withoutPassword.ok
        ? withoutPassword
        : api.loadPdfWithPassword(written, userPassword);
    if (!reopen.ok) return { ...observation, imagesPreserved: null };
    try {
        const images = decodedImages(reopen.value);
        observation.imagesPreserved =
            images.length === expectedImages.length &&
            images.every((data, i) => bytesEqual(data, expectedImages[i]));
    } finally {
        reopen.value.close();
    }
    return observation;
}

/**
 * Run all scenarios for one fixture.
 *
 * @param api - QpdfImageStreams instance
 * @param bytes - fixture bytes
 * @param sourceBytes - unencrypted source (multi-image.pdf) for content comparison
 * @param fixture - { userPassword, ownerPassword, requiresPassword }
 */
export function observeEncryptedFixture(api, bytes, sourceBytes, fixture) {
    const observation = {
        loadPdf: loadOutcome(api.loadPdf(bytes)),
        wrongPassword: loadOutcome(api.loadPdfWithPassword(bytes, WRONG_PASSWORD)),
        emptyPassword: loadOutcome(api.loadPdfWithPassword(bytes, '')),
        userPassword: loadOutcome(api.loadPdfWithPassword(bytes, fixture.userPassword)),
        ownerPassword: loadOutcome(api.loadPdfWithPassword(bytes, fixture.ownerPassword)),
        opened: null,
    };

    const opened = load(api, bytes, fixture.requiresPassword ? fixture.userPassword : null);
    if (!opened.ok) return observation;

    const source = api.loadPdf(sourceBytes);
    if (!source.ok) throw new Error(`source fixture failed to load: ${source.error}`);
    const sourceImages = decodedImages(source.value);
    const sourceShapes = source.value.getImages().value.map(imageShape);
    source.value.close();

    const doc = opened.value;
    try {
        const images = doc.getImages();
        const decoded = decodedImages(doc);
        observation.opened = {
            imagesMatchSource:
                images.ok &&
                JSON.stringify(images.value.map(imageShape)) === JSON.stringify(sourceShapes) &&
                decoded.every((data, i) => bytesEqual(data, sourceImages[i])),
        };

        // Write without modifications (default options)
        const written = doc.writePdf();
        observation.opened.writePdf = outcome(written);
        if (written.ok) {
            Object.assign(
                observation.opened,
                prefixKeys('written', observeWritten(api, written.value, fixture.userPassword, sourceImages))
            );
        }

        // Compression path: replace the first image, then write (default options)
        const target = images.value[0];
        const replacement = new Uint8Array(sourceImages[0].length).fill(0x42);
        observation.opened.replaceImageStream = outcome(
            doc.replaceImageStream(target.objId, target.generation, replacement)
        );
        const replaced = doc.writePdf();
        observation.opened.writePdfAfterReplace = outcome(replaced);
        if (replaced.ok) {
            const expected = [replacement, ...sourceImages.slice(1)];
            Object.assign(
                observation.opened,
                prefixKeys('replaced', observeWritten(api, replaced.value, fixture.userPassword, expected))
            );
        }
    } finally {
        doc.close();
    }
    return observation;
}

function prefixKeys(prefix, object) {
    return Object.fromEntries(
        Object.entries(object).map(([k, v]) => [prefix + k[0].toUpperCase() + k.slice(1), v])
    );
}

/**
 * All scenario cases: every encrypted fixture plus the unencrypted source
 * as control case.
 *
 * @param manifest - parsed encrypted-manifest.json
 * @returns Array<[fileName, { userPassword, ownerPassword, requiresPassword }]>
 */
export function scenarioCases(manifest) {
    return [
        [manifest.source, { userPassword: '', requiresPassword: false }],
        ...Object.entries(manifest.fixtures),
    ].map(([file, fixture]) => [file, { ...fixture, ownerPassword: manifest.ownerPassword }]);
}

/**
 * Run the scenarios for every case.
 *
 * @param api - QpdfImageStreams instance
 * @param manifest - parsed encrypted-manifest.json
 * @param readFixture - (fileName) => Uint8Array (sync) or Promise<Uint8Array>
 */
export async function runEncryptionScenarios(api, manifest, readFixture) {
    const sourceBytes = await readFixture(manifest.source);
    const results = {};
    for (const [file, fixture] of scenarioCases(manifest)) {
        results[file] = observeEncryptedFixture(api, await readFixture(file), sourceBytes, fixture);
    }
    return results;
}
