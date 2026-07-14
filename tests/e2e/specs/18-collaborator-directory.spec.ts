import { test, expect } from '@playwright/test';
import { SemiontClient } from '@semiont/sdk';
import type { CollaboratorEntry } from '@semiont/core';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Smoke test — COLLABORATOR-DIRECTORY.md Phase 5 (verify): the KB's software
 * collaborator directory, `browse.agents()`, against a live stack — plus the
 * attribution loop (the directory and work-stamped `generator` DIDs describe
 * the same population).
 *
 * Pure **SDK round-trip** (no browser), per the spec-15 pattern: the consumer
 * is chat's delegation chooser, an SDK caller.
 *
 * What P5 pins (software half only — P4 Persons is DEFERRED; extend here when
 * it lands):
 *
 * 1. **Stack freshness gate.** `browse.agents()` must answer AT ALL. A stack
 *    predating P1–P3 rejects the emit with "Unknown channel:
 *    browse:agents-requested" — an environment verdict, not a feature verdict;
 *    the distinctive error below says "rebuild the stack", not "the feature is
 *    broken".
 * 2. **Roster shape.** Every entry is a Software agent with structured
 *    `provider`/`model` and a DID minted as
 *    `did:web:<host>:agents:<provider>:<model>` (URI-encoded components,
 *    `did-utils.ts`) — self-consistent per entry, one host across the roster
 *    (one KB, one domain).
 * 3. **Capabilities are the routing function.** Each of the six concrete
 *    JobTypes appears in EXACTLY one entry's `servesJobTypes`
 *    (`resolveWorkerInference` maps each job type to one `(provider, model)`;
 *    the roster dedups by that pair) — and the literal `'default'` never
 *    appears (it expands, per D3/P2). Entries without `servesJobTypes`
 *    (actors-only agents) are legal.
 * 4. **No secret material.** The reply carries no `apiKey`/endpoint config.
 * 5. **The attribution loop (D3's feature).** After a real assist pass, the
 *    `generator` DID stamped on the created annotations is an element of the
 *    directory — declared roster ⊇ actual workers. A generator absent from
 *    the directory is the declared-vs-actual discrepancy this check exists to
 *    surface.
 *
 * Auth note: the e2e harness's only user is the seeded admin. The load-bearing
 * property is that the channel needs no ADMIN gate (the Browser's bus handlers
 * consult no roles — nothing admin-shaped exists on this path), so the admin
 * session exercises exactly what a non-admin one would. A true non-admin
 * session becomes worth wiring when P4 adds Persons (whose assertion is
 * "minimal subset, no admin-only fields").
 *
 * Self-seeding: creates its own resource for the assist pass. Slow: the
 * attribution leg waits on a real LLM highlight pass (spec-06/11 class).
 */

/** The six concrete job types (JobType enum, specs/src/components/schemas/JobType.json). */
const JOB_TYPES = [
  'reference-annotation',
  'generation',
  'highlight-annotation',
  'assessment-annotation',
  'comment-annotation',
  'tag-annotation',
] as const;

// Host may be `host` or `host:port` (site.domain is embedded raw; the
// read-side `didToAgent` deliberately scans from the RIGHT so host:port
// colons don't fool it — did-utils.ts). Anchor on `:agents:` like the
// parser does; group 1 is the whole host (incl. any port).
const DID_RE = /^did:web:(.+):agents:([^:]+):([^:]+)$/;

test.describe('collaborator directory (browse.agents)', () => {
  test('directory lists the TOML software roster and attribution DIDs are members', async () => {
    test.setTimeout(120_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      // ── 1. Freshness gate: the channel must exist on the running stack ──
      let entries: CollaboratorEntry[];
      try {
        entries = await client.browse.agents();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `STACK FRESHNESS GATE: browse.agents() did not answer (${msg}). ` +
            `If this is "Unknown channel: browse:agents-requested", the running stack ` +
            `predates the P1–P3 series — rebuild/redeploy before judging P5. ` +
            `(COLLABORATOR-DIRECTORY.md P5 gate.)`,
        );
      }

      // ── 2. Roster shape ──
      expect(entries.length, 'KB TOML declares workers/actors → roster is non-empty').toBeGreaterThan(0);

      const didHosts = new Set<string>();
      const didSet = new Set<string>();
      for (const entry of entries) {
        const agent = entry.agent;
        expect(agent['@type'], 'v1 roster is software-only (P4 Persons deferred)').toBe('Software');
        expect(agent.provider, 'structured provider').toBeTruthy();
        expect(agent.model, 'structured model').toBeTruthy();

        const did = agent['@id'];
        expect(did, 'roster entries carry a DID').toBeTruthy();
        const m = DID_RE.exec(did!);
        expect(m, `DID shape did:web:<host>:agents:<provider>:<model> — got "${did}"`).toBeTruthy();
        // Self-consistency: the DID's provider/model segments ARE the structured
        // fields (softwareToAgent mints both from the same (provider, model)).
        expect(decodeURIComponent(m![2]!)).toBe(agent.provider);
        expect(decodeURIComponent(m![3]!)).toBe(agent.model);
        didHosts.add(m![1]!);
        didSet.add(did!);
      }
      expect(didHosts.size, `one KB, one DID host — got ${[...didHosts].join(', ')}`).toBe(1);
      expect(didSet.size, 'roster is deduplicated by (provider, model) → DIDs unique').toBe(entries.length);

      // ── 3. Capabilities = the routing function ──
      const jobTypeOwners = new Map<string, number>();
      for (const entry of entries) {
        for (const jt of entry.servesJobTypes ?? []) {
          expect(jt, `'default' expands via resolveWorkerInference — never a literal capability`).not.toBe('default');
          expect(JOB_TYPES as readonly string[], `"${jt}" is a concrete JobType`).toContain(jt);
          jobTypeOwners.set(jt, (jobTypeOwners.get(jt) ?? 0) + 1);
        }
      }
      for (const jt of JOB_TYPES) {
        expect(
          jobTypeOwners.get(jt) ?? 0,
          `job type "${jt}" routes to exactly one agent (resolver is a function; roster dedups)`,
        ).toBe(1);
      }

      // ── 4. No secret material on the wire ──
      const raw = JSON.stringify(entries);
      expect(raw.includes('apiKey'), 'reply must not leak inference config secrets').toBe(false);

      // ── 5. Attribution loop: a real worker's generator DID ∈ directory ──
      const rid = (
        await client.yield.resource({
          name: 'P5 Directory Attribution',
          storageUri: 'file://e2e/p5-directory-attribution.txt',
          file: Buffer.from(
            'Photosynthesis converts sunlight into chemical energy. ' +
              'The Calvin cycle fixes carbon dioxide into glucose. ' +
              'Chlorophyll absorbs red and blue light most strongly.',
            'utf-8',
          ),
          format: 'text/plain',
          language: 'en',
        })
      ).resourceId;

      const finalEvent = await client.mark.assist(rid, 'highlighting', { language: 'en' });
      expect(
        finalEvent.kind,
        'highlight assist completes (highlight-annotation job → job:complete)',
      ).toBe('complete');

      // The worker stamps `generator` (single or pipeline array) on what it
      // created. Poll for projection delivery, then assert membership.
      await expect
        .poll(
          async () =>
            (await client.browse.annotations(rid)).some((a) => a.generator !== undefined),
          { timeout: 30_000 },
        )
        .toBe(true);

      const generated = (await client.browse.annotations(rid)).filter((a) => a.generator !== undefined);
      expect(generated.length, 'assist pass produced ≥1 generator-stamped annotation').toBeGreaterThan(0);

      for (const ann of generated) {
        const generators = Array.isArray(ann.generator) ? ann.generator : [ann.generator!];
        for (const gen of generators) {
          expect(gen['@id'], 'generator carries a DID').toBeTruthy();
          expect(
            didSet.has(gen['@id']!),
            `generator ${gen['@id']} is a member of browse.agents() — a miss is a ` +
              `declared-vs-actual roster discrepancy (COLLABORATOR-DIRECTORY.md D3/P5)`,
          ).toBe(true);
        }
      }
    } finally {
      client.dispose();
    }
  });
});
