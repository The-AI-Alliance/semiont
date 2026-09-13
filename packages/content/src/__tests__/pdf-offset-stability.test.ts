/**
 * The text layer's offsets are PINNED, because something downstream identifies
 * annotations by them.
 *
 * `buildPdfAnnotation` stores no `TextPositionSelector` — it holds page geometry
 * and the quoted text, on the stated grounds that the extracted text layer is a
 * derived artifact whose char offsets are not a durable anchor. But the id it
 * mints is content-addressed over `${start}:${end}:${exact}`, i.e. over exactly
 * those offsets. So an extraction that moves them re-identifies every annotation
 * on every PDF, and the duplicates are byte-identical in every stored field
 * except `id` — no error, no signature, nothing downstream misbehaving.
 *
 * The rest of this suite cannot catch that. It looks spans up BY CONTENT —
 * `items.find((b) => text.slice(b.start, b.end) === 'Drug A')` — which is the
 * right shape for testing extraction behavior and is invariant under a uniform
 * offset shift. These assertions are the opposite: absolute, and deliberately
 * brittle.
 *
 * **A failure here is not necessarily a bug.** It means the extraction output
 * moved — most likely a `pdfjs-dist` upgrade, which the caret pin permits without
 * anyone deciding. Re-baselining is a legitimate response, but it is a DECISION:
 * the same upgrade silently changes the id of every PDF annotation minted
 * afterwards, so a document re-detected across it mints a fresh set alongside the
 * old ones. Take that consciously, and say so in the commit.
 *
 * Measured 2026-09-12: `pdfjs-dist` 6.2.108 → 6.3.289 (a move the `^6.2.108`
 * caret already allows) left these byte-identical across 1,192 pages of real
 * documents — 1,254,746 text runs, streams and assembled text alike. This gate
 * is what keeps that true rather than merely once-observed.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { describe, it, expect } from 'vitest';
import { extractPdfTextLayer } from '../extract-pdf-text-layer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const readFixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const WHY_IT_MOVED =
  'Text-layer extraction changed. Every PDF annotation id is hashed over these '
  + 'offsets, so re-baselining also re-identifies every PDF annotation minted from '
  + 'here on. Check the pdfjs-dist version before accepting the new values.';

describe('text-layer offsets are stable across engine versions', () => {
  it('single-line: exact text and item offsets', async () => {
    const layer = await extractPdfTextLayer(readFixture('single-line.pdf'));

    expect(layer, WHY_IT_MOVED).not.toBeNull();
    expect(layer!.text, WHY_IT_MOVED).toBe('known phrase from fixture \n');
    expect(layer!.items, WHY_IT_MOVED).toEqual([
      { start: 0, end: 25, page: 1, x: 72, y: 720, width: 138.048, height: 12 },
    ]);
  });

  it('multi-line: the separator convention is part of the offsets', async () => {
    // `anchorRuns` puts '\n' after a run pdf.js flags with `hasEOL` and ' '
    // otherwise. That choice is what every offset after the first line depends
    // on, so it is pinned here rather than left implicit — a change in how pdf.js
    // reports line ends would move every subsequent offset without changing a
    // single character of the text a reader sees.
    const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));

    expect(layer, WHY_IT_MOVED).not.toBeNull();
    expect(layer!.text, WHY_IT_MOVED).toBe(
      'first line of text\nsecond line of text\nthird line of text \n',
    );
    expect(layer!.items.map((item) => [item.start, item.end]), WHY_IT_MOVED).toEqual([
      [0, 18], [19, 38], [39, 57],
    ]);
  });

  it('the geometry an annotation actually STORES is pinned too', async () => {
    // The id is hashed over offsets, but the rects are what the annotation
    // carries — so they are what a reader could compare after the fact. If the
    // report's preferred fix ever lands (identity from the durable anchor), these
    // become the identity inputs, and this assertion becomes load-bearing rather
    // than merely descriptive.
    const layer = await extractPdfTextLayer(readFixture('multi-line.pdf'));

    expect(layer!.items.map((item) => [item.page, item.x, item.y]), WHY_IT_MOVED).toEqual([
      [1, 72, 720], [1, 72, 700], [1, 72, 680],
    ]);
  });
});
