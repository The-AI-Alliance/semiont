/**
 * PDF extractor — the 'pdf-text-layer' strategy (SMELTER-MEDIA-TYPES Phase 1).
 *
 * Wraps the shared `extractPdfTextLayer` reader (detection's other consumer)
 * and classifies its failures into the decline vocabulary: class A (native
 * text layer) extracts; class B (scanned, no text items) declines
 * 'no-text-layer'; class F (encrypted) and class G (corrupt/truncated)
 * decline from the parser error. Class A runs inline on the smelter's hot
 * path — text-layer reading is cheap and deterministic; OCR (Phase 3) is
 * what moves off it.
 */

import { isObject } from '@semiont/core';
import { extractPdfTextLayer } from './extract-pdf-text-layer';
import type { ContentExtractor, ExtractedText } from './content-extractor';
import type { PdfTextLayer, PdfTextItem } from './pdf-text-layer';
import { detectTable, renderTable } from './pdf-tables';
import { extractPageImages } from './pdf-page-images';
import { recognizeImages } from './ocr';
import { mapWordsToItems } from './ocr-geometry';

/** One OCR'd page: its text, and word geometry with page-local offsets. */
interface OcrPageResult {
  text: string;
  items: PdfTextItem[];
}

/**
 * Read the pages that have no text layer by OCR'ing their pixels. Returns
 * results only for pages that yielded text; a page absent from the map stayed
 * unread. Pages with no extractable image never reach the engine.
 *
 * Each word is anchored through the matrix that placed its image, so a scanned
 * page ends up carrying the same kind of geometry a native one does.
 */
async function ocrPages(content: Buffer, pageNumbers?: number[]): Promise<Map<number, OcrPageResult>> {
  const imagesByPage = await extractPageImages(content, pageNumbers);
  if (imagesByPage.size === 0) return new Map();

  // One batch for the whole document: worker startup dominates per-page cost.
  const pages = [...imagesByPage.keys()].sort((a, b) => a - b);
  const batch = pages.flatMap((page) => imagesByPage.get(page)!.map((image) => image.png));
  const recognized = await recognizeImages(batch);

  const byPage = new Map<number, OcrPageResult>();
  let cursor = 0;
  for (const page of pages) {
    const images = imagesByPage.get(page)!;
    let text = '';
    const items: PdfTextItem[] = [];
    for (const image of images) {
      const result = recognized[cursor++];
      if (!result?.text.trim()) continue;
      if (text) text += '\n';
      items.push(...mapWordsToItems(result.words, image, page, text.length));
      text += result.text;
    }
    if (text) byPage.set(page, { text, items });
  }
  return byPage;
}

/**
 * Recovered pages in page order as one block of text, with every word's
 * offsets shifted to where its page actually lands. `baseOffset` is where this
 * block begins in the document being assembled.
 */
function joinPages(byPage: Map<number, OcrPageResult>, baseOffset: number): OcrPageResult {
  let text = '';
  const items: PdfTextItem[] = [];
  for (const [, page] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (text) text += '\n\n';
    const shift = baseOffset + text.length;
    for (const item of page.items) {
      items.push({ ...item, start: item.start + shift, end: item.end + shift });
    }
    text += page.text;
  }
  return { text, items };
}

/**
 * pdf.js signals a password-protected document with PasswordException.
 * Matched by name, not instanceof — pdf.js exception classes descend from
 * its own BaseException, not Error. Everything else the parser throws is
 * class G.
 */
export function classifyPdfError(error: unknown): 'encrypted' | 'corrupt' {
  return isObject(error) && error.name === 'PasswordException' ? 'encrypted' : 'corrupt';
}

/**
 * Class E — fold filled AcroForm values into the embedding text.
 *
 * A form's answers live in the form dictionary, not the drawn page, so a
 * naive text-layer read returns the blank labels and loses every value.
 * Each value is appended as a `name: value` line and anchored by its widget
 * rectangle, so `items` stays a complete geometry index of `text`.
 */
function foldFormFields(layer: PdfTextLayer): ExtractedText {
  let text = layer.text;
  const items: PdfTextItem[] = [...layer.items];
  for (const field of layer.fields) {
    const start = text.length + `${field.name}: `.length;
    text += `${field.name}: ${field.value}\n`;
    items.push({
      start,
      end: start + field.value.length,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    });
  }
  return { text, items, method: 'form', pdfClass: 'E' };
}

/**
 * Class D — rewrite grid pages as markdown, keep every other page verbatim.
 *
 * Returns null when no page is a table, so the caller falls back to class A.
 * Pages are shaped independently: the common report — prose sections around
 * an outcome table — gets row-coherent tables without disturbing its prose.
 */
function shapeTables(layer: PdfTextLayer): ExtractedText | null {
  const pages = layer.pages.map((page) => {
    const pageItems = layer.items.filter((item) => item.page === page.pageNumber);
    return { page, pageItems, table: detectTable(pageItems, layer.text) };
  });
  if (!pages.some((p) => p.table)) return null;

  let text = '';
  const items: PdfTextItem[] = [];
  for (const { page, pageItems, table } of pages) {
    if (table) {
      const rendered = renderTable(table, page.pageNumber, text.length);
      text += rendered.text;
      items.push(...rendered.items);
    } else {
      // Verbatim page: copy its slice and shift its runs' offsets to match.
      const shift = text.length - page.textStart;
      text += layer.text.slice(page.textStart, page.textEnd);
      for (const item of pageItems) {
        items.push({ ...item, start: item.start + shift, end: item.end + shift });
      }
    }
  }
  return { text, items, method: 'table', pdfClass: 'D' };
}

export const pdfExtractor: ContentExtractor = {
  async extract(content) {
    let layer;
    try {
      layer = await extractPdfTextLayer(content);
    } catch (error) {
      return { declined: classifyPdfError(error) };
    }
    // Class B — no text operators anywhere: the characters exist only as
    // pixels, so read them. 'no-text-layer' now means OCR genuinely came up
    // empty, not that we never tried.
    if (!layer) {
      const ocr = joinPages(await ocrPages(content), 0);
      return ocr.text
        ? { text: ocr.text, items: ocr.items, method: 'ocr', pdfClass: 'B' }
        : { declined: 'no-text-layer' };
    }

    // One class per document, so a filled form outranks a grid: its values
    // are content that exists nowhere else, while a table's cells are at
    // worst reordered.
    const shaped = layer.fields.length > 0
      ? foldFormFields(layer)
      : shapeTables(layer)
        ?? { text: layer.text, items: layer.items, method: 'pdf-text-layer' as const, pdfClass: 'A' as const };

    // A page with no text-showing operators is scanned: its characters exist
    // only as pixels. Report those pages rather than dropping them silently —
    // the document embeds what it can now, and this is the list OCR works
    // from. 'C' (hybrid) replaces the plain-prose label only; a form or table
    // keeps its own class, and carries the gap just the same.
    const unreadPages = layer.pages.filter((page) => !page.hasTextLayer).map((page) => page.pageNumber);
    if (unreadPages.length === 0) return shaped;

    // Class C — read the scanned pages and append what OCR recovers. Appended
    // rather than spliced into reading order, so the blocks already computed
    // for the native pages keep pointing at the right characters; OCR text
    // carries no geometry of its own this phase (mapping pixel boxes back to
    // page points needs the image's placement transform — #739's critical
    // path, not embedding's).
    const recovered = await ocrPages(content, unreadPages);
    const stillUnread = unreadPages.filter((page) => !recovered.has(page));
    const hybridClass = shaped.pdfClass === 'A' ? 'C' as const : shaped.pdfClass;
    if (recovered.size === 0) {
      return { ...shaped, unreadPages: stillUnread, pdfClass: hybridClass };
    }
    // Appended, so the native pages' blocks keep pointing at the right
    // characters; the OCR'd words are offset to where they actually land.
    const ocr = joinPages(recovered, shaped.text.length);
    return {
      ...shaped,
      text: `${shaped.text}${ocr.text}\n`,
      items: [...(shaped.items ?? []), ...ocr.items],
      method: 'ocr',
      pdfClass: hybridClass,
      ...(stillUnread.length > 0 ? { unreadPages: stillUnread } : {}),
    };
  },
};
