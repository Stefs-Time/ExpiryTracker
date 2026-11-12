/**
 * Minimal, dependency-free JPEG validation and metadata stripping.
 *
 * Why: document photos taken on phones carry EXIF metadata (GPS location,
 * device, timestamps). The browser re-encodes images before upload (which
 * drops EXIF), but the server cannot trust the client, so it walks the JPEG
 * segment structure itself and:
 *   - rejects anything that is not a well-formed baseline/progressive JPEG,
 *   - removes APP1 (EXIF/XMP), APP12/APP13 (Ducky/IPTC/Photoshop) and COM segments,
 *   - keeps APP0 (JFIF), APP2 (ICC colour profile) and APP14 (Adobe colour transform),
 *   - reads the pixel dimensions from the SOF header.
 */

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const STRIP = new Set([0xe1, 0xec, 0xed, 0xfe]); // APP1, APP12, APP13, COM
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MAX_DIMENSION = 12_000;

export class InvalidImageError extends Error {}

/**
 * @param {Buffer} buf
 * @returns {{ buffer: Buffer, width: number, height: number, stripped: number }}
 */
export function sanitizeJpeg(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== SOI) {
    throw new InvalidImageError('Not a JPEG image');
  }
  const out = [buf.subarray(0, 2)];
  let pos = 2;
  let width = 0;
  let height = 0;
  let stripped = 0;
  let sawScan = false;

  while (pos < buf.length) {
    if (buf[pos] !== 0xff) throw new InvalidImageError('Corrupt JPEG (bad marker)');
    // Skip fill bytes (0xFF padding before a marker).
    while (buf[pos + 1] === 0xff) pos += 1;
    const marker = buf[pos + 1];
    if (marker === undefined) throw new InvalidImageError('Truncated JPEG');
    if (marker === EOI) {
      out.push(buf.subarray(pos, pos + 2));
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) { // RSTn outside scan: tolerate
      out.push(buf.subarray(pos, pos + 2));
      pos += 2;
      continue;
    }
    if (pos + 4 > buf.length) throw new InvalidImageError('Truncated JPEG');
    const len = buf.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > buf.length) throw new InvalidImageError('Corrupt JPEG (bad segment length)');
    const segment = buf.subarray(pos, pos + 2 + len);

    if (SOF.has(marker)) {
      if (len < 7) throw new InvalidImageError('Corrupt JPEG (bad frame header)');
      height = buf.readUInt16BE(pos + 5);
      width = buf.readUInt16BE(pos + 7);
    }

    if (marker === SOS) {
      // Entropy-coded data runs until EOI; copy the rest verbatim.
      out.push(buf.subarray(pos));
      sawScan = true;
      break;
    }

    if (STRIP.has(marker)) stripped += 1;
    else out.push(segment);
    pos += 2 + len;
  }

  if (!sawScan) throw new InvalidImageError('JPEG has no image data');
  if (!width || !height) throw new InvalidImageError('JPEG has no frame header');
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) throw new InvalidImageError('Image dimensions are too large');
  return { buffer: Buffer.concat(out), width, height, stripped };
}
