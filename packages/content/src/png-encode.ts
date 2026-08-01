/**
 * Minimal PNG encoder.
 *
 * OCR engines take an encoded image, while pdf.js hands back raw pixel
 * planes — this bridges the two. Deterministic, built on node's zlib, so a
 * package that deliberately carries no image dependency still does not.
 */

import zlib from 'zlib';

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf: Buffer): number {
    let c = -1;
    for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** Encode 8-bit RGB pixels (length must be width × height × 3) as a PNG. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
    const stride = width * 3 + 1;                 // one filter byte per scanline
    const raw = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;                      // filter type: none
        Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3)
            .copy(raw, y * stride + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // color type: truecolor
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
