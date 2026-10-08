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

#include <algorithm>
#include <cmath>
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
// additionally degrades to partial facts on traversal errors by design; see there.)
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

// Integer value, or JS null when missing or not an integer.
static val integerOrNull(QPDFObjectHandle const& obj) {
    return obj.isInteger() ? val(static_cast<int>(obj.getIntValue())) : val::null();
}

// 0.1.0 contract for /BitsPerComponent only: JS null when the key is
// missing, but 0 when it is present and not an integer (where integerOrNull
// would report null). Kept as is because it is a published value; a
// candidate for 1.0.
static val legacyIntOrNull(QPDFObjectHandle const& obj) {
    if (obj.isNull()) {
        return val::null();
    }
    return val(intOrZero(obj));
}

// Integer value, or `fallback` when the key is missing. For keys whose
// default the spec defines (that default is a fact about the PDF).
static int integerOr(QPDFObjectHandle const& obj, int fallback) {
    return obj.isInteger() ? static_cast<int>(obj.getIntValue()) : fallback;
}

// Boolean value, or `fallback` when the key is missing (spec default).
static bool boolOr(QPDFObjectHandle const& obj, bool fallback) {
    return obj.isBool() ? obj.getBoolValue() : fallback;
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

// JS array of `convert(item)` for every item of a C++ sequence.
template <typename Items, typename Convert>
static val toJsArray(Items const& items, Convert&& convert) {
    val array = val::array();
    for (auto const& item : items) {
        array.call<void>("push", convert(item));
    }
    return array;
}

static val stringArray(std::vector<std::string> const& items) {
    return toJsArray(items, [](std::string const& s) { return val(s); });
}

static val intArray(std::set<int> const& items) {
    return toJsArray(items, [](int i) { return val(i); });
}

static val refArray(std::vector<QPDFObjGen> const& items) {
    return toJsArray(items, [](QPDFObjGen og) { return objRef(og); });
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
    // Valid nesting is at most three levels (Indexed over Separation over its
    // alternate); the bound only stops reference cycles in damaged files.
    if (depth > 8) {
        return unknownColorSpace(raw);
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

    // Rule for every array family below: the family is reported only when
    // the array has the shape the spec requires; otherwise 'Unknown' with raw.

    if (family == "/ICCBased") {
        // [ /ICCBased stream ]; /N of the profile stream is the component count
        if (n < 2 || !cs.getArrayItem(1).isStream()) {
            return unknownColorSpace(raw);
        }
        QPDFObjectHandle profile = cs.getArrayItem(1);
        val info = colorSpaceFamily("ICCBased", integerOrNull(profile.getDict().getKey("/N")), raw);
        info.set("iccProfile", objRef(profile.getObjGen()));
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
            // The only decode inside the catalog; a damaged lookup stream
            // degrades this colour space to Unknown instead of failing getImages.
            try {
                auto buf = lookup.getStreamData(qpdf_dl_all);
                table.assign(reinterpret_cast<char const*>(buf->getBuffer()), buf->getSize());
            } catch (std::exception const&) {
                return unknownColorSpace(raw);
            }
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

// Forward declarations: the encoding facts are shared by the catalog and readImage.
static size_t codecCut(std::vector<std::string> const& names);
static QPDFObjectHandle decodeParmsAt(QPDFObjectHandle const& parms, size_t index, size_t chainLength);
static val encodingOf(std::string const& residual, QPDFObjectHandle const& parms);

// ImageEncoding declared by a stream's filter chain, read from the
// dictionary alone: the kind after the container filters and the codec's
// parameters. JS null when the chain has more than one filter after the
// codec (readImage refuses such a chain). Whether the container filters can
// actually be applied (unknown names, damaged data) is only known when
// readImage runs.
static val declaredEncoding(QPDFObjectHandle const& dict) {
    std::vector<std::string> names = filterNames(dict);
    size_t cut = codecCut(names);
    if (names.size() - cut > 1) {
        return val::null();
    }
    std::string residual = cut < names.size() ? names[cut] : "";
    return encodingOf(residual, decodeParmsAt(dict.getKey("/DecodeParms"), cut, names.size()));
}

// Facts read from the image's own stream dictionary (no relations):
// objId, generation, width, height, bitsPerComponent, colorSpace, filter,
// streamLength (0.1.0 fields, unchanged) plus colorSpaceInfo, filters,
// decode, encoding.
static val readImageDictionaryFacts(QPDFObjectHandle& image) {
    QPDFObjectHandle dict = image.getDict();
    val info = val::object();
    info.set("objId", image.getObjectID());
    info.set("generation", image.getGeneration());
    info.set("width", intOrZero(dict.getKey("/Width")));
    info.set("height", intOrZero(dict.getKey("/Height")));
    info.set("bitsPerComponent", legacyIntOrNull(dict.getKey("/BitsPerComponent")));
    info.set("colorSpace", nameOrUnparse(dict.getKey("/ColorSpace")));
    info.set("filter", nameOrUnparse(dict.getKey("/Filter")));
    // Encoded (raw) byte length as declared in the dictionary
    info.set("streamLength", intOrZero(dict.getKey("/Length")));

    QPDFObjectHandle colorSpace = dict.getKey("/ColorSpace");
    info.set("colorSpaceInfo", colorSpace.isNull() ? val::null() : colorSpaceInfo(colorSpace));
    info.set("filters", stringArray(filterNames(dict)));
    info.set("decode", numberArrayOrNull(dict.getKey("/Decode")));
    info.set("encoding", declaredEncoding(dict));
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

    masks.set("softMaskOf", refArray(entry.softMaskOf));
    masks.set("maskOf", refArray(entry.maskOf));
    return masks;
}

// Closes the catalog under mask references: every image XObject that a
// catalog entry names in /SMask or in a stream-valued /Mask becomes an entry
// itself (with empty page sets, since no page resources reach it). Masks are
// found through the image dictionary, never through resources, so without
// this step most soft masks of real PDFs have no facts. Streams that are not
// image XObjects are not added (the forward reference is still reported).
// Repeats until nothing new is added; one malformed dictionary degrades to
// "no masks added for that image" only.
static void closeOverMasks(Catalog& catalog) {
    std::vector<QPDFObjectHandle> pending;
    for (auto& [og, entry] : catalog) pending.push_back(entry.image);
    while (!pending.empty()) {
        QPDFObjectHandle image = pending.back();
        pending.pop_back();
        try {
            QPDFObjectHandle dict = image.getDict();
            for (char const* key : {"/SMask", "/Mask"}) {
                QPDFObjectHandle mask = dict.getKey(key);
                if (!mask.isStream() || !mask.isImage(false)) continue;
                QPDFObjGen og = mask.getObjGen();
                if (catalog.count(og) > 0) continue;
                catalog[og].image = mask;  // pages and directPages stay empty
                pending.push_back(mask);
            }
        } catch (std::exception const&) {
            // this image's mask references are left out of the closure
        }
    }
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

// --- Encoded image: container filters removed, codec reported ---

// The image codecs of ISO 32000-1 table 6. Everything before the first of
// them in a filter chain is container compression that qpdf removes; the
// codec itself is reported, never decoded here. This is the only codec
// knowledge in the wrapper and it is spec content, not qpdf's ability.
static bool isSpecImageCodec(std::string const& name) {
    return name == "DCTDecode" || name == "JPXDecode" || name == "CCITTFaxDecode" || name == "JBIG2Decode";
}

// Index of the first image codec in `names`, or names.size() if none.
static size_t codecCut(std::vector<std::string> const& names) {
    for (size_t i = 0; i < names.size(); ++i) {
        if (isSpecImageCodec(names[i])) return i;
    }
    return names.size();
}

// Copy of `obj` that belongs to `target`: direct values are rebuilt
// recursively, indirect objects are copied with QPDF::copyForeignObject.
// qpdf refuses to attach a handle owned by one document to another, so
// anything that goes into the scratch document passes through here.
static QPDFObjectHandle copyInto(QPDF& target, QPDFObjectHandle const& obj) {
    if (obj.isIndirect()) return target.copyForeignObject(obj);
    if (obj.isArray()) {
        QPDFObjectHandle copy = QPDFObjectHandle::newArray();
        for (int i = 0; i < obj.getArrayNItems(); ++i) copy.appendItem(copyInto(target, obj.getArrayItem(i)));
        return copy;
    }
    if (obj.isDictionary()) {
        QPDFObjectHandle copy = QPDFObjectHandle::newDictionary();
        for (auto const& key : obj.getKeys()) copy.replaceKey(key, copyInto(target, obj.getKey(key)));
        return copy;
    }
    if (obj.isName()) return QPDFObjectHandle::newName(obj.getName());
    if (obj.isInteger()) return QPDFObjectHandle::newInteger(obj.getIntValue());
    if (obj.isReal()) return QPDFObjectHandle::newReal(obj.getRealValue());
    if (obj.isBool()) return QPDFObjectHandle::newBool(obj.getBoolValue());
    if (obj.isString()) return QPDFObjectHandle::newString(obj.getStringValue());
    return QPDFObjectHandle::newNull();
}

// The first `count` entries of /Filter as written (abbreviations intact, qpdf
// expands them itself), owned by `target`: a name for a single filter, an
// array otherwise, null for none.
static QPDFObjectHandle filterPrefix(QPDF& target, QPDFObjectHandle const& filter, size_t count) {
    if (count == 0) return QPDFObjectHandle::newNull();
    if (filter.isName()) return copyInto(target, filter);
    QPDFObjectHandle prefix = QPDFObjectHandle::newArray();
    for (size_t i = 0; i < count && static_cast<int>(i) < filter.getArrayNItems(); ++i) {
        prefix.appendItem(copyInto(target, filter.getArrayItem(static_cast<int>(i))));
    }
    return prefix;
}

// /DecodeParms for the first `count` filters, owned by `target`: sliced when
// it is an array, kept when it is one dictionary for one filter, otherwise
// passed through for qpdf to judge.
static QPDFObjectHandle decodeParmsPrefix(QPDF& target, QPDFObjectHandle const& parms, size_t count) {
    if (count == 0 || parms.isNull()) return QPDFObjectHandle::newNull();
    if (!parms.isArray()) return copyInto(target, parms);
    QPDFObjectHandle prefix = QPDFObjectHandle::newArray();
    for (size_t i = 0; i < count && static_cast<int>(i) < parms.getArrayNItems(); ++i) {
        prefix.appendItem(copyInto(target, parms.getArrayItem(static_cast<int>(i))));
    }
    return prefix;
}

// /DecodeParms entry belonging to the filter at `index` (array: that item;
// single dictionary: only for a single-filter chain), or null.
static QPDFObjectHandle decodeParmsAt(QPDFObjectHandle const& parms, size_t index, size_t chainLength) {
    if (parms.isArray()) {
        return static_cast<int>(index) < parms.getArrayNItems()
            ? parms.getArrayItem(static_cast<int>(index)) : QPDFObjectHandle::newNull();
    }
    if (parms.isDictionary() && chainLength == 1) return parms;
    return QPDFObjectHandle::newNull();
}

// ImageEncoding: what the bytes are after the container filters are gone.
// Codec parameters are typed per codec (ISO 32000-1 §7.4.6, §7.4.7); keys
// the spec gives a default are reported with that default.
static val encodingOf(std::string const& residual, QPDFObjectHandle const& parms) {
    val encoding = val::object();
    if (residual.empty()) {
        encoding.set("kind", val("samples"));
    } else if (residual == "DCTDecode") {
        encoding.set("kind", val("jpeg"));
    } else if (residual == "JPXDecode") {
        encoding.set("kind", val("jpeg2000"));
    } else if (residual == "CCITTFaxDecode") {
        QPDFObjectHandle p = parms.isDictionary() ? parms : QPDFObjectHandle::newDictionary();
        encoding.set("kind", val("ccitt"));
        encoding.set("k", integerOr(p.getKey("/K"), 0));
        encoding.set("columns", integerOr(p.getKey("/Columns"), 1728));
        encoding.set("rows", integerOr(p.getKey("/Rows"), 0));  // 0: height not predetermined (spec)
        encoding.set("blackIs1", boolOr(p.getKey("/BlackIs1"), false));
        encoding.set("byteAlign", boolOr(p.getKey("/EncodedByteAlign"), false));
        encoding.set("endOfLine", boolOr(p.getKey("/EndOfLine"), false));
        encoding.set("endOfBlock", boolOr(p.getKey("/EndOfBlock"), true));
    } else if (residual == "JBIG2Decode") {
        QPDFObjectHandle p = parms.isDictionary() ? parms : QPDFObjectHandle::newDictionary();
        encoding.set("kind", val("jbig2"));
        encoding.set("globals", streamRefOrNull(p.getKey("/JBIG2Globals")));
    } else {
        // codecCut only stops at the names isSpecImageCodec accepts
        throw std::logic_error("encodingOf: not an image codec: " + residual);
    }
    return encoding;
}

// --- Page facts ---

// /Rotate normalised to 0 | 90 | 180 | 270; missing -> 0 (spec default);
// not an integer multiple of 90 -> JS null (invalid, not mapped to 0).
static val rotateFact(QPDFObjectHandle const& rotate) {
    if (rotate.isNull()) return val(0);
    if (!rotate.isInteger()) return val::null();
    long long n = ((rotate.getIntValue() % 360) + 360) % 360;
    return n % 90 == 0 ? val(static_cast<int>(n)) : val::null();
}

// {x, y, width, height} of a rectangle array given in any corner order.
static val rectangleFact(QPDFObjectHandle const& box) {
    double x0 = box.getArrayItem(0).getNumericValue(), y0 = box.getArrayItem(1).getNumericValue();
    double x1 = box.getArrayItem(2).getNumericValue(), y1 = box.getArrayItem(3).getNumericValue();
    val rect = val::object();
    rect.set("x", std::min(x0, x1));
    rect.set("y", std::min(y0, y1));
    rect.set("width", std::abs(x1 - x0));
    rect.set("height", std::abs(y1 - y0));
    return rect;
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
     * The catalog is: every image XObject reachable from the pages'
     * resources (recursive = through Form XObjects), plus every image
     * XObject those images name as /SMask or stream /Mask (closure, with
     * empty page sets). Each page is traversed once within the requested
     * scope to collect membership and `pages`, and once without recursion to
     * collect `directPages`; then the closure and the mask relations are
     * computed. Images are deduplicated by object; stencil masks
     * (/ImageMask true) are included.
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
                                CatalogEntry& entry = catalog[image.getObjGen()];
                                entry.image = image;
                                entry.directPages.insert(pageIndex);
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

            closeOverMasks(catalog);
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
     * Read an image in its stored encoding: every filter before the first
     * image codec (container compression) is removed, the codec is left
     * untouched and reported.
     * Returns {data: typed_memory_view, encoding: ImageEncoding}.
     *
     * qpdf treats a filter chain as all-or-nothing, so a chain with a codec
     * is re-created without the codec in a scratch document and decoded
     * there; the loaded document is not modified. More than one filter after
     * the codec, an unknown filter, or damaged data fail with an error;
     * partially decoded bytes are never returned.
     */
    val readImage(int objId, int generation) {
        return withDocument([&]() {
            QPDFObjectHandle obj = qpdf_->getObjectByID(objId, generation);
            if (!obj.isStream()) {
                return makeError(notAStream(objId, generation), "invalid_argument");
            }
            QPDFObjectHandle dict = obj.getDict();
            std::vector<std::string> names = filterNames(dict);
            size_t cut = codecCut(names);
            val encoding = declaredEncoding(dict);  // same rule as the catalog's ImageInfo.encoding
            if (encoding.isNull()) {
                return makeError("unsupported filter chain: " + dict.getKey("/Filter").unparse(), "unknown");
            }

            std::shared_ptr<Buffer> buf;
            if (cut == names.size()) {
                buf = obj.getStreamData(qpdf_dl_generalized);  // no codec: qpdf removes the container filters
            } else {
                QPDF scratch;
                scratch.emptyPDF();
                QPDFObjectHandle reduced = scratch.newStream();
                reduced.replaceStreamData(
                    obj.getRawStreamData(),  // decrypted, undecoded
                    filterPrefix(scratch, dict.getKey("/Filter"), cut),
                    decodeParmsPrefix(scratch, dict.getKey("/DecodeParms"), cut));
                buf = reduced.getStreamData(qpdf_dl_generalized);
            }
            outputBuffer_.assign(buf->getBuffer(), buf->getBuffer() + buf->getSize());

            val result = val::object();
            result.set("data", val(typed_memory_view(outputBuffer_.size(), outputBuffer_.data())));
            result.set("encoding", encoding);
            return result;
        });
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
     * Number of pages in the loaded PDF, or an error object (disposed, not
     * loaded, unreadable page tree).
     */
    val getPageCount() {
        return withDocument([&]() {
            return val(static_cast<int>(QPDFPageDocumentHelper(*qpdf_).getAllPages().size()));
        });
    }

    /**
     * Facts of one page: {index, mediaBox: {x, y, width, height}, rotate}.
     * /MediaBox and /Rotate are inherited through the page tree. qpdf repairs
     * a missing or malformed /MediaBox to Letter while reading the page tree
     * (with a warning); the repaired value is what is reported.
     */
    val getPageInfo(int index) {
        return withDocument([&]() {
            auto pages = QPDFPageDocumentHelper(*qpdf_).getAllPages();
            if (index < 0 || static_cast<size_t>(index) >= pages.size()) {
                return makeError("Page index " + std::to_string(index) + " out of range (0 to " +
                                     std::to_string(pages.size()) + " exclusive)",
                                 "invalid_argument");
            }
            QPDFPageObjectHelper& page = pages[static_cast<size_t>(index)];
            QPDFObjectHandle mediaBox = page.getMediaBox(false);
            if (!mediaBox.isRectangle()) {
                // Unreachable after qpdf's repair; reported rather than invented
                return makeError("Page " + std::to_string(index) + ": /MediaBox is not a rectangle", "unknown");
            }
            val info = val::object();
            info.set("index", index);
            info.set("mediaBox", rectangleFact(mediaBox));
            info.set("rotate", rotateFact(page.getAttribute("/Rotate", false)));
            return info;
        });
    }

private:
    static std::string notAStream(int objId, int generation) {
        return "Object " + std::to_string(objId) + " " + std::to_string(generation) + " is not a stream";
    }

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
                return makeError(notAStream(objId, generation), "invalid_argument");
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
        .function("readImage", &QpdfWasmWrapper::readImage)
        .function("close", &QpdfWasmWrapper::close)
        .function("getPageCount", &QpdfWasmWrapper::getPageCount)
        .function("getPageInfo", &QpdfWasmWrapper::getPageInfo);
}
