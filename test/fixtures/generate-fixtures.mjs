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
 * @param {number|number[]} p.contents - content stream object number, or several for a /Contents array
 * @param {string} [p.resources] - inner resource dictionary entries, e.g. '/XObject << /Im1 5 0 R >>'
 * @param {string|null} [p.mediaBox] - MediaBox array; null omits the key (inherit or absent)
 * @param {number|null} [p.rotate] - /Rotate value; null omits the key
 * @param {number} [p.parent] - parent node object number (default 2)
 * @param {string|null} [p.userUnit] - /UserUnit value as PDF syntax; null omits the key
 */
function page({ contents, resources = '', mediaBox = '[0 0 612 792]', rotate = null, parent = 2, userUnit = null }) {
  const parts = [`/Type /Page`, `/Parent ${ref(parent)}`];
  if (mediaBox !== null) parts.push(`/MediaBox ${mediaBox}`);
  if (rotate !== null) parts.push(`/Rotate ${rotate}`);
  if (userUnit !== null) parts.push(`/UserUnit ${userUnit}`);
  parts.push(`/Contents ${Array.isArray(contents) ? `[${contents.map(ref).join(' ')}]` : ref(contents)}`);
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
// Fixtures added for 0.3.1 (masks outside resources, masked JPEG, inherited resources)
// ---------------------------------------------------------------------------

/** The gray soft mask used by the 0.3.0 smask-pair fixture: alpha 255, 128, 64, 0. */
const GRAY_MASK_2X2 = Buffer.from([0xFF, 0x80, 0x40, 0x00]);
const grayMask = (dictEntries, data) =>
  imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray${dictEntries ? ` ${dictEntries}` : ''}`, data);

/** Picture (5) with /SMask (6); the mask is in no resource dictionary (typical design-tool export). */
function generateSmaskOutsideResources() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(6)}`, RGB_2X2),
    grayMask('', GRAY_MASK_2X2),
  ]);
}

/** JPEG picture (5) with a gray /SMask (6) outside resources. */
function generateSmaskJpeg() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /DCTDecode /SMask ${ref(6)}`, createMinimalJpeg()),
    grayMask('', GRAY_MASK_2X2),
  ]);
}

/**
 * 2x2 picture with a 4x4 mask. Nearest-neighbour resampling to 2x2 samples
 * the mask at (0,0), (2,0), (0,2), (2,2), which hold 255, 128, 64, 0.
 */
function generateSmaskOtherSize() {
  const mask4x4 = Buffer.from([
    0xFF, 0x11, 0x80, 0x11,
    0x11, 0x11, 0x11, 0x11,
    0x40, 0x11, 0x00, 0x11,
    0x11, 0x11, 0x11, 0x11,
  ]);
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(6)}`, RGB_2X2),
    imageXObject('/Width 4 /Height 4 /BitsPerComponent 8 /ColorSpace /DeviceGray', mask4x4),
  ]);
}

/** Mask with /Decode [1 0]: stored 0, 127, 191, 255 means alpha 255, 128, 64, 0. */
function generateSmaskDecodeInverted() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(6)}`, RGB_2X2),
    grayMask('/Decode [1 0]', Buffer.from([0x00, 0x7F, 0xBF, 0xFF])),
  ]);
}

/** One mask (7) named by two pictures (5, 6). */
function generateSmaskShared() {
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>` }),
    contentStream(`${drawImage('Im1')} ${drawImage('Im2', 200, 600, 50, 50)}`),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(7)}`, RGB_2X2),
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray /SMask ${ref(7)}`, Buffer.from([0x00, 0x55, 0xAA, 0xFF])),
    grayMask('', GRAY_MASK_2X2),
  ]);
}

/** /SMask naming a stream that is not an image XObject: the reference is a fact, no catalog entry follows. */
function generateSmaskNotAnImage() {
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} >>`, drawImage('Im1'), [
    imageXObject(`/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB /SMask ${ref(6)}`, RGB_2X2),
    stream('', opaqueCodecPayload(4, 8)),
  ]);
}

/**
 * Three pages sharing one inherited /Resources that names one image; the
 * content streams paint it on pages 0 and 2 only. `pages` (reachability)
 * is [0, 1, 2]; a painted-images fact (0.4) would say [0, 2].
 */
function generateInheritedResources3Pages() {
  return buildPdf([
    catalog(),
    pages([3, 4, 5], `/Resources << /XObject << /Im1 ${ref(7)} >> /Font << /F1 ${ref(8)} >> >>`),
    page({ contents: 6 }),
    page({ contents: 9 }),
    page({ contents: 6 }),
    contentStream(drawImage('Im1')),
    imageXObject('/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB', RGB_2X2),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    contentStream(drawText()),
  ]);
}

// ---------------------------------------------------------------------------
// Fixtures added for 0.4.0 (image paints, /UserUnit)
// ---------------------------------------------------------------------------

const RGB_IMAGE = '/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceRGB';
const GRAY_IMAGE = '/Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray';
const GRAY_2X2 = Buffer.alloc(2 * 2, 0xBB);

/**
 * /UserUnit: page 0 has 2, page 1 none (default 1; the page tree root's
 * /UserUnit 3 is not inherited), page 2 has 1.5, pages 3 to 5 have the
 * invalid values 0, a string and -1. No images.
 */
function generateUserUnit() {
  return buildPdf([
    catalog(),
    pages([3, 4, 5, 6, 7, 8], '/UserUnit 3'),
    page({ contents: 9, userUnit: '2' }),
    page({ contents: 9 }),
    page({ contents: 9, userUnit: '1.5' }),
    page({ contents: 9, userUnit: '0' }),
    page({ contents: 9, userUnit: '(two)' }),
    page({ contents: 9, userUnit: '-1' }),
    contentStream(drawText()),
  ]);
}

/**
 * The graphics state operators that decide where an image is painted: `cm`
 * concatenates, `q`/`Q` save and restore (nested), a rotation, and one image
 * painted several times. Im1 is object 5, Im2 object 6.
 */
function generatePaintTransforms() {
  const content = [
    'q 0.5 0 0 0.25 8 4 cm /Im2 Do Q',
    'q 2 0 0 2 10 20 cm',
    'q 50 0 0 30 5 5 cm /Im1 Do Q',
    '/Im2 Do',
    'Q',
    '/Im1 Do',
    '0 1 -1 0 300 400 cm',
    '100 0 0 50 0 0 cm /Im1 Do',
  ].join('\n');
  return singlePagePdf(`/XObject << /Im1 ${ref(5)} /Im2 ${ref(6)} >>`, content, [
    imageXObject(RGB_IMAGE, RGB_2X2),
    imageXObject(GRAY_IMAGE, GRAY_2X2),
  ]);
}

/**
 * Form XObjects: Fm1 (5) has a /Matrix, is drawn twice and leaves an
 * unbalanced `q ... cm` behind; it draws Im1 (8), the nested Fm2 (6, own
 * resources, a `cm` outside any `q`) and Im1 again. Fm3 (7) has a /Matrix
 * and no /Resources, so its /Im1 is looked up in the page's resources.
 * Im2 is object 9.
 */
function generatePaintForms() {
  const pageContent = [
    'q 1 0 0 1 100 200 cm /Fm1 Do Q',
    'q 3 0 0 3 0 0 cm /Fm1 Do Q',
    '/Fm3 Do',
    '/Im1 Do',
  ].join('\n');
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: 4, resources: `/XObject << /Fm1 ${ref(5)} /Fm3 ${ref(7)} /Im1 ${ref(8)} >>` }),
    contentStream(pageContent),
    formXObject(
      `/BBox [0 0 100 100] /Matrix [2 0 0 2 0 0] /Resources << /XObject << /Im1 ${ref(8)} /Fm2 ${ref(6)} >> >>`,
      'q 10 0 0 10 1 1 cm /Im1 Do Q /Fm2 Do /Im1 Do q 5 0 0 5 0 0 cm'
    ),
    formXObject(`/BBox [0 0 100 100] /Resources << /XObject << /Im2 ${ref(9)} >> >>`, '4 0 0 8 0 0 cm /Im2 Do'),
    formXObject('/BBox [0 0 10 10] /Matrix [1 0 0 1 7 9]', '/Im1 Do'),
    imageXObject(RGB_IMAGE, RGB_2X2),
    imageXObject(GRAY_IMAGE, GRAY_2X2),
  ]);
}

/**
 * Content that paints nothing or is tolerated the same way by every viewer:
 * /Contents is an array of two streams (the `q ... cm` of the first is still
 * in effect in the second), a `Q` without `q`, `Do` of a name that is not a
 * resource, of an XObject that is neither image nor form (8) and with an
 * operand that is not a name, and an inline image. Im1 (6) and the stencil
 * mask (9) are painted; Im2 (7) is a resource that is never painted.
 */
function generatePaintContentTolerance() {
  const resources = `/XObject << /Im1 ${ref(6)} /Im2 ${ref(7)} /Ps1 ${ref(8)} /Mask1 ${ref(9)} >>`;
  return buildPdf([
    catalog(),
    pages([3]),
    page({ contents: [4, 5], resources }),
    contentStream('q 10 0 0 10 0 0 cm'),
    contentStream('/Im1 Do Q Q /Missing Do /Ps1 Do (Im1) Do BI /W 1 /H 1 /CS /G /BPC 8 ID A EI /Mask1 Do'),
    imageXObject(RGB_IMAGE, RGB_2X2),
    imageXObject(GRAY_IMAGE, GRAY_2X2),
    stream('/Type /XObject /Subtype /PS', '% not painted'),
    imageXObject('/Width 2 /Height 2 /ImageMask true /BitsPerComponent 1', Buffer.from([0x80, 0x40])),
  ]);
}

/**
 * `cm` whose operands are not exactly six numbers: four numbers (page 0), a
 * name among them (page 1), seven numbers (page 2). Page 3 is well-formed.
 * Im1 is object 11.
 */
function generatePaintMalformedOperands() {
  const resources = `/XObject << /Im1 ${ref(11)} >>`;
  return buildPdf([
    catalog(),
    pages([3, 4, 5, 6]),
    page({ contents: 7, resources }),
    page({ contents: 8, resources }),
    page({ contents: 9, resources }),
    page({ contents: 10, resources }),
    contentStream('1 0 0 1 cm /Im1 Do'),
    contentStream('1 0 0 1 0 /X cm /Im1 Do'),
    contentStream('1 0 0 1 0 0 0 cm /Im1 Do'),
    contentStream(drawImage('Im1')),
    imageXObject(RGB_IMAGE, RGB_2X2),
  ]);
}

/**
 * Form XObjects whose paints cannot be told: a form that draws itself
 * (page 0, Fm1 = 13), two forms that draw each other (page 1, Fm2 = 14 and
 * Fm3 = 15), a /Matrix that is not six numbers (page 2, Fm4 = 16) and five
 * levels of forms that each draw the next ten times, 1,111,110 draws in all
 * (page 3, Fm5 to Fm9 = 17 to 21). Page 4 draws the well-formed Fm10 (22).
 * Im1 is object 23.
 */
function generatePaintUnreadableForms() {
  const xobjects = (entries) => `/XObject << ${entries} >>`;
  const form = (resources, content, extra = '') =>
    formXObject(`/BBox [0 0 100 100]${extra} /Resources << ${xobjects(resources)} >>`, content);
  const tenTimes = (name) => Array(10).fill(`/${name} Do`).join(' ');
  return buildPdf([
    catalog(),
    pages([3, 4, 5, 6, 7]),
    page({ contents: 8, resources: xobjects(`/Fm1 ${ref(13)}`) }),
    page({ contents: 9, resources: xobjects(`/Fm2 ${ref(14)}`) }),
    page({ contents: 10, resources: xobjects(`/Fm4 ${ref(16)}`) }),
    page({ contents: 11, resources: xobjects(`/Fm5 ${ref(17)}`) }),
    page({ contents: 12, resources: xobjects(`/Fm10 ${ref(22)}`) }),
    contentStream('/Fm1 Do'),
    contentStream('/Fm2 Do'),
    contentStream('/Fm4 Do'),
    contentStream(tenTimes('Fm5')),
    contentStream('/Fm10 Do'),
    form(`/Im1 ${ref(23)} /Fm1 ${ref(13)}`, '/Im1 Do 2 0 0 2 0 0 cm /Fm1 Do'),
    form(`/Im1 ${ref(23)} /Fm3 ${ref(15)}`, '/Im1 Do /Fm3 Do'),
    form(`/Fm2 ${ref(14)}`, '2 0 0 2 0 0 cm /Fm2 Do'),
    form(`/Im1 ${ref(23)}`, '/Im1 Do', ' /Matrix [1 0 0 1]'),
    form(`/Fm6 ${ref(18)}`, tenTimes('Fm6')),
    form(`/Fm7 ${ref(19)}`, tenTimes('Fm7')),
    form(`/Fm8 ${ref(20)}`, tenTimes('Fm8')),
    form(`/Fm9 ${ref(21)}`, tenTimes('Fm9')),
    form(`/Im1 ${ref(23)}`, tenTimes('Im1')),
    form(`/Im1 ${ref(23)}`, '/Im1 Do'),
    imageXObject(RGB_IMAGE, RGB_2X2),
  ]);
}

/**
 * Content that cannot be read: a content stream whose Flate data is damaged
 * (page 0) and one with a syntax error, an unterminated string (page 1).
 * Page 2 is well-formed. Im1 is object 9.
 */
function generatePaintUnreadableContent() {
  const resources = `/XObject << /Im1 ${ref(9)} >>`;
  return buildPdf([
    catalog(),
    pages([3, 4, 5]),
    page({ contents: 6, resources }),
    page({ contents: 7, resources }),
    page({ contents: 8, resources }),
    stream('/Filter /FlateDecode', Buffer.from('this is not zlib data')),
    contentStream(`${drawImage('Im1')} (unterminated`),
    contentStream(drawImage('Im1')),
    imageXObject(RGB_IMAGE, RGB_2X2),
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
  // 0.3.1
  { name: 'smask-outside-resources.pdf', generate: generateSmaskOutsideResources },
  { name: 'smask-jpeg.pdf', generate: generateSmaskJpeg },
  { name: 'smask-other-size.pdf', generate: generateSmaskOtherSize },
  { name: 'smask-decode-inverted.pdf', generate: generateSmaskDecodeInverted },
  { name: 'smask-shared.pdf', generate: generateSmaskShared },
  { name: 'smask-not-an-image.pdf', generate: generateSmaskNotAnImage },
  { name: 'inherited-resources-3-pages.pdf', generate: generateInheritedResources3Pages },
  // 0.4.0
  { name: 'user-unit.pdf', generate: generateUserUnit },
  { name: 'paint-transforms.pdf', generate: generatePaintTransforms },
  { name: 'paint-forms.pdf', generate: generatePaintForms },
  { name: 'paint-content-tolerance.pdf', generate: generatePaintContentTolerance },
  { name: 'paint-malformed-operands.pdf', generate: generatePaintMalformedOperands },
  { name: 'paint-unreadable-forms.pdf', generate: generatePaintUnreadableForms },
  { name: 'paint-unreadable-content.pdf', generate: generatePaintUnreadableContent },
];

for (const fixture of fixtures) {
  const pdf = fixture.generate();
  const path = join(outDir, fixture.name);
  writeFileSync(path, pdf);
  console.log(`Generated: ${fixture.name} (${pdf.length} bytes)`);
}

console.log('\nAll fixtures generated successfully.');
