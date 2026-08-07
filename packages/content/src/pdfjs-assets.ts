/**
 * Where pdf.js finds the asset bundles it does not carry in its main build.
 *
 * pdf.js ships the Standard 14 font programs (Foxit substitutes for Helvetica,
 * Times, Courier, Symbol, ZapfDingbats) as separate `.pfb` files rather than in
 * `pdf.mjs`. Without a `standardFontDataUrl` it cannot load them, and every
 * document that references a standard font logs
 *
 *   Warning: UnknownErrorException: Ensure that the `standardFontDataUrl` API
 *   parameter is provided.
 *
 * once per font per document — 66 lines on a single 28-page PDF, drowning real
 * output. That noise is the reason to fix it; text extraction itself was never
 * affected, because `getTextContent()` reads the content stream and the font's
 * encoding, not its glyph outlines.
 *
 * Resolved through `require.resolve` rather than a path relative to this file:
 * the built `dist/` sits at a different depth than `src/`, and npm may hoist
 * `pdfjs-dist` to the workspace root or nest it under this package. Asking the
 * resolver is the only form that is correct in all of those, including inside
 * the service images where the tree is installed fresh.
 *
 * The trailing slash is required — pdf.js concatenates the filename onto this
 * string.
 */

import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);

export const STANDARD_FONT_DATA_URL =
  `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}${path.sep}`;
