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
import type { ContentExtractor } from './content-extractor';

/**
 * pdf.js signals a password-protected document with PasswordException.
 * Matched by name, not instanceof — pdf.js exception classes descend from
 * its own BaseException, not Error. Everything else the parser throws is
 * class G.
 */
export function classifyPdfError(error: unknown): 'encrypted' | 'corrupt' {
  return isObject(error) && error.name === 'PasswordException' ? 'encrypted' : 'corrupt';
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
    return { text: layer.text, blocks: layer.items, method: 'pdf-text-layer', pdfClass: 'A' };
  },
};
