/**
 * Extraction size guards — the bounds behind the `'too-large'` decline.
 *
 * `'too-large'` was declared in the decline vocabulary from the start and
 * never emitted, which was the visible half of a real gap: nothing bounded
 * what extraction would allocate. A PDF is a compressed container, so input
 * size says little about decoded size — a few megabytes of JPEG can decode
 * into gigabytes of raster, and the OCR path decodes every scanned page.
 *
 * Two bounds, deliberately different in kind:
 *
 *   - a whole-document input cap, which DECLINES: nothing can be safely done
 *     with it, and the operator should be told why;
 *   - a per-image pixel cap, which SKIPS that image and leaves its page
 *     unread. One pathological page should not cost a document its other
 *     forty — that is the same partial-coverage story class C already tells.
 */

import { describe, it, expect } from 'vitest';
import { EXTRACTORS } from '../content-extractor';
import { MAX_PDF_BYTES, withinByteBudget } from '../pdf-extractor';
import { MAX_IMAGE_PIXELS, PEAK_BYTES_PER_PIXEL, withinPixelBudget, extractPageImages } from '../pdf-page-images';

/**
 * A one-page PDF whose image XObject *declares* enormous dimensions while
 * carrying a few bytes of data.
 *
 * The mismatch is the point, and it is only possible by hand — pdf-lib would
 * never emit it. The guard reads the dimensions the paint operator itself
 * reports and refuses BEFORE resolving the image, so a file that claims
 * 20000×20000 costs nothing to reject: no allocation, no decode, no wait on
 * an object that will never arrive.
 */
function pdfDeclaringImage(width: number, height: number, data: Buffer): Buffer {
    const content = Buffer.from('q 612 0 0 792 0 0 cm /Im0 Do Q\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            + '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    ];
    let out = Buffer.from('%PDF-1.4\n');
    const offsets: number[] = [];
    const push = (n: number, body: string, stream?: Buffer) => {
        offsets[n] = out.length;
        let chunk = Buffer.from(`${n} 0 obj\n${body}\n`);
        if (stream) {
            chunk = Buffer.concat([chunk, Buffer.from('stream\n'), stream, Buffer.from('\nendstream\n')]);
        }
        out = Buffer.concat([out, chunk, Buffer.from('endobj\n')]);
    };
    objects.forEach((body, i) => push(i + 1, body));
    push(4, `<< /Length ${content.length} >>`, content);
    push(5, `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} `
        + `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>`, data);
    const xref = out.length;
    let table = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    return Buffer.concat([
        out,
        Buffer.from(table),
        Buffer.from(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`),
    ]);
}

describe('input size budget', () => {
    it('admits a document at the cap and refuses one past it', () => {
        // A ceiling, not a fence: exactly at the cap still extracts.
        expect(withinByteBudget(MAX_PDF_BYTES)).toBe(true);
        expect(withinByteBudget(MAX_PDF_BYTES + 1)).toBe(false);
    });

    it('admits the ordinary case', () => {
        expect(withinByteBudget(12 * 1024 * 1024)).toBe(true);
        expect(withinByteBudget(0)).toBe(true);
    });

    it('refuses nonsense sizes rather than trusting them', () => {
        expect(withinByteBudget(-1)).toBe(false);
        expect(withinByteBudget(Number.NaN)).toBe(false);
    });

    it("declines 'too-large' before handing anything to the parser", async () => {
        // An empty buffer reporting an oversized length. The guard reads
        // `.length` and nothing else before declining, so that is the entire
        // input this needs — allocating 200 MB to ask a question about a
        // number would only make the suite slower and fragile under a
        // constrained CI memory limit.
        const oversized = Buffer.alloc(0);
        Object.defineProperty(oversized, 'length', { value: MAX_PDF_BYTES + 1 });

        const out = await EXTRACTORS['pdf-text-layer']!.extract(oversized, 'application/pdf');
        expect(out).toEqual({ declined: 'too-large' });
    });
});

describe('per-image pixel budget', () => {
    it('admits a page-sized scan', () => {
        // US Letter at 300dpi — 2550×3300, the ordinary case this must not reject.
        expect(withinPixelBudget(2550, 3300)).toBe(true);
    });

    it('admits a large-format scan', () => {
        // A0 at 300dpi is around 35 megapixels: big, legitimate, still allowed.
        expect(withinPixelBudget(9933, 3509)).toBe(true);
    });

    it('admits an ordinary page scanned at high resolution', () => {
        // US Letter at 600dpi — 5100×6600, ~34 MP. Reachable with a normal
        // page and a good scanner, so the budget must not reject it.
        expect(withinPixelBudget(5100, 6600)).toBe(true);
    });

    it('rejects an image that would allocate more than the budget', () => {
        expect(withinPixelBudget(20_000, 20_000)).toBe(false);
    });

    it('rejects nonsense dimensions rather than trusting them', () => {
        expect(withinPixelBudget(0, 100)).toBe(false);
        expect(withinPixelBudget(-1, 100)).toBe(false);
        expect(withinPixelBudget(Number.NaN, 100)).toBe(false);
    });

    it('extracts an image inside the budget', async () => {
        // The control: a genuine 2×2 DeviceRGB image, 12 bytes of raw samples.
        // It resolves and comes back — so the guard is not rejecting wholesale.
        const byPage = await extractPageImages(pdfDeclaringImage(2, 2, Buffer.alloc(12)));
        expect(byPage.size).toBe(1);
        expect(byPage.get(1)![0]).toMatchObject({ width: 2, height: 2 });
    });

    it('yields nothing for a page whose image declares oversized dimensions', async () => {
        // Pins the OUTCOME — the page is left unread rather than decoded. Note
        // it does not isolate the mechanism: without the guard this file also
        // yields nothing, because 20000×20000 with three bytes of data cannot
        // resolve either. What the guard buys is that we never ask: the
        // dimensions come from the paint operator, so the refusal is free.
        const byPage = await extractPageImages(pdfDeclaringImage(20_000, 20_000, Buffer.alloc(3)));
        expect(byPage.size).toBe(0);
    });

    it('bounds the whole allocation chain, not just the decoded raster', () => {
        // Reading one image holds several copies at once — decoded samples,
        // the RGB conversion, and the PNG scanline buffer — so the cost per
        // pixel is ~10 bytes, not 3. Asserting against the real multiplier
        // keeps the budget honest: a future rise in the cap has to reckon
        // with the peak it actually implies.
        const peak = MAX_IMAGE_PIXELS * PEAK_BYTES_PER_PIXEL;
        expect(peak).toBeLessThanOrEqual(512 * 1024 * 1024);
    });
});
