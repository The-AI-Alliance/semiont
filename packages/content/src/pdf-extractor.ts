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
 * rectangle, so `blocks` stays a complete geometry index of `text`.
 */
function foldFormFields(layer: PdfTextLayer): ExtractedText {
  let text = layer.text;
  const blocks: PdfTextItem[] = [...layer.items];
  for (const field of layer.fields) {
    const start = text.length + `${field.name}: `.length;
    text += `${field.name}: ${field.value}\n`;
    blocks.push({
      start,
      end: start + field.value.length,
      page: field.page,
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    });
  }
  return { text, blocks, method: 'form', pdfClass: 'E' };
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
    const items = layer.items.filter((item) => item.page === page.pageNumber);
    return { page, items, table: detectTable(items, layer.text) };
  });
  if (!pages.some((p) => p.table)) return null;

  let text = '';
  const blocks: PdfTextItem[] = [];
  for (const { page, items, table } of pages) {
    if (table) {
      const rendered = renderTable(table, page.pageNumber, text.length);
      text += rendered.text;
      blocks.push(...rendered.blocks);
    } else {
      // Verbatim page: copy its slice and shift its runs' offsets to match.
      const shift = text.length - page.textStart;
      text += layer.text.slice(page.textStart, page.textEnd);
      for (const item of items) {
        blocks.push({ ...item, start: item.start + shift, end: item.end + shift });
      }
    }
  }
  return { text, blocks, method: 'table', pdfClass: 'D' };
}

export const pdfExtractor: ContentExtractor = {
  async extract(content) {
    let layer;
    try {
      layer = await extractPdfTextLayer(content);
    } catch (error) {
      return { declined: classifyPdfError(error) };
    }
    if (!layer) return { declined: 'no-text-layer' };

    // One class per document, so a filled form outranks a grid: its values
    // are content that exists nowhere else, while a table's cells are at
    // worst reordered.
    const shaped = layer.fields.length > 0
      ? foldFormFields(layer)
      : shapeTables(layer)
        ?? { text: layer.text, blocks: layer.items, method: 'pdf-text-layer' as const, pdfClass: 'A' as const };

    // A page with no text-showing operators is scanned: its characters exist
    // only as pixels. Report those pages rather than dropping them silently —
    // the document embeds what it can now, and this is the list OCR works
    // from. 'C' (hybrid) replaces the plain-prose label only; a form or table
    // keeps its own class, and carries the gap just the same.
    const unreadPages = layer.pages.filter((page) => !page.hasTextLayer).map((page) => page.pageNumber);
    if (unreadPages.length === 0) return shaped;
    return {
      ...shaped,
      unreadPages,
      pdfClass: shaped.pdfClass === 'A' ? 'C' : shaped.pdfClass,
    };
  },
};
