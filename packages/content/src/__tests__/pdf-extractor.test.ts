/**
 * pdfExtractor — Phase 1 (SMELTER-MEDIA-TYPES.md, #744).
 *
 * The 'pdf-text-layer' registry slot: class A (native text layer) extracts
 * through the shared `extractPdfTextLayer` reader; every other class
 * declines with its name — 'no-text-layer' (B, scanned), 'encrypted' (F),
 * 'corrupt' (G). Fixtures are the generator's (vitest globalSetup).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';
import { EXTRACTORS } from '../content-extractor';
import { classifyPdfError } from '../pdf-extractor';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const KNOWN_PHRASE = 'known phrase from fixture';

describe('pdfExtractor (Phase 1 registry slot)', () => {
    it("fills the 'pdf-text-layer' slot", () => {
        expect(EXTRACTORS['pdf-text-layer']).not.toBeNull();
    });

    it('class A: extracts the text layer with blocks and pdfClass', async () => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        const out = await ex!.extract(readFixture('single-line.pdf'), 'application/pdf');
        expect(out).not.toHaveProperty('declined');
        if ('declined' in out) throw new Error('unreachable');
        expect(out.text).toContain(KNOWN_PHRASE);
        expect(out.method).toBe('pdf-text-layer');
        expect(out.pdfClass).toBe('A');
        // blocks are the reader's items verbatim — the shared geometry shape.
        const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));
        expect(out.blocks).toEqual(layer!.items);
    });

    it("class B: scanned PDF declines 'no-text-layer'", async () => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        const out = await ex!.extract(readFixture('scanned.pdf'), 'application/pdf');
        expect(out).toEqual({ declined: 'no-text-layer' });
    });

    it("class G: corrupt bytes decline 'corrupt'", async () => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        const out = await ex!.extract(Buffer.from('not a pdf at all', 'utf8'), 'application/pdf');
        expect(out).toEqual({ declined: 'corrupt' });
    });
});

describe('class C — hybrid native/scanned routing (Phase 3)', () => {
    const extract = async (fixture: string) => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        return ex!.extract(readFixture(fixture), 'application/pdf');
    };

    it('names the pages it could not read, and labels the document hybrid', async () => {
        const out = await extract('mixed.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.pdfClass).toBe('C');
        expect(out.unreadPages).toEqual([2]);
        // Partial coverage still yields what it can — page 1 embeds today.
        expect(out.text).toContain('native page text');
    });

    it('a fully native document reports no gap', async () => {
        const out = await extract('multi-page.pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        expect(out.pdfClass).toBe('A');
        expect(out.unreadPages).toBeUndefined();
    });

    // Guard: increment 2 makes nothing newly searchable. A fully scanned
    // document still declines and still writes no vectors — only OCR
    // (increment 4) changes that.
    it('a fully scanned document still declines', async () => {
        const out = await extract('scanned-image.pdf');
        expect(out).toEqual({ declined: 'no-text-layer' });
    });
});

describe('class D — table structure (Phase 2)', () => {
    const extract = async (fixture: string) => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        const out = await ex!.extract(readFixture(fixture), 'application/pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        return out;
    };

    it('reconstructs a regular grid as markdown rows', async () => {
        const out = await extract('table.pdf');
        expect(out.pdfClass).toBe('D');
        expect(out.method).toBe('table');
        // Row coherence is the point: a row's cells sit together on one line,
        // so chunking cannot scatter them.
        expect(out.text).toContain('| Treatment | Responders | p-value |');
        expect(out.text).toContain('| Drug A | 12% | 0.03 |');
        expect(out.text).toContain('| Placebo | 4% | 0.88 |');
    });

    it('anchors table cells to their page geometry', async () => {
        const out = await extract('table.pdf');
        const cell = out.blocks?.find((b) => out.text.slice(b.start, b.end) === 'Drug A');
        expect(cell).toBeDefined();
        expect(cell!.page).toBe(1);
        // Row two of the fixture, first column: x 72, y 720 − 24.
        expect(Math.abs(cell!.x - 72)).toBeLessThanOrEqual(1);
        expect(Math.abs(cell!.y - 696)).toBeLessThanOrEqual(2);
    });

    // Precision over recall: a false table scrambles content, a miss merely
    // falls back to Phase 1 behavior. Prose must never be read as a grid.
    it('falls back to class A for single-column prose', async () => {
        const out = await extract('multi-line.pdf');
        expect(out.pdfClass).toBe('A');
        expect(out.text).not.toContain('|');
    });

    it('falls back to class A for two-column prose', async () => {
        const out = await extract('multi-column.pdf');
        expect(out.pdfClass).toBe('A');
        expect(out.text).not.toContain('|');
    });
});

describe('class E — AcroForm field values (Phase 2)', () => {
    const extract = async (fixture: string) => {
        const ex = EXTRACTORS['pdf-text-layer'];
        expect(ex).not.toBeNull();
        const out = await ex!.extract(readFixture(fixture), 'application/pdf');
        if ('declined' in out) throw new Error(`unexpected decline: ${out.declined}`);
        return out;
    };

    it('folds filled field values into the extracted text', async () => {
        const out = await extract('form.pdf');
        expect(out.text).toContain('policy.holderName: Ada Lovelace');
        expect(out.text).toContain('policy.coverageAmount: $250,000');
        expect(out.text).toContain('policy.state: NY');
        // The drawn label text is still there — fields augment, never replace.
        expect(out.text).toContain('Policy Application');
        expect(out.pdfClass).toBe('E');
        expect(out.method).toBe('form');
    });

    it('omits fields with no value — an empty field is not content', async () => {
        const out = await extract('form.pdf');
        expect(out.text).not.toContain('policy.notes');
    });

    it('anchors each folded value with the widget geometry', async () => {
        const out = await extract('form.pdf');
        // The block's char range must select exactly the value, and carry the
        // field's own rectangle — folding adds text without inventing geometry.
        const valueBlock = out.blocks?.find(
            (b) => out.text.slice(b.start, b.end) === 'Ada Lovelace',
        );
        expect(valueBlock).toBeDefined();

        const layer = await extractPdfTextLayer(readFixture('form.pdf'));
        const field = layer!.fields.find((f) => f.name === 'policy.holderName');
        expect(field).toBeDefined();
        expect(valueBlock).toMatchObject({
            page: field!.page,
            x: field!.x,
            y: field!.y,
            width: field!.width,
            height: field!.height,
        });
        // And that geometry is the widget the fixture placed at (72, 700),
        // 200x20 — within the border inset pdf.js reports.
        expect(field!.page).toBe(1);
        expect(Math.abs(field!.x - 72)).toBeLessThanOrEqual(1);
        expect(Math.abs(field!.y - 700)).toBeLessThanOrEqual(1);
        expect(Math.abs(field!.width - 200)).toBeLessThanOrEqual(1);
    });

    it('a document without a form stays class A', async () => {
        const out = await extract('single-line.pdf');
        expect(out.pdfClass).toBe('A');
        expect(out.text).toContain(KNOWN_PHRASE);
    });
});

describe('classifyPdfError', () => {
    // pdf.js signals a password-protected document with PasswordException;
    // classify by name so any build of pdf.js matches. Everything else the
    // parser throws is class G.
    it("maps PasswordException to 'encrypted'", () => {
        const passwordError = Object.assign(new Error('No password given'), { name: 'PasswordException' });
        expect(classifyPdfError(passwordError)).toBe('encrypted');
    });

    it("maps parser failures to 'corrupt'", () => {
        const invalid = Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' });
        expect(classifyPdfError(invalid)).toBe('corrupt');
        expect(classifyPdfError(new Error('anything else'))).toBe('corrupt');
    });
});
