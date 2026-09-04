/**
 * Seed the e2e KB with the minimum fixture set the spec suite assumes.
 *
 * The Playwright suite documents (in ``tests/e2e/README.md``) that it
 * "assumes the target KB has ≥2 resources and ≥1 entity type." Entity
 * types are auto-bootstrapped on gateway startup
 * (`packages/make-meaning/src/bootstrap/entity-types.ts`); resources are
 * not. A freshly-rebuilt template KB starts empty, which makes specs
 * 02-09 fail at the very first "open resource:" assertion.
 *
 * Seeds two `text/plain` resources (for the text-annotation specs) plus
 * four `application/pdf` resources: a 3-word render smoke fixture (for
 * `14-pdf-render.spec.ts`, the PDFJS-6-UNIFY browser smoke), a
 * text-layer fixture with a Concept-dense paragraph (for
 * `20-pdf-assisted-detection.spec.ts`, AI detection on a PDF), an
 * unreadable scan (for `22-pdf-scanned-decline.spec.ts` and
 * `23-pdf-anchored-text.spec.ts`), and a hybrid whose two pages are one
 * typed and one scanned (for `24-pdf-hybrid-class-c.spec.ts`). Every PDF is
 * seeded **first** on purpose: Discover lists resources newest-first
 * (`make-meaning/src/resource-context.ts` `sortByDateDesc`), so the two
 * oldest resources sort last and never become the `.first()` card the text
 * specs (02-09) open. Adding the PDFs must not displace that card.
 *
 * This module exports two entry points:
 *
 *   - `seedKb(opts)` — async function callable from Playwright's
 *     `globalSetup` hook. Idempotent: each seed has a stable
 *     storageUri so re-runs against an already-seeded KB skip cleanly.
 *
 *   - default export (also `seedKb`) — same function, exposed in the
 *     shape Playwright's `globalSetup` expects (see
 *     `playwright.config.ts`).
 *
 * Goes through `@semiont/sdk` like every other production caller —
 * `client.auth.password(...)` to authenticate, then
 * `client.yield.resource(...)` for each seed. No raw HTTP, no
 * hand-rolled multipart, no parallel implementation of the wire
 * protocol to drift out of sync.
 */

import { SemiontClient } from '@semiont/sdk';
import { getStorageUri } from '@semiont/core';
import { sessionFor } from '../lib/session';

interface SeedSpec {
  name: string;
  storageUri: string;
  format: 'text/plain' | 'application/pdf';
  language: string;
  /** Raw resource bytes — text encoded utf-8, PDF decoded from base64. */
  bytes: Buffer;
}

/**
 * A minimal, self-contained single-page PDF (300×200) that draws a blue
 * filled rectangle and the text "Smoke Test PDF" — enough that pdf.js
 * renders a non-blank page. Embedded as base64 rather than a fixture
 * file because the repo's only PDFs
 * (`packages/content/src/__tests__/fixtures/*.pdf`) are gitignored and
 * generated on demand, so they aren't guaranteed present in the e2e
 * container. Verified to load in pdfjs-dist@6 (numPages=1, text layer
 * "Smoke Test PDF").
 */
const PDF_FIXTURE_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2Jq' +
  'CjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2Jq' +
  'CjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAg' +
  'MjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAw' +
  'IFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA4MiA+PgpzdHJlYW0KMCAwIDEgcmcKNDAg' +
  'MTEwIDIyMCA2MCByZQpmCkJUCi9GMSAyNCBUZgowIDAgMCByZwo1MCA2MCBUZAooU21va2UgVGVz' +
  'dCBQREYpIFRqCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3Vi' +
  'dHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAw' +
  'MDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAw' +
  'MDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzcyIDAwMDAwIG4g' +
  'CnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDQyCiUlRU9G';

/**
 * A single-page (612×792) text-layer PDF whose content is a Concept-dense
 * essay on cellular respiration (~346 words). Unlike the 3-word "Spatial Smoke
 * PDF" above (a render smoke fixture), it carries enough extractable prose that
 * density-gated AI detection (highlight/comment) reliably finds ≥1 span and
 * entity extraction (reference/linking) finds many Concept entities —
 * `20-pdf-assisted-detection.spec.ts` runs comment + reference assist against
 * it. Standard Helvetica Type1 font; text drawn with BT/Tf/Td/Tj operators,
 * one positioned line per string advanced by the T-star line-move. Verified
 * through `@semiont/content`'s `extractPdfTextLayer` (pdfjs-dist@6): 1 page,
 * 31 text items, text layer beginning "Cellular respiration is the set of
 * metabolic reactions".
 */
const TEXT_PDF_FIXTURE_BASE64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5k' +
  'b2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4K' +
  'ZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3gg' +
  'WzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAv' +
  'Q29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCAyNTU4ID4+CnN0' +
  'cmVhbQpCVAovRjEgMTAgVGYKMTQgVEwKNTQgNzQ4IFRkCihDZWxsdWxhciByZXNwaXJhdGlv' +
  'biBpcyB0aGUgc2V0IG9mIG1ldGFib2xpYyByZWFjdGlvbnMgYW5kIHByb2Nlc3NlcyB0aGF0' +
  'KSBUagpUKgoodGFrZSBwbGFjZSBpbiB0aGUgY2VsbHMgb2Ygb3JnYW5pc21zIHRvIGNvbnZl' +
  'cnQgYmlvY2hlbWljYWwgZW5lcmd5IGZyb20pIFRqClQqCihudXRyaWVudHMgaW50byBhZGVu' +
  'b3NpbmUgdHJpcGhvc3BoYXRlLCBhbmQgdGhlbiByZWxlYXNlIHdhc3RlIHByb2R1Y3RzLikg' +
  'VGoKVCoKKFRoZSByZWFjdGlvbnMgaW52b2x2ZWQgaW4gcmVzcGlyYXRpb24gYXJlIGNhdGFi' +
  'b2xpYyByZWFjdGlvbnMgdGhhdCBicmVhaykgVGoKVCoKKGxhcmdlIG1vbGVjdWxlcyBpbnRv' +
  'IHNtYWxsZXIgb25lcywgcmVsZWFzaW5nIGVuZXJneSBhcyB0aGUgY292YWxlbnQgYm9uZHMp' +
  'IFRqClQqCihiZXR3ZWVuIGF0b21zIGFyZSByZWFycmFuZ2VkLiBHbHljb2x5c2lzIGlzIGEg' +
  'bWV0YWJvbGljIHBhdGh3YXkgdGhhdCBvY2N1cnMpIFRqClQqCihpbiB0aGUgY3l0b3BsYXNt' +
  'LCBjb252ZXJ0aW5nIGEgbW9sZWN1bGUgb2YgZ2x1Y29zZSBpbnRvIHR3byBtb2xlY3VsZXMg' +
  'b2YpIFRqClQqCihweXJ1dmF0ZSB3aGlsZSBwcm9kdWNpbmcgYSBzbWFsbCBuZXQgeWllbGQg' +
  'b2YgQVRQIGFuZCB0aGUgZWxlY3Ryb24gY2FycmllcikgVGoKVCoKKE5BREguIFRoZSBweXJ1' +
  'dmF0ZSBpcyB0aGVuIHRyYW5zcG9ydGVkIGludG8gdGhlIG1pdG9jaG9uZHJpYSwgd2hlcmUg' +
  'aXQgaXMpIFRqClQqCihveGlkaXplZCBhbmQgY29tYmluZWQgd2l0aCBjb2VuenltZSBBIHRv' +
  'IGZvcm0gYWNldHlsIGNvZW56eW1lIEEuIFRoZSBjaXRyaWMpIFRqClQqCihhY2lkIGN5Y2xl' +
  'LCBhbHNvIGNhbGxlZCB0aGUgS3JlYnMgY3ljbGUsIG94aWRpemVzIGFjZXR5bC1Db0EgYW5k' +
  'IHRyYW5zZmVycykgVGoKVCoKKGhpZ2gtZW5lcmd5IGVsZWN0cm9ucyB0byB0aGUgY2Fycmll' +
  'cnMgTkFESCBhbmQgRkFESDIgd2hpbGUgcmVsZWFzaW5nIGNhcmJvbikgVGoKVCoKKGRpb3hp' +
  'ZGUgYXMgYSBieXByb2R1Y3QuIE94aWRhdGl2ZSBwaG9zcGhvcnlsYXRpb24gdGhlbiB1c2Vz' +
  'IHRoZSBlbGVjdHJvbikgVGoKVCoKKHRyYW5zcG9ydCBjaGFpbiBlbWJlZGRlZCBpbiB0aGUg' +
  'aW5uZXIgbWl0b2Nob25kcmlhbCBtZW1icmFuZSB0byBwdW1wIHByb3RvbnMpIFRqClQqCiha' +
  'Y3Jvc3MgaXQgYW5kIGVzdGFibGlzaCBhbiBlbGVjdHJvY2hlbWljYWwgZ3JhZGllbnQga25v' +
  'd24gYXMgdGhlIHByb3RvbikgVGoKVCoKKG1vdGl2ZSBmb3JjZS4gVGhlIGVsZWN0cm9uIHRy' +
  'YW5zcG9ydCBjaGFpbiBpcyBidWlsdCBmcm9tIGZvdXIgbGFyZ2UgcHJvdGVpbikgVGoKVCoK' +
  'KGNvbXBsZXhlcywgbGFiZWxlZCBjb21wbGV4IG9uZSB0aHJvdWdoIGNvbXBsZXggZm91ciwg' +
  'YWxvbmcgd2l0aCB0aGUgbW9iaWxlKSBUagpUKgooY2FycmllcnMgdWJpcXVpbm9uZSBhbmQg' +
  'Y3l0b2Nocm9tZSBjIHRoYXQgZmVycnkgZWxlY3Ryb25zIGJldHdlZW4gdGhlbS4gQXMpIFRq' +
  'ClQqCihlbGVjdHJvbnMgcGFzcyBkb3duIHRoZSBjaGFpbiB0b3dhcmQgb3h5Z2VuLCB0aGUg' +
  'Y29tcGxleGVzIHB1bXAgaHlkcm9nZW4pIFRqClQqCihpb25zIGZyb20gdGhlIG1pdG9jaG9u' +
  'ZHJpYWwgbWF0cml4IGludG8gdGhlIGludGVybWVtYnJhbmUgc3BhY2UsIHN0b3JpbmcpIFRq' +
  'ClQqCihwb3RlbnRpYWwgZW5lcmd5IGluIHRoZSBncmFkaWVudC4gQVRQIHN5bnRoYXNlIGhh' +
  'cm5lc3NlcyB0aGF0IGdyYWRpZW50KSBUagpUKgoodGhyb3VnaCBjaGVtaW9zbW9zaXMgdG8g' +
  'cGhvc3Bob3J5bGF0ZSBBRFAgaW50byBBVFAsIHRoZSBwcmltYXJ5IGVuZXJneSkgVGoKVCoK' +
  'KGN1cnJlbmN5IG9mIHRoZSBjZWxsLiBPeHlnZW4gc2VydmVzIGFzIHRoZSBmaW5hbCBlbGVj' +
  'dHJvbiBhY2NlcHRvciwpIFRqClQqCihjb21iaW5pbmcgd2l0aCBzcGVudCBlbGVjdHJvbnMg' +
  'YW5kIHByb3RvbnMgdG8gZm9ybSB3YXRlciBhdCB0aGUgZW5kIG9mIHRoZSkgVGoKVCoKKGNo' +
  'YWluLiBBZXJvYmljIHJlc3BpcmF0aW9uIG9mIGEgc2luZ2xlIGdsdWNvc2UgbW9sZWN1bGUg' +
  'Y2FuIHlpZWxkIHJvdWdobHkpIFRqClQqCih0aGlydHkgdG8gdGhpcnR5LWVpZ2h0IG1vbGVj' +
  'dWxlcyBvZiBBVFAgYWNyb3NzIGFsbCBvZiB0aGVzZSBzdGFnZXMuIEluIHRoZSkgVGoKVCoK' +
  'KGFic2VuY2Ugb2Ygb3h5Z2VuLCBtYW55IGNlbGxzIGZhbGwgYmFjayBvbiBmZXJtZW50YXRp' +
  'b24sIGFuIGFuYWVyb2JpYykgVGoKVCoKKHBhdGh3YXkgdGhhdCByZWdlbmVyYXRlcyB0aGUg' +
  'Y2FycmllcnMgZ2x5Y29seXNpcyByZXF1aXJlcy4gSW4gaHVtYW4gbXVzY2xlKSBUagpUKgoo' +
  'Y2VsbHMgZmVybWVudGF0aW9uIHByb2R1Y2VzIGxhY3RpYyBhY2lkLCB3aGlsZSBpbiB5ZWFz' +
  'dCBpdCBwcm9kdWNlcyBldGhhbm9sKSBUagpUKgooYW5kIGNhcmJvbiBkaW94aWRlLCB0aG91' +
  'Z2ggYm90aCByb3V0ZXMgeWllbGQgZmFyIGxlc3MgdXNhYmxlIGVuZXJneSBwZXIpIFRqClQq' +
  'Cihtb2xlY3VsZSBvZiBnbHVjb3NlIHRoYW4gYWVyb2JpYyByZXNwaXJhdGlvbiBwcm92aWRl' +
  'cyB0byB0aGUgb3JnYW5pc20uKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwg' +
  'L1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVu' +
  'ZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAK' +
  'MDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAw' +
  'MDAgbiAKMDAwMDAwMjg1MSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAw' +
  'IFIgPj4Kc3RhcnR4cmVmCjI5MjEKJSVFT0Y=';

// Names + storageUris are stable so a re-run sees the same KB shape.
//
// The two text documents are `text/plain` (NOT `text/markdown`): the
// markdown MIME type triggers ReactMarkdown rendering in BrowseView,
// which strips header syntax (`#`, `**`, etc.) from the rendered DOM.
// Annotations placed on those source-only characters can't be resolved
// to rendered positions, and the in-content overlay silently skips them.
// Plain text has a 1:1 source↔rendered offset mapping, so any selection
// round-trips and renders. Each has multiple paragraphs so the
// manual-highlight / manual-reference / comment / hover-beckon specs
// have text to select.
//
// The two PDFs are listed FIRST so they are created first → oldest → sort
/**
 * A single-page (612×792) **scanned** PDF: one full-page raster image and no
 * text operators at all, so `getTextContent()` is empty and the only way to
 * read it is OCR. Its raster is dark bars — deliberately NOT glyph-shaped, so
 * the recognizer reliably finds nothing and the job takes the *decline* path
 * (`22-pdf-scanned-decline.spec.ts`).
 *
 * Why not a raster of real words: a synthetic bitmap font is not a typeface,
 * and tesseract misreads it (measured: "SCANNED" read back as "SCHMNE" at
 * confidence 0). Asserting recognized *text* therefore needs a genuine scanned
 * document, which is a live-testing fixture, not a seed constant. What this
 * fixture pins is the deterministic half: a scan that cannot be read declines
 * cleanly and adds no garbage annotations.
 */
/**
 * A single-page **scanned** PDF whose raster is LEGIBLE: the words
 * "RECOVERED FROM / THE PIXELS" rendered from a real typeface at 110pt, then
 * flattened to a grayscale image. No text operators, so `getTextContent()` is
 * empty and the only way to read it is OCR — but unlike the smoke scan, OCR
 * reads it, and reads it reliably: measured against the live Smelter at
 * **95.8% mean confidence, 0 low-confidence words**, returning exactly
 * "RECOVERED FROM\\nTHE PIXELS" across repeated ingests.
 *
 * This is the fixture `23-pdf-anchored-text.spec.ts` quotes from. It exists
 * BECAUSE the smoke scan cannot serve that purpose: the smoke scan is dark
 * bars, deliberately unreadable, so `22-pdf-scanned-decline.spec.ts` can pin
 * the decline path. Two scans, two opposite jobs, two checksums — the
 * anchored-text store is keyed by content checksum, so neither can affect the
 * other.
 *
 * Regenerate with scripts/fixtures/make-legible-scan.py if the text changes.
 */
const LEGIBLE_SCAN_PDF_FIXTURE_BASE64 =
  'JVBERi0xLjcKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAw' +
  'IFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0g' +
  'L0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAy' +
  'IDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9YT2JqZWN0' +
  'IDw8IC9JbTAgNCAwIFIgPj4gPj4gL0NvbnRlbnRzIDUgMCBSID4+CmVuZG9iago0IDAg' +
  'b2JqCjw8IC9UeXBlIC9YT2JqZWN0IC9TdWJ0eXBlIC9JbWFnZSAvQml0c1BlckNvbXBv' +
  'bmVudCA4IC9XaWR0aCAxNjAwIC9IZWlnaHQgNTYwIC9Db2xvclNwYWNlIC9EZXZpY2VH' +
  'cmF5IC9GaWx0ZXIgL0ZsYXRlRGVjb2RlIC9MZW5ndGggMTAxNjQgPj4Kc3RyZWFtCnja' +
  '7d13wBxVvTfwTa/U0Iv0rvQmgoBciiCIIiggeoPtpQjSy6WJCCIgCApeKQoqRUCvQFCa' +
  'IE2R3ovUUJMQQkIKyVP2JYhKnv3N7GyZbfl8/kv2nLMzZ845331mZ2aLRQAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABrn1THnHrXnJ1dfdtF5Bg4cOWqZ' +
  '9bff+5SrH+uuurmJN/7sqD03W3WZhUcOGLLAEiuuveN+p172WI9upi0YvpBRz10n7rRE' +
  'ITJ8s0Oum1pxe8+dvceKYXMjNz/s+nf1Ny3N8KU5Fi2kGzh8/kVX+fj2e594yd3v1K3R' +
  'BItmbH76VV9dKLWhwVue/VoFffDwsR9LbW6eXX+TnkjXR7WOy/z+F0fVf5ZLd7b64Y6b' +
  '6jdw8LB5FlpyhTU23nqXvY847Zc3Pjm1WfOh2X2dx/DNsslfyVD7seRt+L2Vdu7Mjw/p' +
  'v/IeF41tfn48c9ACWTZ2i19l+9zV9dtNMzQ3/8HPp7TRvXhQZfnMx2DroPaQSU1Z05p9' +
  'uDM3tfCme595+5S2zo+q+jqP4Ztlk4eML1/7W/JDfpSx1umvNTU/7tq2X9bmFjrslfLT' +
  '75ylsk7xzz+Z3MxhUY27Mh6C1wYElXdr+prWlMNdWVP91z301p5OyI/sfZ3L8M2yyd8v' +
  'W3nSCPkhP8oa+NWnmpYfT+5cUYODv/lcentjVq1kx/d/s6K/3PfJeAjOiCqPaY01rdGH' +
  'u/Kmljr0wQ7Jj0x9ncvwzbLJS3VXNY7lh/wo+Syz7+Sm5MfU/QdU2uRn09p7ffsKW5v/' +
  'l0lNrReUHjUr2yFYJ6i7WHerrGmNPdxVNbXWlb2dkR8Z+jqf4Ztlk68qU7dnefkhP7JZ' +
  '4o4m5MdfV6q8ybT8uH6RytvbI2F6nx0V/kOmI/BEVPWQVlqfG3i4q2xqjct7OiM/yvZ1' +
  'PsM3yyZvXmZ7rinID/mR0aALG50fPccNKNQzP3oO7VfNNi4fny2ZMCgo+4VMR+Co6G0e' +
  'aa31uWGHu8qmCoW1H+iQ/CjT1/kM30yb/Ej6Fm0tP+RHZv1+2dj8mP65qppMzI+Zu1a5' +
  '4/PeGrYXfTEz9O0MB6B3maDmOq22PjfqcFedH4WBx8zsjPxI7+uchm+WTf5m+leT/eSH' +
  '/MhuwM2NzI9xGxbqmh9TPlX1QjXk6qjB30dFL8hwAP4SVTyr5dbnBh3u6vOjUPjoY52R' +
  'H6l9ndPwzbLJwyelbdK+BfkhPyqw5FuNy4+Xly/UNT+mb1zDOtU/+iZxVnRH4xYZDsA3' +
  'os/S41tvfW7M4a4lPwrz3dQZ+ZHW1zkN30ybfEbKJk0eKT/kR0W+1bD8mLBaoa750fPZ' +
  'WpapwtC7gza/HZ2JKH9P2LvRzZA7teL6/K2Wz4/CwJ93Rn6k9HVewzfLJq+QcpHCWQX5' +
  'IT8qm63PNig/pqxfqG9+7FeozULPlLZ5X1TwlLL9f3VU7epWXNMacrgXrfHIHNcZ+ZHc' +
  '13kN30ybfF3yt3gryQ/5UaF9GpMfvdsV6psfFxRqtdr00lbXCMqtUbb/o8sCFpzZkuvz' +
  'Pm2QH4UfdkR+pN57ms/wzbLJ2yVu05iC/JAfFVpwZkPy4/uplZb64pnXPP7GO93TJrx4' +
  '16Xf/8JHyufHcymnahf64k9veWlS17RxD11x1Hr9k8t9u7TZH0blyt0bPWlIUGm/1lzT' +
  'GnG4a86Pws87Ij8WTL6YLKfhm2WT+yX+4bKd/JAfFRvTiPy4c2BKeBxZclH6axfsPCI1' +
  'P7o3SWxu22vmOMM79tjEW7T63VjSbvgYq0PKdP//Ro3/vUXX5zHtkB/9r++E/Ejs69yG' +
  'b6ZNPjBho57pJz/kx79s9O8zR1Nee+L3J22deOPeYdU0WqEpSycOyuUviJ8Q8s75G6bk' +
  'R+Jjeta6raTs5CMGJSXX9EyfwZYoc1/0ZtHZhRy7s9UPd1pTPVMnvHDnb0/dY43+qUvV' +
  'qJdzmw8t0Nf5Dd8s+TFvwoPmDyjID/mRNF/GHTM4HhUbNyA/Dk8akoOOnpFc654dk/Lj' +
  'raSnv387PGXw12USipc+j/SyqNiNqTv3YvS57QfNWtNa4HBnaurNy/YclrJWbdLVBvlR' +
  'bV/nN3wz/cl0bvwZb175IT9S5ssTi4ejYr78J+E/EuZXYcm/p1d8aNs4Pw5J+Iv+3IR2' +
  'xq2Z8FFsQt+SM+YLiqX/7k701U7/V5q9PjfxcGdtavJ5yyUvVie0T35U3Nf5Dd9M+bF6' +
  '+CbnFOSH/EibL48MD4fFm7lPwh0TBuR6r5etes2KQX6MHVLp164T14hrfKekZHQr4Mhp' +
  'aZu4elBjmxZYn5t2uLM3Net/E3+Dcujzuc+HZvV1nsM3S34Ubglq9a4iP+RH+nwJfyGp' +
  '8FDek/C+hPG49lsZKr975IDPZtuP1O+5nx8VVhlR8izTO6Nil6a0fH9U4TetsD436XBX' +
  '1NS4XZJWq53bKT8q6us8h2+m/Ii69oaC/JAf6YN8fPil5V15T8I94+G4zIRs1f92ZN9I' +
  'iT+0bpT64zjXxhtxdknB6Caq7VMaPig6sTC9Fda0Jh3uCps6Nemynz+3U35U0Nf5Dt8s' +
  '+THgxdJan5Ef8qPcfFm7gm+H6zYJX4mvHxl6f7W7e3HY3uDH02t9Ob4Lq6Tc94JSA8cl' +
  'Nhv+bPrXW2N9bsrhrripKxKuX9qmnfKjgr7Od/iGmzy0z7+PKKn0bP/0GvJDfiQ8X/Om' +
  'nCfh0fHy8KOqd3fTsL2DytR6Lb7c5/a+5cLLqX6c2Gz4d/8drbGmNeVwV97UhQmfdx9p' +
  'p/zI3tf5Dt9wk7fp8yFn1Ixyf0WPlh/yo8QJ0RC8L+dJGD92d93uavd2XHiqYMS4cvXi' +
  '084Hl5TbMii1QWKre0X3tLTImtaUw11FU4fG+fHVdsqPzH2d9/CNNnmH7/b5j4v61Jk6' +
  'f5+AuVF+yI8S4TV6z+Y7CR+IF4e/VL23F4Xt7Ve23mvhPfArlZT7ZVTs6YRGp0UPovhu' +
  'i6xpzTjc1TQ1K3625rCpbZQfmfs67+Eb5scbfa6gX7dPnfP6nuC6Q37IjxLhA5on5jsJ' +
  'jwnny+bV7+3OYYMPl6/4+UKmZHhnRFDq2IQ2fxNdx/98i6xpzTjcVTV1f/wd+hVtlB+Z' +
  '+zrv4RvmR8k1LH2+2V+j7xfs8kN+lDouKLhozpMwvnT9j1XvbFe0vPf5sdhYfA3LWSXl' +
  'vhKUWi6hzU9nzcZmrGnNONzVNfWV8NDs2kb5kbWv8x++YX78rc//7D5HlZv7vPq5ovyQ' +
  'H6W+HhTcMd9J+Fb40bLcI6VSPBROo+Mz1JwR3uS1R0m5W6Jid4ZNjotOKlzUKmtaEw53' +
  'lU09HY6SEe+2T35k7ev8h2+YH8UN5vyfQXPcuvvZkkun5Yf8KLVqUPDEfCfhH8P5cnj1' +
  'OxtfrXNflqo7RTVXLinW+5Gg2P8LW/xxUHL4lFZZ05pwuKttapvwqN7dPvmRta/zH75x' +
  'flzS578+/HyYF/p8pf/RovyQH6VeqmSO1mkSHl/IeIFrVvtE7Y3MdDXXaVHVfqX38P5P' +
  'UCz+MYcNgpJfbpU1rRmHu9qmrqjnNd6t3Nf5D984P2b2eQ784h967HXf699+Jj/kR8ax' +
  'u1rOkzD6gqAwz6zqd3ajqMEtM1W9I1ykSh+Z/UxU7P+i0y7Zb7BowprWjMNdbVOTB9Xx' +
  'C5BW7uv8h2+cHyXXsVz27wrT+zwOeP5p8kN+lBb7W/QY3DMqabSstUqaCR+xul0NOxs+' +
  'CejQTFWnhWfZLywt+PGg2C5Bg8cG5ZbqybM7W/1wV718R3fdFJat33xolb7Of/gm5Mcr' +
  'fb6q2+TfFX7ep/QhRfkhP0pK3R8N3QUn5jsJe8LPlUdUv6/Tw/fN+IOnS0V1gyeF/ywo' +
  'NuTt0nLRrZFHtcia1pTDXX1+HBW1P6CrPfIje183YPgm5Edxtz7/+cC/KvR5Onz/5+SH' +
  '/Og7yF89LLz/6IKcJ+HYsNhvqt/X8JRR4dZslT8V1f1aablJ0eN/zi8pdlfU3JMtsaY1' +
  '6XBXnx9XhW/wfDvkRyV93YDhm5QffSNh9Aflb42uGpMf8uOfet95/cnfnfip+PdCP9Gb' +
  '8yS8PSz29+r39eawwWezVQ5vM4ie07dbpts69qlgoWzUmtbcw119fsQL659bOj+q6OsG' +
  'DN+k/Oj7iMehH/w6Sd/7Em+UH/IjmyVfynsSXh4We6X6ff1N2OCUbJXDBy2tGRQcE13p' +
  '0rezZkVnLc5tzprWIoe7+vyIT+z8shXzo5a+bsDwTcyPvpcO//M3lsf2efzxqr3yQ35k' +
  'ssDjuU/C8HL3/t3V7+v5UYNDMlY+Naq8YlCwe7Gg4Ml9Cv0h2pK3WndNa8Dhrj4/4i+W' +
  'z27X/Ejq6wYM38T8mNGni5d5fxoe2afsT4ryQ35ksfg9+U/C8LFy89Wwr2dHDY7KWPnc' +
  '8JNiVDL6ieq+vxu9a1DmC627pjXicNeQH9Hvdn3wEbn98iOxrxswfBPzo3h4EAgz+vya' +
  '1bxT5If8yGKLNxowCX8YlVq0hn0NP4MtkbFy+NfQglHJR6KSD8xRZHL0Jfu1LbumNeRw' +
  '15Afa0ZvcFx75kdyXzdg+Cbnx4t9TlVtFbR5QFF+yI/yRn6vuxGT8ISo1DI17GvYYNb7' +
  'BH4VVR4WFl0nKHlw2dm8aFeLrmkNOtw15Ed4Y92h7ZgfaX3dgOGbnB8lz/59omSc93ta' +
  'fsiPsgbu80ZjJmFN8yUSPg9luYyVfx1VHhoWjZ7Hvfgc68KWZROmZda0hh3uGvJjw+gN' +
  'Dmu//Ejv6wYM35T86Ptk0H1LcuJfd/bKD/mR6CPHvtCoSRj+vb5YDfv6g7qfAFggLDoh' +
  'uvHxhg8VeCW6bPOhVlzTGni4a8iPj0VvcHy75Ue5vm7A8E3Jj74/pjByct8L1cfID/mR' +
  'rt8B0xo3Cev+/Xn0xNvCQhkrZ//+vPSZ1rPtVSYZ127BNa2hh7uG/FgxeoNT2ys/yvd1' +
  'A4ZvWn70/Z3Bw/vc+bhir/yQH+WM2H9soybhBVGpAdX/+kfJw3pSTkGV+mHW63ff87vo' +
  'zPa09M/LZ7bkZ+IGHu4a8mPe6A3Oabe/P8r1dQOGb1p+9P2d88QBLD/kR4rBJ3U3ZhLG' +
  '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' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAABaxv8HmKwulwplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL0xlbmd0aCAz' +
  'MyA+PgpzdHJlYW0KcSA1NTIgMCAwIDE5MyAzMCA0ODAgY20gL0ltMCBEbyBRCmVuZHN0' +
  'cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1' +
  'IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAow' +
  'MDAwMDAwMjUxIDAwMDAwIG4gCjAwMDAwMTA1ODggMDAwMDAgbiAKdHJhaWxlcgo8PCAv' +
  'U2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgoxMDY3MQolJUVPRgo=';

const SCANNED_PDF_FIXTURE_BASE64 =
  'JVBERi0xLjcKJYGBgYEKCjQgMCBvYmoKPDwKL1R5cGUgL1hPYmplY3QKL1N1YnR5cGUg' +
  'L0ltYWdlCi9CaXRzUGVyQ29tcG9uZW50IDgKL1dpZHRoIDI0MAovSGVpZ2h0IDE0MAov' +
  'Q29sb3JTcGFjZSAvRGV2aWNlUkdCCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGgg' +
  'MjIyCj4+CnN0cmVhbQp4nO3cQQ0AIBDAMCv4NwlPFJAjS6th7+0NAAAAAAAAAAAAAAAA' +
  'AHAteEDPlOiZEj1TomdK9EyJninRMyV6pkTPlOiZEj1TomdK9EzJVM8AAAAAAAAAAAAA' +
  'AAAAAAAAAAC/mf5C0aRnSvRMiZ4p0TMleqZEz5TomRI9U6JnSvRMiZ4p0TMleqZkqmcA' +
  'AAAAAAAAAAAAAAAAAAAAAIDfTH+haNIzJXqmRM+U6JkSPVOiZ0r0TImeKdEzJXqmRM+U' +
  '6JkSPVMy1TMAAAAAAAAAAAAAAAAAAAAAAMALB8KyiJ8KZW5kc3RyZWFtCmVuZG9iagoK' +
  'NiAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDUzCj4+CnN0cmVh' +
  'bQp4nCvkMlQwAEIImZyLzjUzNAIzzS2NcKjQ98xNTE/VNTewtDCxMDC3sFRwyecK5AIA' +
  '+w8R2AplbmRzdHJlYW0KZW5kb2JqCgo3IDAgb2JqCjw8Ci9GaWx0ZXIgL0ZsYXRlRGVj' +
  'b2RlCi9UeXBlIC9PYmpTdG0KL04gNAovRmlyc3QgMjAKL0xlbmd0aCAzMTkKPj4Kc3Ry' +
  'ZWFtCnic1VJRS8MwEH7Pr7hHfZBc0zRppQzm2orIcEwfRPGhrmFMtJEug/nvvWs2xQfx' +
  'WcpHcrnvy116XwIICrSGFGwOGWSpgrIU8u7j3YFctGu3FfJ6023hkbIIS3gScuZ3fYBE' +
  'TCbimztrQ/vq1yKKIGHykbEYfLdbuQHKpm4aRIuIRhMMoqponREKgqKYciqnPcHqA+jM' +
  'pojplHJNhLFRw/mRmx30Na3ENcypIlfnMf6qy7XqeIf6q59iIuTcd1UbHJxU5wqVwRyT' +
  'pNCZTh9O6XcMrg3+/z5u7H/j+19f+GPOPF4e8uDYA+OU5dJt/W5Y0diZ13jK0IZk8v7m' +
  '+cWtxlBevZH0zGKRU8s2L0AfPSLrfbi8DVw/6vhs7rpNe+H35DykzyQKbKHYf9O+94Ed' +
  'OXqxD9QJR+bgTxJ/Ai/QqG0KZW5kc3RyZWFtCmVuZG9iagoKOCAwIG9iago8PAovU2l6' +
  'ZSA5Ci9Sb290IDIgMCBSCi9JbmZvIDMgMCBSCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9U' +
  'eXBlIC9YUmVmCi9MZW5ndGggNDIKL1cgWyAxIDIgMiBdCi9JbmRleCBbIDAgOSBdCj4+' +
  'CnN0cmVhbQp4nGNgYPj/n4mBnYEBRDCCCCZGBgEIl5mRcQYDUFAUSDDvYmAAAGPrA6oK' +
  'ZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVmCjk1NAolJUVPRg==';

// Hybrid fixture (class C) — page 1 carries a real text layer, page 2 is an
// image-only raster with no text operators. The extractor reads page 1 through
// the text layer and routes page 2 to OCR, so one document exercises both
// halves of hybrid routing end to end. Unit tests pin the assembly against a
// mocked recognizer (`content/src/__tests__/pdf-ocr.test.ts`); this fixture is
// what carries class C through the live stack instead.
//
// The raster is dark bars, NOT rendered glyphs, on purpose: a synthetic bitmap
// is not a typeface and the recognizer misreads it (measured: 'SCANNED' ->
// 'SCHMNE' at confidence 0), so any assertion on recovered text would pin
// engine noise. Page 2 therefore lands on the gap-reporting branch and comes
// back in `unreadPages` — the honest outcome, and the one a real scan with an
// unreadable page takes too.
//
// Generated with pdf-lib + a minimal zlib PNG encoder; 1694 bytes. Regenerate
// by drawing the five lines below on a 612x792 page and embedding a 240x140
// RGB PNG of three dark bars over a second page of the same size.
const HYBRID_PDF_FIXTURE_BASE64 =
  'JVBERi0xLjcKJYGBgYEKCjYgMCBvYmoKPDwKL0ZpbHRlciAvRmxhdGVEZWNvZGUKL0xl' +
  'bmd0aCAzMzIKPj4Kc3RyZWFtCnicjVLBSsVADLzvV/QsiGk2O9kF8fBqiwcvQn9AREXR' +
  'wxPx+53dfdDn4clj2xKyyWRm0n3YrUGGer5ew9Xd88fP8/fb0+OlS8mWxXMZRh3Wl6A2' +
  'rPdhbKXj4MpHhvUzXFv2AnVFgamkiFss2CExFjPDzbC+h/UizGt4CPtT84qbImtCPjlP' +
  '+rzz8FREsqSScQoPueMlQ0bxqOKCEV6ZI2L0rinVG4x8eYPZE3NzrXHjXSZtwcTqWqk6' +
  'q1hkndX+WkOMdMBwxgs/4pEdjDB5YZ5453pER8EWP6kJXRM4t2Jz0kL8Saeqgbyt8c7k' +
  'VBo/MiITa/wy42mrYEZbz067L2Nl6rEq5leaOzOoB6h6eOyQOVOP07EUI/7ZkR3tqO9l' +
  '8boF6+oqgoP+lur5xrz/jYddkpNKHGPm8c2HTVOL0fapRxjedvhXyy+S8LCRCmVuZHN0' +
  'cmVhbQplbmRvYmoKCjcgMCBvYmoKPDwKL1R5cGUgL1hPYmplY3QKL1N1YnR5cGUgL0lt' +
  'YWdlCi9CaXRzUGVyQ29tcG9uZW50IDgKL1dpZHRoIDI0MAovSGVpZ2h0IDE0MAovQ29s' +
  'b3JTcGFjZSAvRGV2aWNlUkdCCi9GaWx0ZXIgL0ZsYXRlRGVjb2RlCi9MZW5ndGggMjIy' +
  'Cj4+CnN0cmVhbQp4nO3cQQ0AIBDAMCv4NwlPFJAjS6th7+0NAAAAAAAAAAAAAAAAAHAt' +
  'eEDPlOiZEj1TomdK9EyJninRMyV6pkTPlOiZEj1TomdK9EzJVM8AAAAAAAAAAAAAAAAA' +
  'AAAAAAC/mf5C0aRnSvRMiZ4p0TMleqZEz5TomRI9U6JnSvRMiZ4p0TMleqZkqmcAAAAA' +
  'AAAAAAAAAAAAAAAAAIDfTH+haNIzJXqmRM+U6JkSPVOiZ0r0TImeKdEzJXqmRM+U6JkS' +
  'PVMy1TMAAAAAAAAAAAAAAAAAAAAAAMALB8KyiJ8KZW5kc3RyZWFtCmVuZG9iagoKOSAw' +
  'IG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29kZQovTGVuZ3RoIDUzCj4+CnN0cmVhbQp4' +
  'nCvkMlQwAEIImZyLzjUzNAIzzS2NcKjQ98xNTE/VtTAxNTC0MDA0MFdwyecK5AIA+hMR' +
  'vgplbmRzdHJlYW0KZW5kb2JqCgoxMCAwIG9iago8PAovRmlsdGVyIC9GbGF0ZURlY29k' +
  'ZQovVHlwZSAvT2JqU3RtCi9OIDYKL0ZpcnN0IDMyCi9MZW5ndGggNDM0Cj4+CnN0cmVh' +
  'bQp4nNVT32vcMAx+91+hx+2hWHH8sxwH17tkG6OstIWNjT2kiTlSWnskvtH995OT6x1t' +
  'NwZjLyMotqTvkyVbKgBBgEIowUqQoEoLCrRAsOCKAhYLxq9/fPPAL5qtHxl/33cjfCEM' +
  'wiVh8v8r4+u4CwkEWy7ZkbFuUnMXt2ymQpHBj4iLIXa71g+wqKu6RjSIqCWJRhQbWtck' +
  'jkSQTj5haU9i5F7IZkrEckW+ehZtZk72T1i151e0ElZnzGbGSjvrh3PzWdUcQ/wpH7dk' +
  '/Dx2myZ5eLU5FSg0WtQopJbu82u6jsE3Kf6/xU359zH8tsIn71zHkBi/2t2kSc3GgvGz' +
  'ZvTZA/ytv/vuU982jFehjV0ftsA/9mEVxv7R8DRibpjcNoMn/tw3/NKPcTe01EgZN0XO' +
  'm0PwE4POUuXGOurjiXL0OSOFtkJp+9KXX8Ciclb/iqdQaifQvPQZZYQqS33gUQn804eb' +
  'W99OqWW1ekhvrlK+xdmQbee+65uz+EBThPTpQoBxIk/RKoSY8nRNExUSVZ81vZ+yv7yi' +
  'Z2nxd/dEPbFSYWGxoMrMIft/kq47pvsTMd4S+AplbmRzdHJlYW0KZW5kb2JqCgoxMSAw' +
  'IG9iago8PAovU2l6ZSAxMgovUm9vdCAyIDAgUgovSW5mbyAzIDAgUgovRmlsdGVyIC9G' +
  'bGF0ZURlY29kZQovVHlwZSAvWFJlZgovTGVuZ3RoIDUyCi9XIFsgMSAyIDIgXQovSW5k' +
  'ZXggWyAwIDEyIF0KPj4Kc3RyZWFtCnicY2Bg+P+fiYGLgQFEMIIIJhDBDCJYGBkEGBgY' +
  'GZdCZFkZmXWBXOZVQIL1MAMDAJjCBLYKZW5kc3RyZWFtCmVuZG9iagoKc3RhcnR4cmVm' +
  'CjE0NzUKJSVFT0Y=';

// last in Discover (see the module doc); the text specs' `.first()` card
// stays a text resource.
const SEED_RESOURCES: readonly SeedSpec[] = [
  {
    name: 'Spatial Smoke PDF',
    storageUri: 'file://e2e/seed-spatial.pdf',
    format: 'application/pdf',
    language: 'en',
    bytes: Buffer.from(PDF_FIXTURE_BASE64, 'base64'),
  },
  {
    name: 'Cellular Respiration PDF',
    storageUri: 'file://e2e/seed-cellular.pdf',
    format: 'application/pdf',
    language: 'en',
    bytes: Buffer.from(TEXT_PDF_FIXTURE_BASE64, 'base64'),
  },
  {
    name: 'Scanned Smoke PDF',
    storageUri: 'file://e2e/seed-scanned.pdf',
    format: 'application/pdf',
    language: 'en',
    bytes: Buffer.from(SCANNED_PDF_FIXTURE_BASE64, 'base64'),
  },
  {
    // The readable counterpart to the smoke scan — see the fixture's own note.
    name: 'Legible Scan PDF',
    storageUri: 'file://e2e/seed-legible-scan.pdf',
    format: 'application/pdf',
    language: 'en',
    bytes: Buffer.from(LEGIBLE_SCAN_PDF_FIXTURE_BASE64, 'base64'),
  },
  {
    name: 'Hybrid Smoke PDF',
    storageUri: 'file://e2e/seed-hybrid.pdf',
    format: 'application/pdf',
    language: 'en',
    bytes: Buffer.from(HYBRID_PDF_FIXTURE_BASE64, 'base64'),
  },
  {
    name: 'Quantum Computing Primer',
    storageUri: 'file://e2e/seed-1.txt',
    format: 'text/plain',
    language: 'en',
    bytes: Buffer.from(
      'Quantum computing is a model of computation that uses quantum-mechanical ' +
      'phenomena, such as superposition and entanglement, to perform operations on ' +
      'data. Where a classical bit is either zero or one, a qubit can be a ' +
      'superposition of both states until measured.\n\n' +
      'A qubit is the quantum analogue of a bit. Its state is described by a ' +
      'two-dimensional complex vector. Measurement collapses the qubit to one of ' +
      'the two basis states with probabilities determined by the squared magnitudes ' +
      'of the amplitudes.\n\n' +
      'When two or more qubits become entangled, their joint state cannot be ' +
      'expressed as a product of individual qubit states. Operations on one ' +
      'entangled qubit instantaneously affect the others, regardless of distance.\n',
      'utf-8',
    ),
  },
  {
    name: 'Photosynthesis Overview',
    storageUri: 'file://e2e/seed-2.txt',
    format: 'text/plain',
    language: 'en',
    bytes: Buffer.from(
      'Photosynthesis is the process by which plants, algae, and certain bacteria ' +
      'convert light energy into chemical energy stored in glucose. The overall ' +
      'reaction transforms carbon dioxide and water into sugar and oxygen, using ' +
      'sunlight as the energy input.\n\n' +
      'The light-dependent reactions occur in the thylakoid membranes of ' +
      'chloroplasts. Chlorophyll absorbs photons and transfers electrons through a ' +
      'chain of carriers, generating ATP and NADPH while splitting water molecules ' +
      'and releasing oxygen as a byproduct.\n\n' +
      'The light-independent reactions, known as the Calvin cycle, take place in ' +
      'the chloroplast stroma. The enzyme RuBisCO fixes carbon dioxide onto a ' +
      'five-carbon sugar, and a series of reductions powered by ATP and NADPH ' +
      'produce glucose and other organic molecules.\n',
      'utf-8',
    ),
  },
];

export interface SeedOptions {
  /** Gateway URL — the same value the suite passes as `E2E_GATEWAY_URL`. */
  gatewayUrl: string;
  /** Admin email — same as `E2E_EMAIL`. */
  email: string;
  /** Admin password — same as `E2E_PASSWORD`. */
  password: string;
  /** Optional logger; defaults to `console.log`. */
  log?: (msg: string) => void;
}

/**
 * Idempotently seed the KB. Returns the count of resources created
 * (excluding ones that already existed).
 *
 * The "already exists" path returns success — the suite only cares
 * that the seed resources are present, not that this run created them.
 */
export async function seedKb(opts: SeedOptions): Promise<{ created: number; existed: number }> {
  const log = opts.log ?? ((m: string) => { console.log(m); });
  log(`[seed] gateway=${opts.gatewayUrl} user=${opts.email}`);

  const session = await sessionFor({
    baseUrl: opts.gatewayUrl,
    email: opts.email,
    password: opts.password,
  });
  const client = session.client;

  let created = 0;
  let existed = 0;
  try {
    // Which seeds are already here. Asked ONCE, up front, rather than relying on
    // the create failing.
    //
    // This used to lean on the gateway rejecting a duplicate `storageUri` and
    // catching that below. Nothing enforces `storageUri` uniqueness — not the
    // gateway, not make-meaning — so the create always succeeded, the catch never
    // fired, and every run logged "N created, 0 already present" no matter how
    // many times it had run before. Any KB grew by the full seed set per run; a
    // blank template degraded exactly as fast as a used one, just from a lower
    // starting point. Measured 2026-08-06 at eleven copies of each seed.
    //
    // That is not merely untidy. Discover's landing list is capped
    // (`RECENT_LIMIT = 10`, newest-first), so accumulated seeds push each other
    // out of it, and specs that open a resource by name start failing at the card
    // — a failure that reads as a regression in whatever they were testing.
    //
    // `.fresh()` because `browse.resources()` is a CacheObservable and this is a
    // one-shot read (CACHE-CONTRACT D2). The limit is generous on purpose: a
    // short page would report a present seed as missing and re-create it, which
    // is the bug this replaces.
    const present = new Set<string>();
    for (const r of (await client.browse.resources({ limit: 500, archived: false }).fresh()).resources) {
      const uri = getStorageUri(r);
      if (uri) present.add(uri);
    }

    for (const spec of SEED_RESOURCES) {
      if (present.has(spec.storageUri)) {
        log(`[seed] · already   ${spec.storageUri}`);
        existed++;
        continue;
      }
      // `client.yield.resource(...)` returns an UploadObservable that
      // resolves to `{ resourceId }` on success. Errors come through
      // as observable errors — typically APIError with the gateway's
      // status + code. The duplicate branch below is a BACKSTOP for a
      // race (two seeders at once); the pre-check above is what actually
      // makes re-runs idempotent. It is deliberately kept rather than
      // deleted: if uniqueness is ever enforced, this is where it lands.
      try {
        // Awaiting the UploadObservable yields the awaitable shape
        // (`{ resourceId }`) directly — same as every other production
        // caller. The Observable surface (subscribe → progress events)
        // is for callers that want to render an upload progress bar;
        // the seed script doesn't.
        const result = await client.yield.resource({
          name: spec.name,
          storageUri: spec.storageUri,
          file: spec.bytes,
          format: spec.format,
          language: spec.language,
        });
        log(`[seed] ✓ created  ${spec.storageUri}  → ${result.resourceId}`);
        created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lower = msg.toLowerCase();
        if (lower.includes('already') || lower.includes('exists') || lower.includes('duplicate')) {
          log(`[seed] · already   ${spec.storageUri}`);
          existed++;
        } else {
          throw new Error(`seed failed for ${spec.storageUri}: ${msg}`);
        }
      }
    }
  } finally {
    await session.dispose();
  }

  log(`[seed] done — ${created} created, ${existed} already present`);
  return { created, existed };
}

/**
 * Default export shaped for Playwright's `globalSetup` config option:
 * a function that takes the resolved `FullConfig` and returns a
 * promise. Reads the same env vars the suite uses (`E2E_GATEWAY_URL`,
 * `E2E_EMAIL`, `E2E_PASSWORD`).
 */
export default async function globalSetup(): Promise<void> {
  const gatewayUrl = process.env.E2E_GATEWAY_URL ?? 'http://localhost:4000';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  if (!email || !password) {
    // The config's `requireEnv` already gates these, but leave a clean
    // diagnostic in case this runs outside the Playwright runner.
    throw new Error('seed: E2E_EMAIL and E2E_PASSWORD must be set');
  }

  await seedKb({ gatewayUrl, email, password });
}
