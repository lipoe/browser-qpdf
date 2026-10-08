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
#include <qpdf/QPDFObjGen.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>
#include <qpdf/QPDFPageObjectHelper.hh>
#include <qpdf/QPDFWriter.hh>
#include <qpdf/Buffer.hh>
#include <qpdf/QIntC.hh>
#include <qpdf/QUtil.hh>
#include <qpdf/RandomDataProvider.hh>

#include <emscripten/em_js.h>

#include <map>
#include <memory>
#include <optional>
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

// Creates a JS-owned Uint8Array holding a copy of `bytes` (for small values
// that are part of a result object, where a typed_memory_view would require
// the caller to copy before the next call).
static val ownedUint8Array(std::string const& bytes) {
    val array = val::global("Uint8Array").new_(bytes.size());
    if (!bytes.empty()) {
        array.call<void>("set", val(typed_memory_view(bytes.size(),
            reinterpret_cast<unsigned char const*>(bytes.data()))));
    }
    return array;
}

// --- Dictionary facts as JS values ---
//
// Each helper turns one PDF object into the JS value the catalog reports for
// it. They are the only place that decides how a missing or unexpected value
// is represented, so every fact of the same shape is reported the same way.
// Rule for absent keys: a spec-defined default is reported as the fact; an
// absent key without a spec default is JS null. Values are read as written,
// never derived from stream data.

// Integer value; 0 when missing or not an integer (0.1.0 contract for
// /Width, /Height and /Length).
static int intOrZero(QPDFObjectHandle const& obj) {
    return obj.isInteger() ? static_cast<int>(obj.getIntValue()) : 0;
}

// Integer value; JS null when the key is missing; 0 when present but not an
// integer (0.1.0 contract for /BitsPerComponent).
static val intOrNull(QPDFObjectHandle const& obj) {
    if (obj.isNull()) {
        return val::null();
    }
    return val(intOrZero(obj));
}

// Integer value, or JS null when missing or not an integer.
static val integerOrNull(QPDFObjectHandle const& obj) {
    return obj.isInteger() ? val(static_cast<int>(obj.getIntValue())) : val::null();
}

// Name with its leading slash; any other value as qpdf serialises it (PDF
// syntax, indirect references unresolved); JS null when the key is missing
// (0.1.0 contract for /ColorSpace and /Filter).
static val nameOrUnparse(QPDFObjectHandle const& obj) {
    if (obj.isNull()) {
        return val::null();
    }
    if (obj.isName()) {
        return val(obj.getName());
    }
    return val(obj.unparse());
}

// Array of numbers as a JS array; JS null when missing, not an array, or
// containing a non-numeric element (e.g. /Decode).
static val numberArrayOrNull(QPDFObjectHandle const& obj) {
    if (!obj.isArray()) {
        return val::null();
    }
    val array = val::array();
    for (int i = 0; i < obj.getArrayNItems(); ++i) {
        QPDFObjectHandle item = obj.getArrayItem(i);
        if (!item.isNumber()) {
            return val::null();
        }
        array.call<void>("push", item.getNumericValue());
    }
    return array;
}

// {objId, generation} of an object.
static val objRef(QPDFObjGen og) {
    val ref = val::object();
    ref.set("objId", og.getObj());
    ref.set("generation", og.getGen());
    return ref;
}

// {objId, generation} when `obj` is a stream (streams are always indirect
// objects); JS null otherwise.
static val streamRefOrNull(QPDFObjectHandle const& obj) {
    return obj.isStream() ? objRef(obj.getObjGen()) : val::null();
}

// PDF name without its leading slash.
static std::string bareName(std::string const& name) {
    return (!name.empty() && name[0] == '/') ? name.substr(1) : name;
}

static val stringArray(std::vector<std::string> const& items) {
    val array = val::array();
    for (auto const& item : items) {
        array.call<void>("push", item);
    }
    return array;
}

static val intArray(std::set<int> const& items) {
    val array = val::array();
    for (int item : items) {
        array.call<void>("push", item);
    }
    return array;
}

// --- Filters ---

// The inline-image filter abbreviations of ISO 32000-1 table 94. qpdf accepts
// them for stream filters too (QPDF_Stream.cc, expand_filter_name); the
// catalog reports the full names so one filter has one spelling.
static std::string expandFilterAbbreviation(std::string const& name) {
    static std::map<std::string, std::string> const abbreviations = {
        {"/AHx", "/ASCIIHexDecode"}, {"/A85", "/ASCII85Decode"}, {"/LZW", "/LZWDecode"},
        {"/Fl", "/FlateDecode"},     {"/RL", "/RunLengthDecode"}, {"/CCF", "/CCITTFaxDecode"},
        {"/DCT", "/DCTDecode"},
    };
    auto it = abbreviations.find(name);
    return it == abbreviations.end() ? name : it->second;
}

// Filter chain of a stream in application order, full names without leading
// slash; empty when the stream is unfiltered. Elements that are not names
// are skipped (the raw syntax remains visible in the `filter` string).
static std::vector<std::string> filterNames(QPDFObjectHandle const& dict) {
    std::vector<std::string> names;
    QPDFObjectHandle filter = dict.getKey("/Filter");
    auto add = [&names](QPDFObjectHandle const& item) {
        if (item.isName()) {
            names.push_back(bareName(expandFilterAbbreviation(item.getName())));
        }
    };
    if (filter.isArray()) {
        for (int i = 0; i < filter.getArrayNItems(); ++i) {
            add(filter.getArrayItem(i));
        }
    } else {
        add(filter);
    }
    return names;
}

// --- Colour spaces ---

// Structured colour space facts (ISO 32000-1 §8.6) as a discriminated union
// on `family`. Indirect references are resolved; `raw` is the PDF syntax
// resolved one level. Forms the spec does not allow (e.g. a bare /CalRGB
// name) are reported as 'Unknown' with their raw syntax.
static val colorSpaceInfo(QPDFObjectHandle cs, int depth = 0);

static val colorSpaceFamily(char const* family, val components, std::string const& raw) {
    val info = val::object();
    info.set("family", val(family));
    info.set("components", components);
    info.set("raw", val(raw));
    return info;
}

static val unknownColorSpace(std::string const& raw) {
    return colorSpaceFamily("Unknown", val::null(), raw);
}

static val colorSpaceInfo(QPDFObjectHandle cs, int depth) {
    std::string raw = cs.unparseResolved();
    if (depth > 8) {
        return unknownColorSpace(raw);  // Indexed/Separation nesting is bounded in valid PDFs
    }

    if (cs.isName()) {
        std::string name = cs.getName();
        if (name == "/DeviceGray") return colorSpaceFamily("DeviceGray", val(1), raw);
        if (name == "/DeviceRGB") return colorSpaceFamily("DeviceRGB", val(3), raw);
        if (name == "/DeviceCMYK") return colorSpaceFamily("DeviceCMYK", val(4), raw);
        if (name == "/Pattern") return colorSpaceFamily("Pattern", val::null(), raw);
        return unknownColorSpace(raw);
    }

    if (!cs.isArray() || cs.getArrayNItems() < 1 || !cs.getArrayItem(0).isName()) {
        return unknownColorSpace(raw);
    }
    std::string family = cs.getArrayItem(0).getName();
    int n = cs.getArrayNItems();

    if (family == "/CalGray") return colorSpaceFamily("CalGray", val(1), raw);
    if (family == "/CalRGB") return colorSpaceFamily("CalRGB", val(3), raw);
    if (family == "/Lab") return colorSpaceFamily("Lab", val(3), raw);
    if (family == "/Pattern") return colorSpaceFamily("Pattern", val::null(), raw);

    if (family == "/ICCBased") {
        // [ /ICCBased stream ]; /N of the profile stream is the component count
        QPDFObjectHandle profile = n >= 2 ? cs.getArrayItem(1) : QPDFObjectHandle::newNull();
        val components = profile.isStream() ? integerOrNull(profile.getDict().getKey("/N")) : val::null();
        val info = colorSpaceFamily("ICCBased", components, raw);
        info.set("iccProfile", streamRefOrNull(profile));
        return info;
    }

    if (family == "/Indexed") {
        // [ /Indexed base hival lookup ]; lookup is a string or a stream
        if (n != 4 || !cs.getArrayItem(2).isInteger()) {
            return unknownColorSpace(raw);
        }
        QPDFObjectHandle lookup = cs.getArrayItem(3);
        std::string table;
        if (lookup.isString()) {
            table = lookup.getStringValue();
        } else if (lookup.isStream()) {
            auto buf = lookup.getStreamData(qpdf_dl_all);
            table.assign(reinterpret_cast<char const*>(buf->getBuffer()), buf->getSize());
        } else {
            return unknownColorSpace(raw);
        }
        val info = colorSpaceFamily("Indexed", val(1), raw);
        info.set("base", colorSpaceInfo(cs.getArrayItem(1), depth + 1));
        info.set("hival", static_cast<int>(cs.getArrayItem(2).getIntValue()));
        info.set("lookup", ownedUint8Array(table));
        return info;
    }

    if (family == "/Separation" || family == "/DeviceN") {
        // [ /Separation name alternate tint ] or [ /DeviceN names alternate tint attrs? ]
        if (n < 3) {
            return unknownColorSpace(raw);
        }
        std::vector<std::string> names;
        QPDFObjectHandle colorants = cs.getArrayItem(1);
        if (family == "/Separation" && colorants.isName()) {
            names.push_back(bareName(colorants.getName()));
        } else if (family == "/DeviceN" && colorants.isArray()) {
            for (int i = 0; i < colorants.getArrayNItems(); ++i) {
                QPDFObjectHandle item = colorants.getArrayItem(i);
                if (!item.isName()) return unknownColorSpace(raw);
                names.push_back(bareName(item.getName()));
            }
        } else {
            return unknownColorSpace(raw);
        }
        QPDFObjectHandle alternate = cs.getArrayItem(2);
        val info = colorSpaceFamily(family == "/Separation" ? "Separation" : "DeviceN",
                                    val(static_cast<int>(names.size())), raw);
        info.set("names", stringArray(names));
        info.set("alternate", alternate.isNull() ? val::null() : colorSpaceInfo(alternate, depth + 1));
        return info;
    }

    return unknownColorSpace(raw);
}

// --- Image catalog ---

// What the traversal collects per image XObject before the catalog entries
// are built: the stream and its relations to pages and to other images.
struct CatalogEntry {
    QPDFObjectHandle image;
    std::set<int> pages;        // reachable from these pages (within the requested scope)
    std::set<int> directPages;  // named in these pages' own /Resources /XObject
    std::optional<QPDFObjGen> softMask;           // /SMask stream
    enum class MaskKind { None, Stencil, ColorKey } maskKind = MaskKind::None;
    std::optional<QPDFObjGen> stencilMask;        // /Mask stream (maskKind == Stencil)
    std::vector<QPDFObjGen> softMaskOf;           // images whose /SMask is this stream
    std::vector<QPDFObjGen> maskOf;               // images whose /Mask is this stream
};

// std::map keeps the catalog in ascending (objId, generation) order: the
// result order is a property of the catalog, not of the traversal.
using Catalog = std::map<QPDFObjGen, CatalogEntry>;

// Facts read from the image's own stream dictionary (no relations):
// objId, generation, width, height, bitsPerComponent, colorSpace, filter,
// streamLength (0.1.0 fields, unchanged) plus colorSpaceInfo, filters, decode.
static val readImageDictionaryFacts(QPDFObjectHandle& image) {
    QPDFObjectHandle dict = image.getDict();
    val info = val::object();
    info.set("objId", image.getObjectID());
    info.set("generation", image.getGeneration());
    info.set("width", intOrZero(dict.getKey("/Width")));
    info.set("height", intOrZero(dict.getKey("/Height")));
    info.set("bitsPerComponent", intOrNull(dict.getKey("/BitsPerComponent")));
    info.set("colorSpace", nameOrUnparse(dict.getKey("/ColorSpace")));
    info.set("filter", nameOrUnparse(dict.getKey("/Filter")));
    // Encoded (raw) byte length as declared in the dictionary
    info.set("streamLength", intOrZero(dict.getKey("/Length")));

    QPDFObjectHandle colorSpace = dict.getKey("/ColorSpace");
    info.set("colorSpaceInfo", colorSpace.isNull() ? val::null() : colorSpaceInfo(colorSpace));
    info.set("filters", stringArray(filterNames(dict)));
    info.set("decode", numberArrayOrNull(dict.getKey("/Decode")));
    return info;
}

// ImageMaskInfo: the image's own mask facts plus the relations collected in
// the mask pass.
static val readMaskInfo(CatalogEntry const& entry) {
    QPDFObjectHandle dict = entry.image.getDict();
    QPDFObjectHandle imageMask = dict.getKey("/ImageMask");

    val masks = val::object();
    masks.set("isStencilMask", imageMask.isBool() && imageMask.getBoolValue());
    masks.set("softMaskInData", integerOrNull(dict.getKey("/SMaskInData")));
    masks.set("softMask", entry.softMask ? objRef(*entry.softMask) : val::null());

    val mask = val::null();
    if (entry.maskKind == CatalogEntry::MaskKind::Stencil && entry.stencilMask) {
        mask = val::object();
        mask.set("kind", val("stencil"));
        mask.set("ref", objRef(*entry.stencilMask));
    } else if (entry.maskKind == CatalogEntry::MaskKind::ColorKey) {
        mask = val::object();
        mask.set("kind", val("colorKey"));
    }
    masks.set("mask", mask);

    val softMaskOf = val::array();
    for (auto const& og : entry.softMaskOf) softMaskOf.call<void>("push", objRef(og));
    masks.set("softMaskOf", softMaskOf);
    val maskOf = val::array();
    for (auto const& og : entry.maskOf) maskOf.call<void>("push", objRef(og));
    masks.set("maskOf", maskOf);
    return masks;
}

// Fills the mask relations of every catalog entry from /SMask and /Mask.
// Back-references are only recorded for targets that are in the catalog;
// the forward reference is reported either way. One malformed dictionary
// degrades to "no mask facts" for that image only.
static void collectMaskRelations(Catalog& catalog) {
    for (auto& [og, entry] : catalog) {
        try {
            QPDFObjectHandle dict = entry.image.getDict();

            QPDFObjectHandle softMask = dict.getKey("/SMask");
            if (softMask.isStream()) {
                entry.softMask = softMask.getObjGen();
                auto target = catalog.find(*entry.softMask);
                if (target != catalog.end()) target->second.softMaskOf.push_back(og);
            }

            QPDFObjectHandle mask = dict.getKey("/Mask");
            if (mask.isStream()) {
                entry.maskKind = CatalogEntry::MaskKind::Stencil;
                entry.stencilMask = mask.getObjGen();
                auto target = catalog.find(*entry.stencilMask);
                if (target != catalog.end()) target->second.maskOf.push_back(og);
            } else if (mask.isArray()) {
                entry.maskKind = CatalogEntry::MaskKind::ColorKey;
            }
        } catch (std::exception const&) {
            entry.softMask.reset();
            entry.maskKind = CatalogEntry::MaskKind::None;
            entry.stencilMask.reset();
        }
    }
}

// One ImageInfo from a catalog entry.
static val buildImageInfo(CatalogEntry& entry) {
    val info = readImageDictionaryFacts(entry.image);
    info.set("masks", readMaskInfo(entry));
    info.set("pages", intArray(entry.pages));
    info.set("directPages", intArray(entry.directPages));
    return info;
}

// Image XObjects including stencil masks (/ImageMask true), which qpdf's
// forEachImage excludes by default.
static bool isImageOrStencilMask(QPDFObjectHandle obj) {
    return obj.isImage(false);
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
     * Get a list of all image XObjects in the PDF with their facts.
     * Returns a JS array of ImageInfo objects (see buildImageInfo), in
     * ascending (objId, generation) order.
     *
     * Each page is traversed once within the requested scope (recursive =
     * through Form XObjects) to collect membership and `pages`, and once
     * without recursion to collect `directPages`. A second pass over the
     * collected images reads the mask relations. Images are deduplicated by
     * object; stencil masks (/ImageMask true) are included.
     *
     * Errors during traversal are not reported; the images collected so far
     * are returned.
     */
    val getImages(bool recursive) {
        return withDocument([&]() {
            Catalog catalog;

            try {
                auto pages = QPDFPageDocumentHelper(*qpdf_).getAllPages();
                for (size_t p = 0; p < pages.size(); ++p) {
                    int pageIndex = static_cast<int>(p);
                    pages[p].forEachXObject(
                        recursive,
                        [&catalog, pageIndex](QPDFObjectHandle& image, QPDFObjectHandle&, std::string const&) {
                            CatalogEntry& entry = catalog[image.getObjGen()];
                            entry.image = image;
                            entry.pages.insert(pageIndex);
                        },
                        isImageOrStencilMask);
                    if (recursive) {
                        pages[p].forEachXObject(
                            false,
                            [&catalog, pageIndex](QPDFObjectHandle& image, QPDFObjectHandle&, std::string const&) {
                                catalog[image.getObjGen()].directPages.insert(pageIndex);
                            },
                            isImageOrStencilMask);
                    }
                }
            } catch (std::exception const& /*e*/) {
                // Known implicit contract (kept for compatibility, see README):
                // errors while traversing pages are swallowed and the images
                // collected so far are returned as a successful result.
            }
            if (!recursive) {
                // Without recursion every reachable page is a direct page
                for (auto& [og, entry] : catalog) entry.directPages = entry.pages;
            }

            collectMaskRelations(catalog);

            val result = val::array();
            for (auto& [og, entry] : catalog) {
                result.call<void>("push", buildImageInfo(entry));
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
