/**
 * Seed the e2e KB with the minimum fixture set the spec suite assumes.
 *
 * The Playwright suite documents (in ``tests/e2e/README.md``) that it
 * "assumes the target KB has ≥2 resources and ≥1 entity type." Entity
 * types are auto-bootstrapped on backend startup
 * (`packages/make-meaning/src/bootstrap/entity-types.ts`); resources are
 * not. A freshly-rebuilt template KB starts empty, which makes specs
 * 02-09 fail at the very first "open resource:" assertion.
 *
 * Seeds two `text/plain` resources (for the text-annotation specs) plus
 * two `application/pdf` resources: a 3-word render smoke fixture (for
 * `14-pdf-render.spec.ts`, the PDFJS-6-UNIFY browser smoke) and a
 * text-layer fixture with a Concept-dense paragraph (for
 * `20-pdf-assisted-detection.spec.ts`, AI detection on a PDF). Both PDFs are
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
  /** Backend URL — the same value the suite passes as `E2E_BACKEND_URL`. */
  backendUrl: string;
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
  log(`[seed] backend=${opts.backendUrl} user=${opts.email}`);

  const client = await SemiontClient.signInHttp({
    baseUrl: opts.backendUrl,
    email: opts.email,
    password: opts.password,
  });

  let created = 0;
  let existed = 0;
  try {
    for (const spec of SEED_RESOURCES) {
      // `client.yield.resource(...)` returns an UploadObservable that
      // resolves to `{ resourceId }` on success. Errors come through
      // as observable errors — typically APIError with the backend's
      // status + code. We treat duplicate-storageUri rejections as a
      // no-op so re-runs are safe.
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
    client.dispose();
  }

  log(`[seed] done — ${created} created, ${existed} already present`);
  return { created, existed };
}

/**
 * Default export shaped for Playwright's `globalSetup` config option:
 * a function that takes the resolved `FullConfig` and returns a
 * promise. Reads the same env vars the suite uses (`E2E_BACKEND_URL`,
 * `E2E_EMAIL`, `E2E_PASSWORD`).
 */
export default async function globalSetup(): Promise<void> {
  const backendUrl = process.env.E2E_BACKEND_URL ?? 'http://localhost:4000';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;

  if (!email || !password) {
    // The config's `requireEnv` already gates these, but leave a clean
    // diagnostic in case this runs outside the Playwright runner.
    throw new Error('seed: E2E_EMAIL and E2E_PASSWORD must be set');
  }

  await seedKb({ backendUrl, email, password });
}
