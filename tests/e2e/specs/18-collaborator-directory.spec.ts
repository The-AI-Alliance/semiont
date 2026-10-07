import { test, expect } from '@playwright/test';
import { MARK_MOTIVATIONS, type CollaboratorEntry, type JobFilter } from '@semiont/core';
import { signInSession } from '../fixtures/sdk-session';

/**
 * Smoke test: the KB's software collaborator directory, `browse.agents()`,
 * against a live stack — plus the attribution loop (the directory and
 * work-stamped `generator` DIDs describe the same population).
 *
 * Pure **SDK round-trip** (no browser), per the spec-15 pattern: the consumer
 * is chat's delegation chooser, an SDK caller.
 *
 * What it pins (software half only — Persons in the directory are DEFERRED;
 * extend here when they land):
 *
 * 1. **Stack freshness gate.** `browse.agents()` must answer AT ALL. A stack
 *    predating the `browse:agents-*` channels rejects the emit with "Unknown
 *    channel: browse:agents-requested" — an environment verdict, not a feature
 *    verdict; the distinctive error below says "rebuild the stack", not "the
 *    feature is broken".
 * 2. **Roster shape.** Every entry is a Software agent with structured
 *    `provider`/`model` and a DID minted as
 *    `did:web:<host>:agents:<provider>:<model>` (URI-encoded components,
 *    `did-utils.ts`) — self-consistent per entry, one host across the roster
 *    (one KB, one domain).
 * 3. **Capabilities are the routing function.** Each job a claim can name
 *    (a `mark` job of each motivation, and a `yield` job) appears in EXACTLY
 *    one entry's `serves` (the config maps each to one `(provider, model)`;
 *    the roster dedups by that pair), each named as a claim names it.
 *    Entries without `serves` (actors-only agents) are legal.
 * 4. **No secret material.** The reply carries no `apiKey`/endpoint config.
 * 5. **The attribution loop.** After a real assist pass, the `generator` DID
 *    stamped on the created annotations is an element of the directory —
 *    declared roster ⊇ actual workers. A generator absent from the directory
 *    is the declared-vs-actual discrepancy this check exists to surface.
 *
 * Auth note: the e2e harness's only user is the seeded admin. The load-bearing
 * property is that the channel needs no ADMIN gate (the Browser's bus handlers
 * consult no roles — nothing admin-shaped exists on this path), so the admin
 * session exercises exactly what a non-admin one would. A true non-admin
 * session becomes worth wiring when the directory adds Persons (whose
 * assertion is "minimal subset, no admin-only fields").
 *
 * Self-seeding: creates its own resource for the assist pass. Slow: the
 * attribution leg waits on a real LLM highlight pass (spec-06/11 class).
 */

/** A job as a claim names it, in words: `mark.<motivation>`, or `yield`. */
const named = (filter: JobFilter): string =>
  filter.jobType === 'mark' ? `mark.${filter.params.motivation}` : filter.jobType;

/** Every job a claim can name: a `mark` job of each motivation, and a `yield` job. */
const JOBS = [...MARK_MOTIVATIONS.map((motivation) => `mark.${motivation}`), 'yield'];

// Host may be `host` or `host:port` (the KB's domain is embedded raw; the
// read-side `didToAgent` deliberately scans from the RIGHT so host:port
// colons don't fool it — did-utils.ts). Anchor on `:agents:` like the
// parser does; group 1 is the whole host (incl. any port).
const DID_RE = /^did:web:(.+):agents:([^:]+):([^:]+)$/;

test.describe('collaborator directory (browse.agents)', () => {
  test('directory lists the TOML software roster and attribution DIDs are members', async () => {
    test.setTimeout(120_000);

    const session = await signInSession();

    const client = session.client;

    try {
      // ── 1. Freshness gate: the channel must exist on the running stack ──
      let entries: CollaboratorEntry[];
      try {
        // `.fresh()` is the explicit one-shot read: a CacheObservable is not awaitable.
        entries = await client.browse.agents().fresh();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(
          `STACK FRESHNESS GATE: browse.agents() did not answer (${msg}). ` +
            `If this is "Unknown channel: browse:agents-requested", the running stack ` +
            `predates the browse:agents-* channels — rebuild/redeploy before judging the directory.`,
        );
      }

      // ── 2. Roster shape ──
      expect(entries.length, 'KB TOML declares workers/actors → roster is non-empty').toBeGreaterThan(0);

      const didHosts = new Set<string>();
      const didSet = new Set<string>();
      for (const entry of entries) {
        const agent = entry.agent;
        expect(agent['@type'], 'v1 roster is software-only (Persons deferred)').toBe('Software');
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
      const jobOwners = new Map<string, number>();
      for (const entry of entries) {
        for (const filter of entry.serves ?? []) {
          const job = named(filter);
          expect(JOBS, `"${job}" is a job a claim can name`).toContain(job);
          jobOwners.set(job, (jobOwners.get(job) ?? 0) + 1);
        }
      }
      for (const job of JOBS) {
        expect(
          jobOwners.get(job) ?? 0,
          `"${job}" routes to exactly one agent (the config's resolution is a function; roster dedups)`,
        ).toBe(1);
      }

      // ── 4. No secret material on the wire ──
      const raw = JSON.stringify(entries);
      expect(raw.includes('apiKey'), 'reply must not leak inference config secrets').toBe(false);

      // ── 5. Attribution loop: a real worker's generator DID ∈ directory ──
      const rid = (
        await client.yield.resource({
          name: 'Directory Attribution',
          storageUri: 'file://e2e/directory-attribution.txt',
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

      const done = await client.mark.delegate(rid, { motivation: 'highlighting', sourceLanguage: 'en' });
      // Awaited, a delegation resolves on the job's completion. A mark job's
      // result is its counts or a decline; the counts say it did its work.
      expect(done.result !== undefined && 'found' in done.result, 'the highlighting job reports its counts').toBe(true);

      // The worker stamps `generator` (single or pipeline array) on what it
      // created. Poll for projection delivery, then assert membership.
      await expect
        .poll(
          async () =>
            (await client.browse.annotations(rid).fresh()).some((a) => a.generator !== undefined),
          { timeout: 30_000 },
        )
        .toBe(true);

      const generated = (await client.browse.annotations(rid).fresh()).filter((a) => a.generator !== undefined);
      expect(generated.length, 'assist pass produced ≥1 generator-stamped annotation').toBeGreaterThan(0);

      for (const ann of generated) {
        const generators = Array.isArray(ann.generator) ? ann.generator : [ann.generator!];
        for (const gen of generators) {
          expect(gen['@id'], 'generator carries a DID').toBeTruthy();
          expect(
            didSet.has(gen['@id']!),
            `generator ${gen['@id']} is a member of browse.agents() — a miss is a ` +
              `declared-vs-actual roster discrepancy`,
          ).toBe(true);
        }
      }
    } finally {
      await session.dispose();
    }
  });
});
