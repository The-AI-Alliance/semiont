import { PDFDocument, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');

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

    // Scanned fixture — empty page, no text layer
    const scannedDoc = await PDFDocument.create();
    scannedDoc.addPage([612, 792]);
    fs.writeFileSync(
        path.join(FIXTURES, 'scanned.pdf'),
        await scannedDoc.save()
    );
}
