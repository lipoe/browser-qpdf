/**
 * Mock of the Emscripten-generated WASM glue module.
 *
 * This mock exposes a configurable MockQpdfWasmWrapper class whose methods
 * can be controlled via the exported `mockWasm` object. Tests import `mockWasm`
 * to set up return values and assertions.
 */

/** Mock function references - tests configure these to control behavior */
export const mockWasm = {
    loadPdf: null,
    loadPdfWithPassword: null,
    getImages: null,
    getImageStreamData: null,
    getRawImageStreamData: null,
    readImage: null,
    replaceImageStream: null,
    isEncrypted: null,
    writePdf: null,
    close: null,
    getPageCount: null,
    getPageInfo: null,
    delete: null,
};

class MockQpdfWasmWrapper {
    loadPdf(data) {
        if (mockWasm.loadPdf) return mockWasm.loadPdf(data);
        return { success: true };
    }
    loadPdfWithPassword(data, password) {
        if (mockWasm.loadPdfWithPassword) return mockWasm.loadPdfWithPassword(data, password);
        return { success: true };
    }
    getImages(recursive) {
        if (mockWasm.getImages) return mockWasm.getImages(recursive);
        return [];
    }
    getImageStreamData(objId, gen) {
        if (mockWasm.getImageStreamData) return mockWasm.getImageStreamData(objId, gen);
        return new Uint8Array(0);
    }
    getRawImageStreamData(objId, gen) {
        if (mockWasm.getRawImageStreamData) return mockWasm.getRawImageStreamData(objId, gen);
        return new Uint8Array(0);
    }
    readImage(objId, gen) {
        if (mockWasm.readImage) return mockWasm.readImage(objId, gen);
        return { data: new Uint8Array(0), encoding: { kind: 'samples' } };
    }
    getPageInfo(index) {
        if (mockWasm.getPageInfo) return mockWasm.getPageInfo(index);
        return { index, mediaBox: { x: 0, y: 0, width: 1, height: 1 }, rotate: 0 };
    }
    replaceImageStream(objId, gen, data, metadata) {
        if (mockWasm.replaceImageStream) return mockWasm.replaceImageStream(objId, gen, data, metadata);
        return { success: true };
    }
    isEncrypted() {
        if (mockWasm.isEncrypted) return mockWasm.isEncrypted();
        return false;
    }
    writePdf(preserveEncryption) {
        if (mockWasm.writePdf) return mockWasm.writePdf(preserveEncryption);
        return new Uint8Array(0);
    }
    close() {
        if (mockWasm.close) return mockWasm.close();
    }
    getPageCount() {
        if (mockWasm.getPageCount) return mockWasm.getPageCount();
        return 1;
    }
    delete() {
        if (mockWasm.delete) return mockWasm.delete();
    }
}

export default async function createQpdfModule(_options) {
    return {
        QpdfWasmWrapper: MockQpdfWasmWrapper,
    };
}

/** Reset all mock functions to their defaults (null). */
export function resetMockWasm() {
    for (const key of Object.keys(mockWasm)) mockWasm[key] = null;
}
