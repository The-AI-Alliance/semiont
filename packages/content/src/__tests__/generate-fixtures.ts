import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

// ── Minimal PNG encoder ──────────────────────────────────────────────
//
// Scanned-PDF fixtures need a real embedded raster: a page whose glyphs
// exist only as pixels. Encoding one here (deterministically, from node's
// zlib) keeps the "edit the generator, never the binaries" rule and adds no
// image dependency to a package that deliberately has none.

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

function pngChunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

/** 8-bit RGB PNG from a per-pixel paint function. */
function encodePng(width: number, height: number, paint: (x: number, y: number) => number): Buffer {
    const stride = width * 3 + 1;                 // one filter byte per scanline
    const raw = Buffer.alloc(stride * height, 0xFF);
    for (let y = 0; y < height; y++) {
        raw[y * stride] = 0;                      // filter type: none
        for (let x = 0; x < width; x++) {
            const value = paint(x, y);
            raw.fill(value, y * stride + 1 + x * 3, y * stride + 1 + x * 3 + 3);
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // color type: truecolor
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** A crude picture of three lines of text — dark bars on white. */
const scanPixels = encodePng(240, 140, (x, y) => {
    const lineTop = [20, 60, 100].some((top) => y >= top && y < top + 14);
    return lineTop && x >= 20 && x < 220 ? 0x20 : 0xFF;
});

/**
 * Vitest globalSetup: regenerate the PDF test fixtures (deterministically, via
 * pdf-lib) before the suite runs. The fixtures are gitignored — edit this
 * generator, never the binaries. Runs for every invocation (test, coverage,
 * watch, IDE), so the suite is self-contained from a clean checkout.
 */
export default async function setup() {
    fs.mkdirSync(FIXTURES, { recursive: true });

    // Single-line fixture
    const singleLineDoc = await PDFDocument.create();
    const singleLineFont = await singleLineDoc.embedFont(StandardFonts.Helvetica);
    const singleLinePage = singleLineDoc.addPage([612, 792]);  // dimension of US Letter page
    singleLinePage.drawText(
        'known phrase from fixture',
        { x: 72, y: 720, size: 12, font: singleLineFont }
    );
    fs.writeFileSync(
        path.join(FIXTURES, 'single-line.pdf'),
        await singleLineDoc.save()
    );

    // Multi-line fixture
    const multiLineDoc = await PDFDocument.create();
    const multiLineFont = await multiLineDoc.embedFont(StandardFonts.Helvetica);
    const multiLinePage = multiLineDoc.addPage([612, 792]);
    multiLinePage.drawText(
        'first line of text\nsecond line of text\nthird line of text',
        { x: 72, y: 720, size: 12, font: multiLineFont, lineHeight: 20 }
    );
    fs.writeFileSync(
        path.join(FIXTURES, 'multi-line.pdf'),
        await multiLineDoc.save()
    );

    // Multi-page fixture
    const multiPageDoc = await PDFDocument.create();
    const multiPageFont = await multiPageDoc.embedFont(StandardFonts.Helvetica);
    const page1 = multiPageDoc.addPage([612, 792]);
    const page2 = multiPageDoc.addPage([612, 792]);
    page1.drawText(
        'content on page one',
        { x: 72, y: 720, size: 12, font: multiPageFont }
    );
    page2.drawText(
        'content on page two',
        { x: 72, y: 720, size: 12, font: multiPageFont }
    );
    fs.writeFileSync(
        path.join(FIXTURES, 'multi-page.pdf'),
        await multiPageDoc.save()
    );

    // Multi-column fixture
    const multiColumnDoc = await PDFDocument.create();
    const multiColumnFont = await multiColumnDoc.embedFont(StandardFonts.Helvetica);
    const multiColumnPage = multiColumnDoc.addPage([612, 792]);
    multiColumnPage.drawText(
        'left column line one\nleft column line two',
        { x: 72, y: 720, size: 12, font: multiColumnFont, lineHeight: 20 }
    );
    multiColumnPage.drawText(
        'right column line one\nright column line two',
        { x: 320, y: 720, size: 12, font: multiColumnFont, lineHeight: 20 }
    );
    fs.writeFileSync(
        path.join(FIXTURES, 'multi-column.pdf'),
        await multiColumnDoc.save()
    );

    // Scanned fixture — empty page, no text layer. The degenerate class B:
    // nothing to read and nothing to OCR either.
    const scannedDoc = await PDFDocument.create();
    scannedDoc.addPage([612, 792]);
    fs.writeFileSync(
        path.join(FIXTURES, 'scanned.pdf'),
        await scannedDoc.save()
    );

    // Scanned fixture, realistic (class B) — a full-page raster and no text
    // operators at all: the characters exist only as pixels. This is what a
    // scanner actually emits, and what OCR must consume.
    const scannedImageDoc = await PDFDocument.create();
    const scanImage = await scannedImageDoc.embedPng(scanPixels);
    const scannedImagePage = scannedImageDoc.addPage([612, 792]);
    scannedImagePage.drawImage(scanImage, { x: 0, y: 0, width: 612, height: 792 });
    fs.writeFileSync(
        path.join(FIXTURES, 'scanned-image.pdf'),
        await scannedImageDoc.save()
    );

    // Mixed fixture (class C) — page 1 native text, page 2 image-only. Today
    // the reader classifies per document, so this extracts page 1 and drops
    // page 2 silently; per-page routing is what makes it whole.
    const mixedDoc = await PDFDocument.create();
    const mixedFont = await mixedDoc.embedFont(StandardFonts.Helvetica);
    const mixedImage = await mixedDoc.embedPng(scanPixels);
    const mixedNativePage = mixedDoc.addPage([612, 792]);
    mixedNativePage.drawText('native page text', { x: 72, y: 720, size: 12, font: mixedFont });
    const mixedScannedPage = mixedDoc.addPage([612, 792]);
    mixedScannedPage.drawImage(mixedImage, { x: 0, y: 0, width: 612, height: 792 });
    fs.writeFileSync(
        path.join(FIXTURES, 'mixed.pdf'),
        await mixedDoc.save()
    );

    // Table fixture (class D) — a regular grid: 4 rows × 3 columns drawn at
    // fixed column origins, the shape a trial-report outcome table has. Read
    // in naive reading order the cells interleave; read as a grid the rows
    // stay coherent.
    const tableDoc = await PDFDocument.create();
    const tableFont = await tableDoc.embedFont(StandardFonts.Helvetica);
    const tablePage = tableDoc.addPage([612, 792]);
    const tableRows = [
        ['Treatment', 'Responders', 'p-value'],
        ['Drug A', '12%', '0.03'],
        ['Drug B', '9%', '0.21'],
        ['Placebo', '4%', '0.88'],
    ];
    const columnX = [72, 250, 420];
    tableRows.forEach((row, rowIndex) => {
        row.forEach((cell, columnIndex) => {
            tablePage.drawText(cell, {
                x: columnX[columnIndex]!,
                y: 720 - rowIndex * 24,
                size: 12,
                font: tableFont,
            });
        });
    });
    fs.writeFileSync(
        path.join(FIXTURES, 'table.pdf'),
        await tableDoc.save()
    );

    // AcroForm fixture (class E) — drawn labels plus filled fields. The
    // values live only in the form dictionary, never in the text layer:
    // that gap is what class-E extraction closes.
    const formDoc = await PDFDocument.create();
    const formFont = await formDoc.embedFont(StandardFonts.Helvetica);
    const formPage = formDoc.addPage([612, 792]);
    formPage.drawText('Policy Application', { x: 72, y: 740, size: 14, font: formFont });
    const form = formDoc.getForm();
    const holder = form.createTextField('policy.holderName');
    holder.setText('Ada Lovelace');
    holder.addToPage(formPage, { x: 72, y: 700, width: 200, height: 20, font: formFont });
    const coverage = form.createTextField('policy.coverageAmount');
    coverage.setText('$250,000');
    coverage.addToPage(formPage, { x: 72, y: 660, width: 200, height: 20, font: formFont });
    const state = form.createDropdown('policy.state');
    state.setOptions(['CA', 'NY']);
    state.select('NY');
    state.addToPage(formPage, { x: 72, y: 620, width: 100, height: 20, font: formFont });
    // An empty field: carries no value, so class-E extraction must not emit it.
    const notes = form.createTextField('policy.notes');
    notes.addToPage(formPage, { x: 72, y: 580, width: 200, height: 20, font: formFont });
    fs.writeFileSync(
        path.join(FIXTURES, 'form.pdf'),
        await formDoc.save()
    );
}
