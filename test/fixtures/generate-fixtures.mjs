/**
 * generate-fixtures.mjs
 *
 * Generates minimal but valid PDF test fixtures for the qpdf-wasm-image-streams module.
 * Each PDF has a correct cross-reference table and trailer so that standard PDF
 * parsers (including qpdf) can process them.
 *
 * Every fixture is built from the same few object helpers (catalog, pages,
 * page, content stream, image XObject, form XObject), so a new fixture is a
 * list of objects, not hand-written PDF syntax. Objects are numbered
 * sequentially from 1 in the order given; object 1 is always the catalog and
 * object 2 the page tree root.
 *
 * Expected properties of every fixture are recorded in manifest.json.
 *
 * Usage: node test/fixtures/generate-fixtures.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// PDF file assembly
// ---------------------------------------------------------------------------

/**
 * Builds a PDF from an array of object bodies and returns the full PDF as a
 * Buffer. Objects are numbered sequentially starting at 1.
 *
 * @param {Array<Buffer|string>} objects - Object bodies in order (obj 1, obj 2, ...)
 * @param {{root?: number}} [trailer] - Trailer config (root object number, default 1)
 * @returns {Buffer}
 */
function buildPdf(objects, trailer = { root: 1 }) {
  // Note: the binary-marker comment is UTF-8 encoded here (8 bytes instead of
  // 4). That is how the 0.1.0 fixtures were written; kept so they regenerate
  // byte-identically. The comment is ignored by PDF readers either way.
  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const offsets = [];
  let pos = header.length;

  const bodyParts = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pos);
    const objNum = i + 1;
    const objHeader = Buffer.from(`${objNum} 0 obj\n`);
    const objBody = Buffer.isBuffer(objects[i]) ? objects[i] : Buffer.from(objects[i], 'binary');
    const objFooter = Buffer.from('\nendobj\n');
    const part = Buffer.concat([objHeader, objBody, objFooter]);
    bodyParts.push(part);
    pos += part.length;
  }

  // Cross-reference table
  const xrefStart = pos;
  const xrefLines = ['xref\n', `0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (const offset of offsets) {
    xrefLines.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  }
  const xrefBuf = Buffer.from(xrefLines.join(''));

  const trailerBuf = Buffer.from(
    `trailer\n<< /Size ${objects.length + 1} /Root ${trailer.root} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  );

  return Buffer.concat([header, ...bodyParts, xrefBuf, trailerBuf]);
}

// ---------------------------------------------------------------------------
// Object helpers (the only place that knows PDF object syntax)
// ---------------------------------------------------------------------------

/** `n 0 R` */
const ref = (n) => `${n} 0 R`;

/** Catalog pointing at the page tree root (always object 2). */
function catalog() {
  return `<< /Type /Catalog /Pages ${ref(2)} >>`;
}

/**
 * Page tree root.
 * @param {number[]} kids - page object numbers
 * @param {string} [extra] - inheritable attributes, e.g. '/MediaBox [0 0 400 300] /Rotate 90'
 */
function pages(kids, extra = '') {
  const kidRefs = kids.map(ref).join(' ');
  return `<< /Type /Pages /Kids [${kidRefs}] /Count ${kids.length}${extra ? ` ${extra}` : ''} >>`;
}

/**
 * Page object.
 * @param {object} p
 * @param {number} p.contents - content stream object number
 * @param {string} [p.resources] - inner resource dictionary entries, e.g. '/XObject << /Im1 5 0 R >>'
 * @param {string|null} [p.mediaBox] - MediaBox array; null omits the key (inherit or absent)
 * @param {number|null} [p.rotate] - /Rotate value; null omits the key
 * @param {number} [p.parent] - parent node object number (default 2)
 */
function page({ contents, resources = '', mediaBox = '[0 0 612 792]', rotate = null, parent = 2 }) {
  const parts = [`/Type /Page`, `/Parent ${ref(parent)}`];
  if (mediaBox !== null) parts.push(`/MediaBox ${mediaBox}`);
  if (rotate !== null) parts.push(`/Rotate ${rotate}`);
  parts.push(`/Contents ${ref(contents)}`);
  if (resources) parts.push(`/Resources << ${resources} >>`);
  return `<< ${parts.join(' ')} >>`;
}

/**
 * Stream object. The only builder of stream syntax; every stream kind below
 * is this with a dictionary prefix. /Length is always the last key (the
 * order the 0.1.0 fixtures were written in, kept for byte-identical
 * regeneration).
 * @param {string} dictEntries - dictionary entries without /Length ('' for a bare stream)
 * @param {Buffer|string} data - stream bytes as stored (already encoded if a /Filter is given)
 * @returns {Buffer}
 */
function stream(dictEntries, data) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary');
  const entries = dictEntries ? `${dictEntries} ` : '';
  return Buffer.concat([
    Buffer.from(`<< ${entries}/Length ${body.length} >>\nstream\n`),
    body,
    Buffer.from('\nendstream'),
  ]);
}

/** Page or form content stream. */
function contentStream(text) {
  return stream('', text);
}

/**
 * Image XObject.
 * @param {string} dictEntries - e.g. '/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB'
 * @param {Buffer} data - encoded stream bytes
 */
function imageXObject(dictEntries, data) {
  return stream(`/Type /XObject /Subtype /Image ${dictEntries}`, data);
}

/**
 * Form XObject.
 * @param {string} dictEntries - e.g. '/BBox [0 0 100 100] /Resources << /XObject << /Im2 7 0 R >> >>'
 * @param {string} content - form content stream
 */
function formXObject(dictEntries, content) {
  return stream(`/Type /XObject /Subtype /Form ${dictEntries}`, content);
}

/** Content stream text that draws one image XObject. */
function drawImage(name, x = 50, y = 600, w = 100, h = 100) {
  return `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q`;
}

/** Content stream text that draws text. */
function drawText() {
  return 'BT /F1 12 Tf 100 700 Td (Hello World) Tj ET';
}

/** Hex string literal `<...>` of a Buffer. */
function hexString(bytes) {
  return `<${Buffer.from(bytes).toString('hex').toUpperCase()}>`;
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/** 2x2 RGB: red, green, blue, yellow (12 bytes). */
const RGB_2X2 = Buffer.from([
  0xFF, 0x00, 0x00,
  0x00, 0xFF, 0x00,
  0x00, 0x00, 0xFF,
  0xFF, 0xFF, 0x00,
]);

/**
 * Creates a minimal JPEG file (2x2 pixels, grayscale).
 * This is the smallest valid JFIF that most decoders accept.
 * @returns {Buffer}
 */
function createMinimalJpeg() {
  // Minimal 2x2 grayscale JPEG
  // SOI + APP0(JFIF) + DQT + SOF0 + DHT(DC) + DHT(AC) + SOS + scan data + EOI
  const bytes = [
    // SOI
    0xFF, 0xD8,
    // APP0 - JFIF marker
    0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // DQT - Quantization table
    0xFF, 0xDB, 0x00, 0x43, 0x00,
    // 64-byte quantization table (all 1s for simplicity)
    ...Array(64).fill(0x01),
    // SOF0 - Start of Frame (baseline, 2x2, 1 component grayscale)
    0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x02, 0x00, 0x02, 0x01, 0x01, 0x11, 0x00,
    // DHT - DC Huffman table
    0xFF, 0xC4, 0x00, 0x1F, 0x00, // class 0, id 0
    0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B,
    // DHT - AC Huffman table
    0xFF, 0xC4, 0x00, 0xB5, 0x10, // class 1, id 0
    0x00, 0x02, 0x01, 0x03, 0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7D,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
    // SOS - Start of Scan
    0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x7B, 0x40,
    // Minimal scan data (4 pixels of gray)
    0xFB, 0xD2, 0x8A, 0x28, 0x03,
    // EOI
    0xFF, 0xD9,
  ];
  return Buffer.from(bytes);
}

/**
 * Placeholder payload for codecs qpdf never decodes (JPX, CCITT, JBIG2).
 * The core only strips container filters and reports the codec; the bytes
 * are never inspected, so a recognisable pattern is enough here. Codec
 * decoding tests (codec module stages B to D) need real payloads and bring
 * their own fixtures.
 */
function opaqueCodecPayload(length, seed) {
  return Buffer.from(Array.from({ length }, (_, i) => (seed + i * 7) & 0xff));
}

// ---------------------------------------------------------------------------
// Fixtures of 0.1.0 (must regenerate byte-identically)
// ---------------------------------------------------------------------------

function generateSimpleOneImage() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} >>` }),
    contentStream(drawImage('Im1')),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB', RGB_2X2),
  ]);
}

function generateMultiImage() {
  // Page 1: Image1 (4x4 RGB) + Image2 (2x2 Gray). Page 2: Image3 (3x3 RGB).
  return buildPdf([
    catalog(),
    pages([3, 4]),
    page({ contents: 5, resources: `/XObject << /Im1 ${ref(7)} /Im2 ${ref(8)} >>` }),
    page({ contents: 6, resources: `/XObject << /Im3 ${ref(9)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Im2', 200, 600, 50, 50)}`),
    contentStream(drawImage('Im3')),
    imageXObject('/Width 4 /Height 4 /BitsPerComponent 8 /ColorSpace /DeviceRGB', Buffer.alloc(4 * 4 * 3, 0xAA)),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray', Buffer.alloc(2 * 2, 0xBB)),
    imageXObject('/Width 3 /Height 3 /BitsPerComponent 8 /ColorSpace /DeviceRGB', Buffer.alloc(3 * 3 * 3, 0xCC)),
  ]);
}

function generateNoImages() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/Font << /F1 ${ref(5)} >>` }),
    contentStream(drawText()),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
}

function generateJpegCompressed() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} >>` }),
    contentStream(drawImage('Im1')),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode', createMinimalJpeg()),
  ]);
}

function generateNestedForms() {
  // Direct image Im1 (2x2 RGB) and a Form XObject Fm1 containing Im2 (3x3 RGB).
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} /Fm1 ${ref(6)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Fm1', 250, 400, 200, 200)}`),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB', RGB_2X2),
    formXObject(`/BBox [0 0 100 100] /Resources << /XObject << /Im2 ${ref(7)} >> >>`, 'q 1 0 0 1 0 0 cm /Im2 Do Q'),
    imageXObject('/Width 3 /Height 3 /BitsPerComponent 8 /ColorSpace /DeviceRGB', Buffer.alloc(3 * 3 * 3, 0xDD)),
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures added for 0.3.0 (catalog facts, encoded images, page facts)
// ---------------------------------------------------------------------------

/** One page, one content stream drawing Im1, then the given extra objects starting at 5. */
function singlePagePdf(resources, contentText, extraObjects) {
  return buildPdf([catalog(), pages([3]), page({ contents: 4, resources }), contentStream(contentText), ...extraObjects]);
}

/** Picture (5) with /SMask pointing at a gray image (6); both are page resources. */
function generateSmaskPair() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(6)}`, RGB_2X2),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray', Buffer.from([0xFF, 0x80, 0x40, 0x00])),
  ]);
}

/** Picture (5) with a stencil /Mask stream (6, /ImageMask true); both are page resources. */
function generateStencilMaskPair() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Mask ${ref(6)}`, RGB_2X2),
    imageXObject('/Width 2 /Height 2 /ImageMask true /BitsPerComponent 1', Buffer.from([0x80, 0x40])),
  ]);
}

/** Picture with a colour-key /Mask array (ranges per component). */
function generateColorKeyMask() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Mask [250 255 250 255 0 10]', RGB_2X2),
  ]);
}

/** Stencil mask alone: 8x2, 1 bpc, inverted via /Decode [1 0]. */
function generateImageMaskDecode() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 8 /Height 2 /ImageMask true /BitsPerComponent 1 /Decode [1 0]', Buffer.from([0xF0, 0x0F])),
  ]);
}

/**
 * Im1: /ColorSpace is an indirect reference (7) to [ /ICCBased 8 0 R ], /N 3.
 * Im2: /ColorSpace is a direct array [ /ICCBased 9 0 R ], /N 1.
 * The ICC streams carry placeholder bytes; only the dictionary facts matter.
 */
function generateIccBased() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Im2', 200, 600, 50, 50)}`),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace ${ref(7)}`, RGB_2X2),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [ /ICCBased ${ref(9)} ]`, Buffer.from([0x00, 0x55, 0xAA, 0xFF])),
    `[ /ICCBased ${ref(8)} ]`,
    stream('/N 3 /Alternate /DeviceRGB', opaqueCodecPayload(32, 1)),
    stream('/N 1 /Alternate /DeviceGray', opaqueCodecPayload(32, 2)),
  ]);
}

/**
 * Im1: Indexed over DeviceRGB, 8 bpc, hival 3, lookup as hex string (4 entries).
 * Im2: Indexed over DeviceRGB, 4 bpc, hival 1, lookup as Flate stream (7).
 */
function generateIndexedRgb() {
  const lookup4 = Buffer.from([0xFF, 0x00, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0xFF, 0x00]);
  const lookup2 = Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Im2', 200, 600, 50, 50)}`),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [ /Indexed /DeviceRGB 3 ${hexString(lookup4)} ]`, Buffer.from([0, 1, 2, 3])),
    // 4 bpc: two indices per byte, one byte per row
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 4 /ColorSpace [ /Indexed /DeviceRGB 1 ${ref(7)} ]`, Buffer.from([0x01, 0x10])),
    stream('/Filter /FlateDecode', deflateSync(lookup2)),
  ]);
}

/**
 * Im1: Separation with alternate DeviceCMYK and a type 2 tint transform (7).
 * Im2: DeviceN with two colorants, alternate DeviceCMYK, type 4 tint transform (8).
 */
function generateSeparationDeviceN() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Im2', 200, 600, 50, 50)}`),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [ /Separation /Spot /DeviceCMYK ${ref(7)} ]`, Buffer.from([0x00, 0x55, 0xAA, 0xFF])),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [ /DeviceN [ /Cyan /Magenta ] /DeviceCMYK ${ref(8)} ]`, Buffer.alloc(2 * 2 * 2, 0x80)),
    '<< /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 0 1] /N 1 >>',
    stream('/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1 0 1]', '{ 0 0 }'),
  ]);
}

/** JPEG whose /ColorSpace is an indirect reference to an ICCBased array (the "940 0 R" case). */
function generateDctIndirectColorSpace() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace ${ref(6)} /Filter /DCTDecode`, createMinimalJpeg()),
    `[ /ICCBased ${ref(7)} ]`,
    stream('/N 1 /Alternate /DeviceGray', opaqueCodecPayload(32, 3)),
  ]);
}

/** JPEG wrapped in Flate: /Filter [ /FlateDecode /DCTDecode ]. */
function generateFlateDctChain() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter [ /FlateDecode /DCTDecode ]', deflateSync(createMinimalJpeg())),
  ]);
}

/** JPX wrapped in Flate, no /ColorSpace and no /BitsPerComponent (allowed for JPX), /SMaskInData 1. */
function generateJpxFlateChain() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /Filter [ /FlateDecode /JPXDecode ] /SMaskInData 1', deflateSync(opaqueCodecPayload(16, 4))),
  ]);
}

/** CCITT G4, 8x2, 1 bpc, with explicit decode parameters. */
function generateCcitt1Bit() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(
      '/Width 8 /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 8 /BlackIs1 true >>',
      opaqueCodecPayload(4, 5)
    ),
  ]);
}

/** JBIG2 with a globals stream (6). */
function generateJbig2Globals() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(
      `/Width 8 /Height 2 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals ${ref(6)} >>`,
      opaqueCodecPayload(6, 6)
    ),
    stream('', opaqueCodecPayload(10, 7)),
  ]);
}

/** Invalid chain: an image codec followed by a container filter. */
function generateCodecNotLast() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter [ /DCTDecode /FlateDecode ]', deflateSync(createMinimalJpeg())),
  ]);
}

/** One image XObject referenced from the resources of three pages (shared content stream too). */
function generateSharedImage3Pages() {
  const resources = `/XObject << /Im1 ${ref(7)} >>`;
  return buildPdf([
    catalog(),
    pages([3, 4, 5]),
    page({ contents: 6, resources }),
    page({ contents: 6, resources }),
    page({ contents: 6, resources }),
    contentStream(drawImage('Im1')),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB', RGB_2X2),
  ]);
}

/**
 * Page facts: page 0 has explicit /MediaBox [0 0 400 300] and /Rotate 90;
 * page 1 inherits both from the page tree root; page 2 has the invalid
 * /Rotate 45; page 3 has /Rotate -90 (normalises to 270). No images.
 */
function generateRotatedPage() {
  return buildPdf([
    catalog(),
    pages([3, 4, 5, 6], '/MediaBox [0 0 400 300] /Rotate 90'),
    page({ contents: 7, mediaBox: '[0 0 400 300]', rotate: 90 }),
    page({ contents: 7, mediaBox: null }),
    page({ contents: 7, mediaBox: null, rotate: 45 }),
    page({ contents: 7, mediaBox: null, rotate: -90 }),
    contentStream(drawText()),
  ]);
}

/** A page without any /MediaBox (neither own nor inherited). No images. */
function generateNoMediaBox() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, mediaBox: null }),
    contentStream(drawText()),
  ]);
}

/** Flate via its inline-image abbreviation /Fl. */
function generateFilterAbbreviations() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /Fl', deflateSync(RGB_2X2)),
  ]);
}

/**
 * PNG predictor rows for Flate /DecodeParms /Predictor >= 10: one filter-type
 * byte per row. Row 0 uses None (0), every further row Up (2), i.e. the byte
 * difference to the row above.
 */
function pngPredictorRows(rows) {
  const out = [];
  rows.forEach((row, i) => {
    if (i === 0) out.push(0, ...row);
    else out.push(2, ...row.map((v, j) => (v - rows[i - 1][j]) & 0xff));
  });
  return Buffer.from(out);
}

/** Flate with PNG predictor (Up) over the 2x2 RGB pixels; decodes to RGB_2X2. */
function generateFlatePredictor() {
  const rows = [Array.from(RGB_2X2.subarray(0, 6)), Array.from(RGB_2X2.subarray(6, 12))];
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(
      '/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode /DecodeParms << /Predictor 12 /Colors 3 /BitsPerComponent 8 /Columns 2 >>',
      deflateSync(pngPredictorRows(rows))
    ),
  ]);
}

/**
 * JPEG wrapped in Flate with a PNG predictor on the Flate stage:
 * /Filter [ /FlateDecode /DCTDecode ], /DecodeParms [ << predictor >> null ].
 * Exercises the DecodeParms slicing when the codec is cut off.
 */
function generateFlatePredictorDct() {
  const jpeg = createMinimalJpeg();
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(
      `/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter [ /FlateDecode /DCTDecode ] /DecodeParms [ << /Predictor 12 /Colors 1 /BitsPerComponent 8 /Columns ${jpeg.length} >> null ]`,
      deflateSync(pngPredictorRows([Array.from(jpeg)]))
    ),
  ]);
}

/** A filter name no reader knows: every decode must fail, raw bytes stay readable. */
function generateUnknownFilter() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FooDecode', RGB_2X2),
  ]);
}

/** Flate stream with a valid zlib header followed by garbage: inflate fails. */
function generateDamagedFlate() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode', Buffer.from([0x78, 0x9c, 0xff, 0xff, 0x00])),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const outDir = __dirname;
mkdirSync(outDir, { recursive: true });

const fixtures = [
  // 0.1.0
  { name: 'simple-one-image.pdf', generate: generateSimpleOneImage },
  { name: 'multi-image.pdf', generate: generateMultiImage },
  { name: 'no-images.pdf', generate: generateNoImages },
  { name: 'jpeg-compressed.pdf', generate: generateJpegCompressed },
  { name: 'nested-forms.pdf', generate: generateNestedForms },
  // 0.3.0
  { name: 'smask-pair.pdf', generate: generateSmaskPair },
  { name: 'stencil-mask-pair.pdf', generate: generateStencilMaskPair },
  { name: 'colorkey-mask.pdf', generate: generateColorKeyMask },
  { name: 'imagemask-decode.pdf', generate: generateImageMaskDecode },
  { name: 'iccbased-n3-n1.pdf', generate: generateIccBased },
  { name: 'indexed-rgb.pdf', generate: generateIndexedRgb },
  { name: 'separation-devicen.pdf', generate: generateSeparationDeviceN },
  { name: 'dct-indirect-colorspace.pdf', generate: generateDctIndirectColorSpace },
  { name: 'flate-dct-chain.pdf', generate: generateFlateDctChain },
  { name: 'jpx-flate-chain.pdf', generate: generateJpxFlateChain },
  { name: 'ccitt-1bit.pdf', generate: generateCcitt1Bit },
  { name: 'jbig2-globals.pdf', generate: generateJbig2Globals },
  { name: 'codec-not-last.pdf', generate: generateCodecNotLast },
  { name: 'shared-image-3-pages.pdf', generate: generateSharedImage3Pages },
  { name: 'rotated-page.pdf', generate: generateRotatedPage },
  { name: 'no-mediabox.pdf', generate: generateNoMediaBox },
  { name: 'filter-abbreviations.pdf', generate: generateFilterAbbreviations },
  { name: 'flate-predictor.pdf', generate: generateFlatePredictor },
  { name: 'flate-predictor-dct.pdf', generate: generateFlatePredictorDct },
  { name: 'unknown-filter.pdf', generate: generateUnknownFilter },
  { name: 'damaged-flate.pdf', generate: generateDamagedFlate },
];

for (const fixture of fixtures) {
  const pdf = fixture.generate();
  const path = join(outDir, fixture.name);
  writeFileSync(path, pdf);
  console.log(`Generated: ${fixture.name} (${pdf.length} bytes)`);
}

console.log('\nAll fixtures generated successfully.');
