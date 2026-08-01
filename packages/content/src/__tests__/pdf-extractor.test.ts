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
