/**
 * PDF extractor — the 'pdf-text-layer' strategy (SMELTER-MEDIA-TYPES).
 *
 * Wraps the shared `extractPdfTextLayer` reader (detection's other consumer)
 * and turns a PDF into text plus the geometry that indexes it, by class:
 *
 *   A native text layer   → read directly
 *   B scanned             → read the page pixels by OCR
 *   C hybrid              → both, with any page still unread reported
 *   D tables              → grid pages rewritten as markdown rows
 *   E forms               → AcroForm values folded in, anchored to widgets
 *   F/G encrypted, corrupt → declined by name, from the parser error
 *
 * Everything runs inline. OCR was originally planned off the hot path, but
 * the Smelter's lanes are per-resource and concurrent, so a slow page delays
 * only its own resource — see SMELTER-MEDIA-TYPES Design §4 (revised).
 */

import { isObject, type PdfTextItem } from '@semiont/core';
import { extractPdfTextLayer } from './extract-pdf-text-layer';
import type { ContentExtractor, ExtractedText, ExtractionCache } from './content-extractor';
import type { PdfTextLayer } from './pdf-text-layer';
import { detectTable, renderTable } from './pdf-tables';
import { extractPageImages } from './pdf-page-images';
import { recognizeImages } from './ocr';
import { mapWordsToItems } from './ocr-geometry';


/** One OCR'd page: its text, and word geometry with page-local offsets. */
interface OcrPageResult {
  text: string;
  items: PdfTextItem[];
  /** Per-word confidences, kept only long enough to summarize. */
  confidences: number[];
}

/**
 * Largest PDF this will attempt, in bytes.
 *
 * A PDF is a compressed container, so input size bounds nothing on its own —
 * but it is the one number available before the parser touches the file, and
 * refusing here means a hostile or pathological document never gets to expand
 * inside pdf.js. Chosen to sit above real corpora (a few hundred pages of
 * scanned FOIA material runs tens of megabytes) while still being a ceiling.
 *
 * A starting point, not a measured optimum — revisit against a real corpus
 * (SMELTER-MEDIA-TYPES, live-testing follow-up). The per-image budget in
 * `pdf-page-images` guards the decoded side, which is where the unbounded
 * growth actually lives.
 */
export const MAX_PDF_BYTES = 200 * 1024 * 1024;

/** Whether a document is small enough to attempt. Exported because the
 *  threshold is a judgement, and judgements deserve tests that do not have to
 *  materialize two hundred megabytes to ask the question. */
export function withinByteBudget(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes >= 0 && bytes <= MAX_PDF_BYTES;
}

/** Words below this are worth an operator's attention. Tesseract reports
 *  0–100; readable text on a clean scan sits well above this. */
const LOW_CONFIDENCE = 60;

function summarize(confidences: number[]): ExtractedText['ocrConfidence'] {
  if (confidences.length === 0) return undefined;
  const total = confidences.reduce((sum, c) => sum + c, 0);
  return {
    mean: Math.round((total / confidences.length) * 10) / 10,
    lowConfidenceWords: confidences.filter((c) => c < LOW_CONFIDENCE).length,
    totalWords: confidences.length,
  };
}

/**
 * Read the pages that have no text layer by OCR'ing their pixels. Returns
 * results only for pages that yielded text; a page absent from the map stayed
 * unread. Pages with no extractable image never reach the engine.
 *
 * Each word is anchored through the matrix that placed its image, so a scanned
 * page ends up carrying the same kind of geometry a native one does.
 */
async function ocrPages(
  content: Buffer,
  cache?: ExtractionCache,
  pageNumbers?: number[],
): Promise<OcrPageResult> {
  // The cache sits here rather than around `extract()` because this is where
  // the cost is: 82% of extraction time is Tesseract, and the text-layer parse
  // that classifies the document has to run either way. A document with a text
  // layer never reaches this function, so it never produces an entry.
  // Whole-resource on both sides. A page map is how this function iterates, not
  // what anyone consuming the result wants — the transport, the browser and a
  // headless client all want one `AnchoredText`, so that is what is stored.
  // Confidences are absent on a hit: they are logged at extraction, and
  // re-reporting identical numbers for identical bytes says nothing.
  const hit = await cache?.store.read(cache.key);
  if (hit) return { text: hit.text, items: hit.items, confidences: [] };

  const imagesByPage = await extractPageImages(content, pageNumbers);
  if (imagesByPage.size === 0) return { text: '', items: [], confidences: [] };

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
    const confidences: number[] = [];
    for (const image of images) {
      const result = recognized[cursor++];
      if (!result?.text.trim()) continue;
      if (text) text += '\n';
      items.push(...mapWordsToItems(result.words, image, page, text.length));
      confidences.push(...result.words.map((word) => word.confidence));
      text += result.text;
    }
    if (text) byPage.set(page, { text, items, confidences });
  }

  // Joined at base 0 — the document's own coordinates. Class C shifts by the
  // native text length at its call site, so what is stored never depends on
  // which document it was later spliced into.
  const joined = joinPages(byPage, 0);

  // Record what the engine produced, including nothing: a scan it cannot read
  // costs a full recognition pass to discover, so "we read this and there was
  // nothing" is a result worth keeping.
  await cache?.store.write(cache.key, { text: joined.text, items: joined.items });

  return joined;
}

/**
 * Recovered pages in page order as one block of text, with every word's
 * offsets shifted to where its page actually lands. `baseOffset` is where this
 * block begins in the document being assembled.
 */
function joinPages(byPage: Map<number, OcrPageResult>, baseOffset: number): OcrPageResult {
  let text = '';
  const items: PdfTextItem[] = [];
  const confidences: number[] = [];
  for (const [, page] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    if (text) text += '\n\n';
    const shift = baseOffset + text.length;
    for (const item of page.items) {
      items.push({ ...item, start: item.start + shift, end: item.end + shift });
    }
    confidences.push(...page.confidences);
    text += page.text;
  }
  return { text, items, confidences };
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
  async extract(content, _mediaType, cache) {
    // Before the parser sees it: everything downstream — parse, image decode,
    // OCR — expands from these bytes, so this is the only gate that costs
    // nothing to enforce.
    if (!withinByteBudget(content.length)) return { declined: 'too-large' };

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
      const ocr = await ocrPages(content, cache);
      if (!ocr.text) return { declined: 'no-text-layer' };
      const confidence = summarize(ocr.confidences);
      return {
        text: ocr.text,
        items: ocr.items,
        method: 'ocr',
        pdfClass: 'B',
        ...(confidence ? { ocrConfidence: confidence } : {}),
      };
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
    // rather than spliced into reading order, so the items already computed
    // for the native pages keep pointing at the right characters; OCR text
    // carries no geometry of its own this phase (mapping pixel boxes back to
    // page points needs the image's placement transform — #739's critical
    // path, not embedding's).
    const recovered = await ocrPages(content, cache, unreadPages);
    const readPages = new Set(recovered.items.map((item) => item.page));
    const stillUnread = unreadPages.filter((page) => !readPages.has(page));
    const hybridClass = shaped.pdfClass === 'A' ? 'C' as const : shaped.pdfClass;
    if (!recovered.text) {
      return { ...shaped, unreadPages: stillUnread, pdfClass: hybridClass };
    }
    // Appended, so the native pages' items keep pointing at the right
    // characters; the OCR'd words are offset to where they actually land.
    const shift = shaped.text.length;
    const ocr: OcrPageResult = {
      text: recovered.text,
      items: recovered.items.map((item) => ({ ...item, start: item.start + shift, end: item.end + shift })),
      confidences: recovered.confidences,
    };
    const confidence = summarize(ocr.confidences);
    return {
      ...shaped,
      text: `${shaped.text}${ocr.text}\n`,
      items: [...(shaped.items ?? []), ...ocr.items],
      method: 'ocr',
      pdfClass: hybridClass,
      ...(confidence ? { ocrConfidence: confidence } : {}),
      ...(stillUnread.length > 0 ? { unreadPages: stillUnread } : {}),
    };
  },
};
