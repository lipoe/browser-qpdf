/**
 * Core -> codec module chained on the real fixtures: readImage output and
 * getImages facts go through decodeSamples (and applySoftMask where the
 * fixture has a soft mask). Expected pixels are in codec-manifest.json.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createQpdfImageStreams, type QpdfImageStreams } from '../../src/index.js';
import { applySoftMask, decodeSamples } from '../../src/codecs/index.js';
import { loadFixture, readJson, unwrap } from './helpers.js';

interface ExpectedPixels {
    pixels?: number[];
    fill?: number[];
    pixelCount?: number;
    alpha?: number[];
    withSoftMask?: number[];
    code?: string;
}

const codecManifest = readJson<{ fixtures: Record<string, ExpectedPixels[]> }>('codec-manifest.json');

describe('Codec module on real fixtures (stage A)', () => {
    let api: QpdfImageStreams;

    beforeAll(async () => {
        api = await createQpdfImageStreams();
    });

    for (const [name, expectedImages] of Object.entries(codecManifest.fixtures)) {
        it(`${name}: decodeSamples matches the codec manifest`, () => {
            const doc = unwrap(api.loadPdf(loadFixture(name)));
            const images = unwrap(doc.getImages({ recursive: true }));
            expect(images).toHaveLength(expectedImages.length);

            images.forEach((info, i) => {
                const expected = expectedImages[i];
                const encoded = unwrap(doc.readImage(info.objId, info.generation));
                const decoded = decodeSamples(encoded, info);

                if (expected.code) {
                    expect(decoded).toMatchObject({ ok: false, code: expected.code });
                    return;
                }
                const rgba = unwrap(decoded);
                expect(rgba.width * rgba.height * 4).toBe(rgba.data.length);
                const actual = Array.from(rgba.data);
                if (expected.pixels) expect(actual).toEqual(expected.pixels);
                if (expected.fill) {
                    expect(rgba.width * rgba.height).toBe(expected.pixelCount);
                    expect(actual).toEqual(Array.from({ length: expected.pixelCount! }, () => expected.fill!).flat());
                }
                if (expected.alpha) expect(actual.filter((_, j) => j % 4 === 3)).toEqual(expected.alpha);

                if (expected.withSoftMask) {
                    const maskRef = info.masks.softMask!;
                    const maskInfo = images.find((img) => img.objId === maskRef.objId && img.generation === maskRef.generation)!;
                    const mask = unwrap(decodeSamples(unwrap(doc.readImage(maskRef.objId, maskRef.generation)), maskInfo));
                    expect(Array.from(unwrap(applySoftMask(rgba, mask)).data)).toEqual(expected.withSoftMask);
                }
            });
            doc.close();
        });
    }
});
