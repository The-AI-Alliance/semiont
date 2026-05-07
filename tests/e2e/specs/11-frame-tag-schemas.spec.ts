import { test, expect } from '../fixtures/auth';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';
import { SemiontClient, resourceId as ridBrand, type TagSchema } from '@semiont/sdk';

/**
 * Smoke test: the Frame flow's tag-schema runtime registry surface
 * end-to-end. Exercises the architecture put in place by the
 * TAG-SCHEMAS-GAP work — schemas are now per-KB runtime-registered
 * (no build-time `TAG_SCHEMAS` constant); the `mark.assist` dispatcher
 * resolves `schemaId` against the projection at job-creation time and
 * embeds the full `TagSchema` in the worker's params.
 *
 * Four things are exercised end-to-end:
 *
 * 1. **Registration round-trip.** `client.frame.addTagSchema(SCHEMA)`
 *    emits `frame:add-tag-schema`; the backend's Stower persists a
 *    `frame:tag-schema-added` domain event on the `__system__` stream
 *    and broadcasts it (a bridged channel — see
 *    `packages/core/src/bridged-channels.ts`). The signed-in test
 *    page's bus capture must observe the broadcast via SSE.
 *
 * 2. **Projection visibility.** After registration, the schema must
 *    appear in `client.browse.tagSchemas()` — proves the
 *    ViewMaterializer wrote `tagschemas.json` and the projection
 *    reader serves it back.
 *
 * 3. **Dispatcher rejects unregistered schema.** `mark.assist` with a
 *    `schemaId` not in the projection must reject synchronously with
 *    `Tag schema not registered: <id>`. This is the failure mode
 *    introduced by Stage 2's worker/dispatcher migration: the worker
 *    no longer has a build-time fallback, so an unknown schemaId is
 *    a synchronous-at-job-creation error rather than a worker-time
 *    "Invalid tag schema".
 *
 * 4. **Tagging applies.** `mark.assist(rid, 'tagging', { schemaId,
 *    categories })` against a registered schema runs the LLM tagging
 *    pass; the resulting annotations carry the canonical two-body
 *    shape — a `purpose: 'classifying'` `TextualBody` identifying the
 *    schema id, plus a `purpose: 'tagging'` `TextualBody` carrying
 *    the chosen category. Asserting both bodies is the load-bearing
 *    check that the dispatcher correctly resolved `schemaId` →
 *    `TagSchema` and that the worker used the embedded schema.
 *
 * Regression targets:
 *
 * - **Bridge regression** — the test page never receives
 *   `frame:tag-schema-added` even though `frame.addTagSchema` succeeded
 *   on the SDK side. Means `'frame:tag-schema-added'` was dropped from
 *   `BRIDGED_CHANNELS` or the backend isn't fanning the system event
 *   to SSE subscribers.
 * - **Materialization regression** — the projection file isn't being
 *   written, so `browse.tagSchemas()` doesn't surface the registration.
 *   `ViewMaterializer.materializeTagSchemas` or `ViewManager.materializeSystem`
 *   would be the culprit.
 * - **Dispatcher fallback regression** — `mark.assist` against an
 *   unknown schemaId silently succeeds. Means the dispatcher is
 *   either consulting a stale build-time registry (Stage 2 incomplete)
 *   or the projection lookup is hiding errors.
 * - **Worker schema-embedding regression** — annotations land but
 *   without the `classifying` body, or with the wrong schemaId in
 *   that body. Means the dispatcher isn't embedding the resolved
 *   `TagSchema` in `TagDetectionParams`, or the processor isn't
 *   reading `params.schema.id` (the post-Stage-2 shape).
 *
 * Uses a stable schema id so re-runs are silent at the projection
 * layer — the materializer's most-recent-wins semantics treat
 * identical re-registrations as no-ops. The schema is left registered
 * after the test; it's harmless to keep around.
 *
 * Slow because Phase 4 waits for a real LLM round-trip. Budget: 120s
 * (matches spec 09's generation-from-reference budget). If the seeded
 * KB's inference provider is unreachable or slow, the test will time
 * out — that's an environmental break, not a flake.
 */

const E2E_TAG_SCHEMA: TagSchema = {
  id: 'e2e-test-schema',
  name: 'E2E Test Schema',
  description:
    'Schema registered + applied by the e2e suite to exercise the runtime registration round-trip. Categories chosen to match content in the seeded "Quantum Computing Primer" so the LLM has something to tag.',
  domain: 'test',
  tags: [
    {
      name: 'Concept',
      description: 'A core theoretical idea introduced or defined in the text.',
      examples: [
        'a qubit is the quantum analogue of a bit',
        'superposition allows multiple states until measured',
        'entanglement links the joint state of two qubits',
      ],
    },
    {
      name: 'Mechanism',
      description: 'A described physical process, operation, or measurement procedure.',
      examples: [
        'measurement collapses the qubit to a basis state',
        'operations on one entangled qubit affect the others',
      ],
    },
  ],
};

test.describe('frame tag-schema registry + tagging round-trip', () => {
  test('register schema, observe bridged broadcast, reject unknown schemaId, apply via mark.assist, verify annotation body shape', async ({
    signedInPage: page,
    bus,
  }) => {
    test.setTimeout(120_000);

    // The page is signed in and connected to the backend's SSE feed.
    // Operations on a parallel SDK client below generate events on the
    // backend; bridged events fan out to the page's bus.
    await page.goto('/en/know/discover');
    // Wait for at least one resource card to render — proves the page's
    // session is fully connected before we start poking via the SDK.
    await expect(
      page.getByRole('button', { name: /^open resource:/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Build a parallel SDK client. Same backend, same user. This is the
    // shape every production caller takes (see seed.ts and the demo-KB
    // skills); the test exercises the SDK end-to-end rather than poking
    // bus channels directly.
    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      // ── Phase 1: registration round-trip ──────────────────────────
      bus.clear();
      await client.frame.addTagSchema(E2E_TAG_SCHEMA);

      // Bridged broadcast must reach the page's bus via SSE. If this
      // times out, `frame:tag-schema-added` isn't reaching the
      // frontend (see BRIDGED_CHANNELS).
      await bus.waitForRecv('frame:tag-schema-added', { timeout: 10_000 });

      // ── Phase 2: projection visibility ────────────────────────────
      //
      // The schema must appear in browse.tagSchemas(). The cache
      // backing this method invalidates on `frame:tag-schema-added`,
      // so the await will refetch.
      const schemas = await client.browse.tagSchemas();
      const found = schemas.find((s) => s.id === E2E_TAG_SCHEMA.id);
      expect(
        found,
        'registered schema should appear in browse.tagSchemas()',
      ).toBeDefined();
      expect(found!.tags.map((t) => t.name)).toEqual(
        E2E_TAG_SCHEMA.tags.map((t) => t.name),
      );

      // ── Phase 3: dispatcher rejects unknown schemaId ──────────────
      //
      // mark.assist against a schemaId that isn't in the projection
      // must reject synchronously. This is the post-Stage-2 contract:
      // the dispatcher resolves schemaId → TagSchema at job-creation
      // time, so an unknown id surfaces as a synchronous BusRequestError
      // (job:create-failed) rather than a worker-time "Invalid tag
      // schema" exception.
      //
      // Find any seeded resource — we just need a valid resourceId for
      // the call shape.
      const resources = await client.browse.resources({ limit: 50 });
      expect(resources.length, 'seeded KB must have ≥1 resource').toBeGreaterThan(0);
      const target = resources.find((r) => r.name === 'Quantum Computing Primer') ?? resources[0]!;
      const targetId = ridBrand(target['@id']);

      await expect(
        client.mark.assist(targetId, 'tagging', {
          schemaId: 'definitely-not-registered-schema-id',
          categories: ['Concept'],
        }),
      ).rejects.toThrow(/Tag schema not registered/);

      // ── Phase 4: real tagging round-trip ──────────────────────────
      //
      // Run the LLM tagging pass against the registered schema.
      // Awaiting the StreamObservable yields the last emit — a
      // 'complete' event carrying the JobCompleteCommand. If the worker
      // failed, the observable errors and the await rejects.
      const finalEvent = await client.mark.assist(targetId, 'tagging', {
        schemaId: E2E_TAG_SCHEMA.id,
        categories: E2E_TAG_SCHEMA.tags.map((t) => t.name),
      });
      expect(
        finalEvent.kind,
        'mark.assist should complete with a `complete` event (not progress, not an error)',
      ).toBe('complete');

      // Walk the resource's annotations and pick out the ones this
      // run created — `motivation: 'tagging'` with a classifying body
      // identifying our schema.
      const annotations = await client.browse.annotations(targetId);
      const ours = annotations.filter((a) => {
        if (a.motivation !== 'tagging') return false;
        const bodies = Array.isArray(a.body) ? a.body : a.body ? [a.body] : [];
        return bodies.some(
          (b: any) =>
            b?.type === 'TextualBody' &&
            b?.purpose === 'classifying' &&
            b?.value === E2E_TAG_SCHEMA.id,
        );
      });
      expect(
        ours.length,
        `at least one tagging annotation under schema "${E2E_TAG_SCHEMA.id}" should have been created`,
      ).toBeGreaterThan(0);

      // Inspect the canonical two-body shape on the first hit. The
      // dispatcher embeds the full TagSchema in TagDetectionParams,
      // and the processor stamps `params.schema.id` into the
      // classifying body — so the value here is load-bearing proof
      // that the post-Stage-2 worker pipeline used the embedded
      // schema.
      const ann = ours[0]!;
      const bodies = Array.isArray(ann.body) ? ann.body : ann.body ? [ann.body] : [];
      const classifyingBody = bodies.find(
        (b: any) => b?.type === 'TextualBody' && b?.purpose === 'classifying',
      );
      const taggingBody = bodies.find(
        (b: any) => b?.type === 'TextualBody' && b?.purpose === 'tagging',
      );

      expect(classifyingBody, 'tagging annotation must carry a classifying body').toBeDefined();
      expect((classifyingBody as any).value).toBe(E2E_TAG_SCHEMA.id);

      expect(taggingBody, 'tagging annotation must carry a tagging body').toBeDefined();
      expect(
        E2E_TAG_SCHEMA.tags.map((t) => t.name),
        'tagging body value must be one of the registered category names',
      ).toContain((taggingBody as any).value);
    } finally {
      client.dispose();
    }
  });
});
