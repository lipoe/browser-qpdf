/**
 * qpdf WASM Wrapper for Image Stream Manipulation
 *
 * Thin C++ wrapper using Emscripten Embind to expose qpdf's library API
 * to JavaScript/TypeScript. Uses emscripten::val for input (Uint8Array from JS)
 * and typed_memory_view for zero-copy binary output.
 *
 * Operations:
 * 1. Load a PDF from a Uint8Array (with optional password)
 * 2. Enumerate image XObjects (with metadata)
 * 3. Read decoded or raw image stream data
 * 4. Replace image stream data with new content and metadata
 * 5. Write the modified PDF to a Uint8Array
 * 6. Explicit close() for memory management
 *
 * The wrapper catches all C++ exceptions at the boundary and returns
 * structured result objects {success, kind, error} to JavaScript.
 */

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <qpdf/QPDF.hh>
#include <qpdf/QPDFExc.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>
#include <qpdf/QPDFPageObjectHelper.hh>
#include <qpdf/QPDFWriter.hh>
#include <qpdf/Buffer.hh>
#include <qpdf/QIntC.hh>
#include <qpdf/QUtil.hh>
#include <qpdf/RandomDataProvider.hh>

#include <emscripten/em_js.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include <cstring>
#include <set>

using namespace emscripten;

// --- Random data source ---
//
// qpdf needs cryptographically secure random bytes for AES (IVs) and AES-256
// (key derivation). Its default source reads /dev/urandom, which does not exist
// in this filesystem-free WASM build. The Web Crypto API is available in
// browsers, Web Workers and Node >= 18 via globalThis.crypto.

// Fills `len` bytes at `data` from crypto.getRandomValues (max 65536 bytes per
// call). Returns 0 if no Web Crypto implementation is available.
EM_JS(int, fill_with_web_crypto_random, (unsigned char* data, size_t len), {
    var webCrypto = globalThis['crypto'];
    if (!webCrypto || typeof webCrypto['getRandomValues'] !== 'function') {
        return 0;
    }
    for (var offset = 0; offset < len; offset += 65536) {
        var end = Math.min(offset + 65536, len);
        webCrypto['getRandomValues'](HEAPU8.subarray(data + offset, data + end));
    }
    return 1;
});

class WebCryptoRandomDataProvider : public RandomDataProvider {
public:
    void provideRandomData(unsigned char* data, size_t len) override {
        if (!fill_with_web_crypto_random(data, len)) {
            throw std::runtime_error(
                "no secure random source available: globalThis.crypto.getRandomValues is missing");
        }
    }
};

// Registered once at module initialization, before any QPDF instance exists.
static WebCryptoRandomDataProvider webCryptoRandomDataProvider;
[[maybe_unused]] static bool const webCryptoRandomDataProviderRegistered =
    (QUtil::setRandomDataProvider(&webCryptoRandomDataProvider), true);

// --- Helper: create a success result ---
static val makeSuccess() {
    val result = val::object();
    result.set("success", true);
    return result;
}

// --- Error results ---
//
// Every error carries a technical `kind` derived from the exception type, so
// the TypeScript layer can map errors to stable codes without parsing texts:
//   password          QPDFExc with qpdf_e_password
//   damaged_pdf       QPDFExc with qpdf_e_damaged_pdf (input is not a readable PDF)
//   invalid_argument  caller passed an object reference that is not a stream
//   disposed          close() was already called
//   unknown           anything else

static val makeError(std::string const& message, char const* kind) {
    val result = val::object();
    result.set("success", false);
    result.set("kind", val(kind));
    result.set("error", val(message));
    return result;
}

static char const* errorKindOf(QPDFExc const& e) {
    switch (e.getErrorCode()) {
    case qpdf_e_password:
        return "password";
    case qpdf_e_damaged_pdf:
        return "damaged_pdf";
    default:
        return "unknown";
    }
}

static val makeDisposedError() {
    return makeError("Instance has been disposed", "disposed");
}

static val makeNoPdfError() {
    return makeError("No PDF loaded", "unknown");
}

// --- Exception boundary ---

// Runs `body` and converts every C++ exception into an error result. This is
// the only place where exceptions are classified into error kinds. (getImages
// and getPageCount additionally swallow traversal errors by design; see there.)
template <typename Body>
static val guarded(Body&& body) {
    try {
        return body();
    } catch (QPDFExc const& e) {
        return makeError(e.what(), errorKindOf(e));
    } catch (std::exception const& e) {
        return makeError(e.what(), "unknown");
    }
}

// Copies a JS Uint8Array into `target` (WASM memory).
static void copyFromJs(val const& uint8Array, std::vector<uint8_t>& target) {
    unsigned int length = uint8Array["length"].as<unsigned int>();
    target.resize(length);
    val memoryView = val::global("Uint8Array").new_(
        val::module_property("HEAPU8")["buffer"],
        reinterpret_cast<uintptr_t>(target.data()),
        length
    );
    memoryView.call<void>("set", uint8Array);
}

// --- Main wrapper class ---

class QpdfWasmWrapper {
public:
    QpdfWasmWrapper() : qpdf_(nullptr), closed_(false) {}

    /**
     * Load a PDF from a Uint8Array (JS) without password.
     * Returns {success: true} or {success: false, kind, error}.
     */
    val loadPdf(val uint8Array) {
        return load(uint8Array, nullptr);
    }

    /**
     * Load an encrypted PDF from a Uint8Array with a password.
     * Returns {success: true} or {success: false, kind, error}.
     */
    val loadPdfWithPassword(val uint8Array, std::string password) {
        return load(uint8Array, password.c_str());
    }

    /**
     * Get a list of all images in the PDF with their metadata.
     * Returns a JS array of ImageInfo objects.
     *
     * Each ImageInfo has: objId, generation, width, height,
     * bitsPerComponent (int|null), colorSpace (string|null),
     * filter (string|null), streamLength.
     *
     * Deduplicates across pages using objId+generation.
     * When recursive=true, traverses Form XObjects (qpdf handles depth internally).
     * Errors during traversal are not reported; the images found so far are returned.
     */
    val getImages(bool recursive) {
        return withDocument([&]() {
            val result = val::array();
            std::set<QPDFObjGen> seen;

            try {
                QPDFPageDocumentHelper pdh(*qpdf_);
                auto pages = pdh.getAllPages();

                for (auto& page : pages) {
                    page.forEachImage(
                        recursive,
                        [&result, &seen](QPDFObjectHandle& obj,
                                         QPDFObjectHandle& /*xobj_dict*/,
                                         std::string const& /*key*/) {
                            // Deduplicate across pages
                            QPDFObjGen og = obj.getObjGen();
                            if (seen.count(og) > 0) {
                                return;
                            }
                            seen.insert(og);

                            // Get stream dictionary
                            QPDFObjectHandle dict = obj.getDict();

                            // Build ImageInfo object
                            val info = val::object();
                            info.set("objId", obj.getObjectID());
                            info.set("generation", obj.getGeneration());

                            // Width and Height (required fields)
                            QPDFObjectHandle widthObj = dict.getKey("/Width");
                            info.set("width", widthObj.isInteger()
                                ? static_cast<int>(widthObj.getIntValue()) : 0);

                            QPDFObjectHandle heightObj = dict.getKey("/Height");
                            info.set("height", heightObj.isInteger()
                                ? static_cast<int>(heightObj.getIntValue()) : 0);

                            // BitsPerComponent (optional - null if missing)
                            QPDFObjectHandle bpcObj = dict.getKey("/BitsPerComponent");
                            if (bpcObj.isNull()) {
                                info.set("bitsPerComponent", val::null());
                            } else {
                                info.set("bitsPerComponent",
                                    bpcObj.isInteger()
                                        ? static_cast<int>(bpcObj.getIntValue()) : 0);
                            }

                            // ColorSpace (optional - null if missing)
                            QPDFObjectHandle csObj = dict.getKey("/ColorSpace");
                            if (csObj.isNull()) {
                                info.set("colorSpace", val::null());
                            } else if (csObj.isName()) {
                                info.set("colorSpace", val(csObj.getName()));
                            } else {
                                // Array or other complex type - unparse to string
                                info.set("colorSpace", val(csObj.unparse()));
                            }

                            // Filter (optional - null if missing)
                            QPDFObjectHandle filterObj = dict.getKey("/Filter");
                            if (filterObj.isNull()) {
                                info.set("filter", val::null());
                            } else if (filterObj.isName()) {
                                info.set("filter", val(filterObj.getName()));
                            } else {
                                // Array or other type - unparse to string
                                info.set("filter", val(filterObj.unparse()));
                            }

                            // Stream length (encoded/raw byte length)
                            QPDFObjectHandle lengthObj = dict.getKey("/Length");
                            info.set("streamLength", lengthObj.isInteger()
                                ? static_cast<int>(lengthObj.getIntValue()) : 0);

                            result.call<void>("push", info);
                        });
                }
            } catch (std::exception const& /*e*/) {
                // Known implicit contract (kept for compatibility, see README):
                // errors while traversing pages are swallowed and the images
                // collected so far are returned as a successful result.
            }

            return result;
        });
    }

    /**
     * Read the decoded (uncompressed) image stream data for a given object.
     * Returns a typed_memory_view as Uint8Array.
     * Decodes all filters (Flate, DCT, etc.) to produce raw pixel data.
     */
    val getImageStreamData(int objId, int generation) {
        return readStream(objId, generation, true);
    }

    /**
     * Read the raw (compressed/encoded) stream data without decoding.
     * Returns a typed_memory_view as Uint8Array.
     * Returns the stream bytes as-is (no filter decoding applied).
     */
    val getRawImageStreamData(int objId, int generation) {
        return readStream(objId, generation, false);
    }

    /**
     * Replace an image stream with new data and metadata.
     * Accepts Uint8Array for data and a val object for metadata.
     *
     * Metadata fields:
     *   width (int): 0 means keep existing
     *   height (int): 0 means keep existing
     *   bitsPerComponent (int): 0 means keep existing
     *   colorSpace (string): empty means keep existing
     *   filter (string): empty means keep existing
     *
     * Always updates /Length to the new data byte length.
     * Returns {success: true} or {success: false, error: "..."}.
     */
    val replaceImageStream(int objId, int generation, val uint8Array, val metadata) {
        return withDocument([&]() {
            // Get the object and verify it's a stream
            QPDFObjectHandle obj = qpdf_->getObjectByID(objId, generation);
            if (!obj.isStream()) {
                return makeError("Object is not a stream", "invalid_argument");
            }

            // Copy the Uint8Array from JS to C++
            std::vector<uint8_t> data;
            copyFromJs(uint8Array, data);
            size_t length = data.size();

            // Read metadata fields from the val object
            int width = metadata["width"].as<int>();
            int height = metadata["height"].as<int>();
            int bitsPerComponent = metadata["bitsPerComponent"].as<int>();
            std::string colorSpace = metadata["colorSpace"].as<std::string>();
            std::string filter = metadata["filter"].as<std::string>();

            // Determine the filter object for replaceStreamData
            QPDFObjectHandle filterObj = QPDFObjectHandle::newNull();
            QPDFObjectHandle decodeParms = QPDFObjectHandle::newNull();

            // Normalize filter: ensure leading slash (PDF name convention)
            if (!filter.empty() && filter[0] != '/') {
                filter = "/" + filter;
            }

            if (!filter.empty()) {
                // Use the provided filter
                filterObj = QPDFObjectHandle::newName(filter);
            } else {
                // Keep the original filter if it exists
                QPDFObjectHandle dict = obj.getDict();
                if (dict.hasKey("/Filter")) {
                    filterObj = dict.getKey("/Filter");
                }
                if (dict.hasKey("/DecodeParms")) {
                    decodeParms = dict.getKey("/DecodeParms");
                }
            }

            // Create the buffer for replaceStreamData
            auto buf = std::make_shared<Buffer>(data.size());
            std::memcpy(buf->getBuffer(), data.data(), data.size());

            // Replace the stream data
            obj.replaceStreamData(buf, filterObj, decodeParms);

            // Update dictionary keys
            QPDFObjectHandle dict = obj.getDict();

            // Always update /Length to the new data byte length
            dict.replaceKey("/Length",
                QPDFObjectHandle::newInteger(static_cast<long long>(length)));

            // Update /Width only if metadata width > 0
            if (width > 0) {
                dict.replaceKey("/Width",
                    QPDFObjectHandle::newInteger(width));
            }

            // Update /Height only if metadata height > 0
            if (height > 0) {
                dict.replaceKey("/Height",
                    QPDFObjectHandle::newInteger(height));
            }

            // Update /BitsPerComponent only if metadata bitsPerComponent > 0
            if (bitsPerComponent > 0) {
                dict.replaceKey("/BitsPerComponent",
                    QPDFObjectHandle::newInteger(bitsPerComponent));
            }

            // Update /ColorSpace only if metadata colorSpace is non-empty
            if (!colorSpace.empty()) {
                dict.replaceKey("/ColorSpace",
                    QPDFObjectHandle::newName("/" + colorSpace));
            }

            // Update /Filter only if metadata filter is non-empty
            if (!filter.empty()) {
                dict.replaceKey("/Filter",
                    QPDFObjectHandle::newName(filter));
            }

            return makeSuccess();
        });
    }

    /**
     * Whether the loaded (source) PDF is encrypted.
     * Returns a boolean, or an error object if disposed / not loaded.
     */
    val isEncrypted() {
        return withDocument([&]() { return val(qpdf_->isEncrypted()); });
    }

    /**
     * Write the (modified) PDF to a memory buffer.
     *
     * preserveEncryption=true keeps the source document's encryption
     * (QPDFWriter default); false writes an unencrypted PDF.
     * Returns a typed_memory_view as Uint8Array that remains valid until
     * the next call that modifies outputBuffer_.
     *
     * Uses QPDFWriter with setOutputMemory() to serialize the PDF in memory.
     * The result is copied into outputBuffer_ so that the typed_memory_view
     * pointer remains valid until the caller copies it out (or until the next
     * call that overwrites outputBuffer_).
     */
    val writePdf(bool preserveEncryption) {
        return withDocument([&]() {
            QPDFWriter writer(*qpdf_);
            writer.setOutputMemory();
            writer.setPreserveEncryption(preserveEncryption);
            // Use default decode level - QPDFWriter handles replaced streams correctly
            writer.write();

            std::shared_ptr<Buffer> buf = writer.getBufferSharedPointer();

            // Copy into member buffer so the typed_memory_view stays valid
            outputBuffer_.assign(
                buf->getBuffer(),
                buf->getBuffer() + buf->getSize()
            );

            return val(typed_memory_view(outputBuffer_.size(), outputBuffer_.data()));
        });
    }

    /**
     * Release all resources held by the QPDF instance.
     * After close(), all methods return a disposed error.
     * Multiple close() calls are no-ops.
     */
    void close() {
        if (closed_) {
            return;  // no-op on subsequent calls
        }
        closed_ = true;
        qpdf_.reset();
        inputBuffer_.clear();
        inputBuffer_.shrink_to_fit();
        outputBuffer_.clear();
        outputBuffer_.shrink_to_fit();
    }

    /**
     * Get the number of pages in the loaded PDF.
     */
    int getPageCount() {
        if (closed_ || !qpdf_) return 0;
        try {
            return static_cast<int>(
                QPDFPageDocumentHelper(*qpdf_).getAllPages().size());
        } catch (std::exception const&) {
            return 0;
        }
    }

private:
    // Runs `body` on the loaded document: rejects disposed/unloaded instances
    // and converts exceptions via guarded().
    template <typename Body>
    val withDocument(Body&& body) {
        if (closed_) {
            return makeDisposedError();
        }
        if (!qpdf_) {
            return makeNoPdfError();
        }
        return guarded(body);
    }

    // Loads a PDF; password == nullptr means no password.
    val load(val const& uint8Array, char const* password) {
        if (closed_) {
            return makeDisposedError();
        }
        val result = guarded([&]() {
            // Copy from JS heap to C++ heap; qpdf reads from this buffer
            copyFromJs(uint8Array, inputBuffer_);

            // Create a fresh QPDF instance
            qpdf_ = std::make_unique<QPDF>();
            qpdf_->processMemoryFile(
                "input.pdf",
                reinterpret_cast<char const*>(inputBuffer_.data()),
                inputBuffer_.size(),
                password
            );
            return makeSuccess();
        });
        if (!result["success"].as<bool>()) {
            qpdf_.reset();
        }
        return result;
    }

    // Reads stream data of an object, decoded (all filters) or raw.
    val readStream(int objId, int generation, bool decode) {
        return withDocument([&]() {
            QPDFObjectHandle obj = qpdf_->getObjectByID(objId, generation);
            if (!obj.isStream()) {
                return makeError(
                    "Object " + std::to_string(objId) + " " + std::to_string(generation) + " is not a stream",
                    "invalid_argument");
            }

            std::shared_ptr<Buffer> buf =
                decode ? obj.getStreamData(qpdf_dl_all) : obj.getRawStreamData();

            // Copy into member buffer so the typed_memory_view stays valid
            outputBuffer_.assign(buf->getBuffer(), buf->getBuffer() + buf->getSize());

            return val(typed_memory_view(outputBuffer_.size(), outputBuffer_.data()));
        });
    }

    std::unique_ptr<QPDF> qpdf_;
    std::vector<uint8_t> inputBuffer_;   // Keeps PDF data alive for qpdf
    std::vector<uint8_t> outputBuffer_;  // Keeps typed_memory_view valid
    bool closed_;
};

// --- Embind bindings ---
// All methods use emscripten::val for structured JS interop.
// No value_object or register_vector needed: all I/O is via val objects
// and typed_memory_view for binary data output.

EMSCRIPTEN_BINDINGS(qpdf_wrapper) {
    class_<QpdfWasmWrapper>("QpdfWasmWrapper")
        .constructor<>()
        .function("loadPdf", &QpdfWasmWrapper::loadPdf)
        .function("loadPdfWithPassword", &QpdfWasmWrapper::loadPdfWithPassword)
        .function("getImages", &QpdfWasmWrapper::getImages)
        .function("getImageStreamData", &QpdfWasmWrapper::getImageStreamData)
        .function("getRawImageStreamData", &QpdfWasmWrapper::getRawImageStreamData)
        .function("replaceImageStream", &QpdfWasmWrapper::replaceImageStream)
        .function("isEncrypted", &QpdfWasmWrapper::isEncrypted)
        .function("writePdf", &QpdfWasmWrapper::writePdf)
        .function("close", &QpdfWasmWrapper::close)
        .function("getPageCount", &QpdfWasmWrapper::getPageCount);
}
