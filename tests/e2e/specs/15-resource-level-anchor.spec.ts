import { test, expect } from '@playwright/test';
import { SemiontClient } from '@semiont/sdk';
import { getTargetSource, getTargetSelector, getBodySource } from '@semiont/core';
import { BACKEND_URL, E2E_EMAIL, E2E_PASSWORD } from '../playwright.config';

/**
 * Smoke test — RESOURCE-LEVEL-ANCHOR.md Phase 5 (verify): a whole-resource
 * (source-only, *selectorless*) annotation is a first-class target — it is
 * created, served by `browse.annotations`, and its `SpecificResource` body
 * edge resolves to the linked resource.
 *
 * This is a pure **SDK round-trip** (no browser): the feature has no UI
 * affordance; its consumers are the SDK and fleet skills (e.g. the newsroom
 * Claim→Source binder). The edge shape mirrors the canonical pattern in
 * `semiont-newsroom-kb/skills/bind-claim-to-source` — a source-only `target`
 * with a `SpecificResource` body.
 *
 * RED→GREEN: before P2 (#908), `@semiont/core`'s `assembleAnnotation` hard-threw
 * "Either TextPositionSelector, SvgSelector, or FragmentSelector is required" on
 * a selectorless target, so the `mark.annotation` below would reject. P2 deleted
 * that throw — a successful create + serve IS the verification that whole-resource
 * targets are now first-class. (Deterministic RED lives in the `@semiont/core`
 * unit test; this is the system-level guard against the live stack.)
 *
 * Self-seeding: creates its own two resources, so it doesn't depend on the
 * global seed's fixtures.
 */
test.describe('resource-level anchor', () => {
  test('a source-only (whole-resource) annotation is created, served, and its edge resolves', async () => {
    test.setTimeout(60_000);

    const client = await SemiontClient.signInHttp({
      baseUrl: BACKEND_URL,
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
    });

    try {
      // Two resources: "claim" A (the annotation target) and "source" B (the edge target).
      const a = (
        await client.yield.resource({
          name: 'P5 Claim',
          storageUri: 'file://e2e/p5-claim.txt',
          file: Buffer.from('A claim that needs a supporting source.', 'utf-8'),
          format: 'text/plain',
          language: 'en',
        })
      ).resourceId;
      const b = (
        await client.yield.resource({
          name: 'P5 Source',
          storageUri: 'file://e2e/p5-source.txt',
          file: Buffer.from('The supporting source document.', 'utf-8'),
          format: 'text/plain',
          language: 'en',
        })
      ).resourceId;

      // Whole-resource edge A→B: a source-only target (no selector) with a
      // SpecificResource body. Pre-P2 this threw "selector required"; that it
      // returns an id at all is the core assertion of the feature.
      const { annotationId } = await client.mark.annotation({
        target: { source: a },
        motivation: 'linking',
        body: [
          { type: 'SpecificResource', source: b, purpose: 'linking' },
          { type: 'TextualBody', purpose: 'tagging', value: 'supports' },
        ],
      });
      expect(annotationId, 'source-only annotation was created (not rejected)').toBeTruthy();

      // Served by browse.annotations(A) — poll for SSE/cache delivery.
      await expect
        .poll(async () => (await client.browse.annotations(a)).some((x) => x.id === annotationId), {
          timeout: 30_000,
        })
        .toBe(true);

      const created = (await client.browse.annotations(a)).find((x) => x.id === annotationId);
      expect(created, 'annotation served by browse.annotations').toBeTruthy();

      // Source-only: target points at A with NO selector.
      expect(getTargetSource(created!.target)).toBe(a);
      expect(getTargetSelector(created!.target), 'whole-resource target carries no selector').toBeFalsy();

      // The SpecificResource body edge resolves to B.
      expect(getBodySource(created!.body)).toBe(b);
    } finally {
      client.dispose();
    }
  });
});
