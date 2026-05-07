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
  format: 'text/plain';
  language: string;
  content: string;
}

// Two short documents in `text/plain` (NOT `text/markdown`). The
// markdown MIME type triggers ReactMarkdown rendering in BrowseView,
// which strips header syntax (`#`, `**`, etc.) from the rendered DOM.
// Annotations placed on those source-only characters can't be resolved
// to rendered positions, and the in-content overlay silently skips
// them — meaning the annotation persists but never renders an
// `[data-annotation-id]` span. Plain text has a 1:1 source↔rendered
// offset mapping, so any selection round-trips and renders.
//
// Each document has multiple paragraphs so the manual-highlight /
// manual-reference / comment / hover-beckon specs have text to select.
// Names + storageUris are stable so a re-run sees the same KB shape.
const SEED_RESOURCES: readonly SeedSpec[] = [
  {
    name: 'Quantum Computing Primer',
    storageUri: 'file://e2e/seed-1.txt',
    format: 'text/plain',
    language: 'en',
    content:
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
  },
  {
    name: 'Photosynthesis Overview',
    storageUri: 'file://e2e/seed-2.txt',
    format: 'text/plain',
    language: 'en',
    content:
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
 * that ≥2 seed resources are present, not that this run created them.
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
          file: Buffer.from(spec.content, 'utf-8'),
          format: spec.format,
          language: spec.language,
          creationMethod: 'api',
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
