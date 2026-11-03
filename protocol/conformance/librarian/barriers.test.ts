/**
 * What a Librarian does when the graph or the vector index is behind the
 * record (LIBRARIAN.md § The knowledge graph, § The two waits,
 * § Gathering around a resource, § Text search, § Reference search): a gather
 * waits for the Weaver, and says the graph is behind when the Weaver does not
 * come; a resource a vector hit names is described from its view while the
 * graph does not hold it; a resource gather waits for the Smelter's decision,
 * for no longer than its settle bound; and a Librarian that was stopped
 * answers as it did before, for it owns no store.
 *
 * A store is behind here because its writer is stopped. Every case that
 * stops one starts it again, whatever happens in between.
 */
import { expect, it } from 'vitest';
import { eachLibrarian, SETTLE_TIMEOUT_MS } from '../harness/librarian-world';
import { eventually } from '../harness/net';

/** A resource gather that asks for the graph and the similar passages and for nothing a model writes: no generation is made for it. */
const PLAIN = { depth: 1, maxResources: 10, includeContent: false, includeSummary: false };

/** A settle bound short enough for a case to wait out, and one a Librarian starts on. */
const SHORT_SETTLE_MS = 2_000;

/** The eight bytes a PNG begins with, and no more: a media type with no text. */
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What `asking` came to, and how long it took. */
async function timed<T>(asking: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const began = Date.now();
  const value = await asking();
  return { value, ms: Date.now() - began };
}

eachLibrarian('a Librarian whose stores are behind the record', (world) => {
  /** Run `body` with the Weaver stopped: what is recorded in it is not in the graph. The Weaver is started again whatever `body` does. */
  async function withoutWeaver<T>(body: () => Promise<T>): Promise<T> {
    await world().stopWeaver();
    try {
      return await body();
    } finally {
      await world().startWeaver();
    }
  }

  /** Run `body` with the Smelter stopped: what is recorded in it has no vectors, and is not settled. The Smelter is started again whatever `body` does. */
  async function withoutSmelter<T>(body: () => Promise<T>): Promise<T> {
    await world().stopSmelter();
    try {
      return await body();
    } finally {
      await world().startSmelter();
    }
  }

  /** The similar passage a gather answered from one resource, if it answered one. */
  const passageOf = <P extends { resourceId: string }>(similar: readonly P[] | undefined, resourceId: string): P | undefined => similar?.find((passage) => String(passage.resourceId) === resourceId);

  // ── The graph barrier ─────────────────────────────────────────────────────

  it('answers a gather asked the moment a resource is made with the resource in its graph', async () => {
    const resource = await world().created('A wren nests in the hawthorn hedge.\n', { name: 'Wren' });

    // Asked before the Weaver is waited for. Whether the graph held the resource already is not seen from here: the gather is answered either way.
    const gathered = await world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN });

    expect(String(gathered.resourceId)).toBe(resource);
    expect(gathered.response.graph.nodes).toContainEqual(expect.objectContaining({ id: resource, type: 'resource' }));
  }, 60_000);

  it('fails a gather for a resource the graph is behind on, soon and saying so; and answers it once the Weaver has caught up', async () => {
    const resource = await withoutWeaver(async () => {
      const made = await world().created('A stoat hunts along the dry stone wall.\n', { name: 'Stoat' });
      await eventually(`the view of ${made}`, 10_000, () => world().kb.view(made));

      const { value: behind, ms } = await timed(() => world().failed('gather:resource-requested', { resourceId: made, options: PLAIN }));
      // The record holds the resource, so the failure is about the graph, and not that there is no such resource.
      expect(String(behind.resourceId)).toBe(made);
      expect(behind.message).toMatch(/graph/i);
      expect(behind.message).not.toMatch(/not found/i);
      // It waited for the Weaver, for about a second, and did not leave the request to its timeout.
      expect(ms).toBeGreaterThanOrEqual(700);
      expect(ms).toBeLessThan(10_000);
      expect(world().appliedSignals(made)).toEqual([]);

      // A resource nobody made is no resource, whatever the graph holds.
      const unknown = await world().failed('gather:resource-requested', { resourceId: 'made-by-no-one', options: PLAIN });
      expect(unknown.message).toMatch(/not found/i);
      return made;
    });

    // A Weaver that has started holds in the graph what the record held when it started.
    const gathered = await world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN });
    expect(gathered.response.graph.nodes).toContainEqual(expect.objectContaining({ id: resource, type: 'resource' }));
  }, 120_000);

  // ── A resource the graph does not hold yet, described from its view ───────

  it('answers a text search by meaning with a resource the graph does not hold yet, described from its view', async () => {
    // No resource of this file has a name, a path or an entity type with these words in it, so nothing matches them as words.
    const text = 'Kelp forests shelter urchins and otters';
    await withoutWeaver(async () => {
      const resource = await world().created(text, { name: 'Held by the view alone' });
      expect(await world().settled(resource)).toMatchObject({ outcome: 'indexed' });

      const found = await world().answered('match:resources-requested', { search: text });

      expect(world().appliedSignals(resource)).toEqual([]);
      expect(found.response.matchKind).toBe('semantic');
      expect(found.response.total).toBeGreaterThanOrEqual(1);
      // Its description is the view's, and with it the passage that matched.
      const hit = found.response.resources.find((one) => String(one['@id']) === resource);
      expect(hit).toMatchObject({ name: 'Held by the view alone', content: text });
    });
  }, 120_000);

  it('answers a reference search with a resource only the vector index and the view hold', async () => {
    const source = await world().created('The heron waits at the weir for a silver eel.\n', { name: 'Heron' });
    const reference = await world().referenced(source, 'silver eel');
    await world().ready(source);
    // The context is gathered while the graph is in step: one generation, of how the passage relates to what is around it.
    world().gatherer.script({ response: 'The passage names a fish the heron eats.' });
    const gathered = await world().answered('gather:requested', { annotationId: reference, resourceId: source });

    await withoutWeaver(async () => {
      // Its whole text is the words the reference quotes, so its one vector is the vector of the search term.
      const target = await world().created('silver eel', { name: 'Caught by the index' });
      expect(await world().settled(target)).toMatchObject({ outcome: 'indexed' });

      // No model is asked: the search states that it wants none.
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context: gathered.response, useSemanticScoring: false });

      expect(world().appliedSignals(target)).toEqual([]);
      expect(String(found.referenceId)).toBe(reference);
      const candidate = found.response.find((one) => String(one['@id']) === target);
      expect(candidate).toMatchObject({ name: 'Caught by the index' });
      expect(candidate?.matchReason).toContain('semantic similarity');
    });
  }, 120_000);

  // ── The settle barrier ────────────────────────────────────────────────────

  it('waits for the Smelter to index a resource that was just made, and then answers with the passages near its own', async () => {
    // Two resources of one text: each one's chunk has the vector of the other's.
    const text = 'A lamplighter walks the quay at dusk.\n';
    const neighbour = await world().created(text, { name: 'Quay, the first copy' });
    await world().ready(neighbour);

    // The provider holds the request for the second copy's vector, so the Smelter has decided nothing of it.
    const provider = world().smelterEmbedder;
    provider.choose = (request) => (request.texts.includes(text) ? { hold: true } : undefined);
    const resource = await world().created(text, { name: 'Quay, the second copy' });
    await world().woven(resource);
    await eventually("the Smelter to ask for the second copy's vector", 10_000, () => (provider.held === 1 ? true : undefined));

    let answered = false;
    const asking = timed(() => world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN })).finally(() => {
      answered = true;
    });
    // A gather that fails while the case pauses is reported where the case waits for it, below.
    asking.catch(() => undefined);
    await pause(1_000);
    expect(answered).toBe(false);

    // Answered well inside the 15 seconds a Smelter gives a request, the resource is indexed, and the gather goes on.
    provider.release();
    const { value: gathered, ms } = await asking;

    expect(ms).toBeGreaterThanOrEqual(1_000);
    expect(ms).toBeLessThan(SETTLE_TIMEOUT_MS);
    const passage = passageOf(gathered.response.semanticContext?.similar, neighbour);
    expect(passage).toMatchObject({ resourceName: 'Quay, the first copy', text });
    expect(passage?.score).toBeGreaterThan(0.99);
    // A resource is no neighbour of itself.
    expect(passageOf(gathered.response.semanticContext?.similar, resource)).toBeUndefined();
  }, 120_000);

  it.each<[what: string, content: string | Buffer, format: string]>([
    ['a text of nothing but white space', ' \n\t\n', 'text/plain'],
    ['an image, whose media type has no text', IMAGE, 'image/png'],
  ])('answers a gather for %s without similar passages, and does not wait out its settle bound', async (_what, content, format) => {
    const resource = await world().created(content, { name: 'Skipped', format });

    // Asked before the Smelter is waited for: its decision, that it skips the resource, ends the wait.
    const { value: gathered, ms } = await timed(() => world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN }));

    expect(gathered.response.semanticContext).toBeUndefined();
    expect(gathered.response.graph.nodes).toContainEqual(expect.objectContaining({ id: resource, type: 'resource' }));
    expect(ms).toBeLessThan(SETTLE_TIMEOUT_MS / 2);
    expect(await world().settled(resource)).toMatchObject({ outcome: 'skipped' });
  }, 60_000);

  it('answers at once, after it is started again, a gather for an indexed resource that nothing is like and one for an image: it has heard no decision of either, and waits for none', async () => {
    const lone = await world().created('A wheelwright trues the rim of a cart wheel.\n', { name: 'Wheel' });
    const image = await world().created(IMAGE, { name: 'A plate of a wheel', format: 'image/png' });
    await world().ready(lone, image);
    expect(await world().settled(lone)).toMatchObject({ outcome: 'indexed' });

    // The Librarian that answers next has heard the Smelter say nothing of these two resources.
    await world().restartLibrarian();

    for (const resource of [lone, image]) {
      const { value: gathered, ms } = await timed(() => world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN }));
      expect(gathered.response.semanticContext).toBeUndefined();
      expect(gathered.response.graph.nodes).toContainEqual(expect.objectContaining({ id: resource, type: 'resource' }));
      expect(ms).toBeLessThan(SETTLE_TIMEOUT_MS / 2);
    }
    expect(world().output.filter((line) => /degraded/i.test(line))).toEqual([]);
  }, 120_000);

  it('answers without similar passages when the Smelter has not decided by the settle bound, and says in its log that the gather is degraded', async () => {
    const text = 'A cooper hoops the staves of an oak cask.\n';
    const neighbour = await world().created(text, { name: 'Cask, the first copy' });
    await world().ready(neighbour);

    await world().restartLibrarian({ settings: { ...world().settings, settleTimeoutMs: SHORT_SETTLE_MS } });
    try {
      const resource = await withoutSmelter(async () => {
        const made = await world().created(text, { name: 'Cask, the second copy' });
        // The graph is in step, so the gather's one wait is for the Smelter.
        await world().woven(made);
        const said = world().output.length;

        const { value: gathered, ms } = await timed(() => world().answered('gather:resource-requested', { resourceId: made, options: PLAIN }));

        // Answered, with its graph and without the passages: after about the bound, and not before it.
        expect(gathered.response.graph.nodes).toContainEqual(expect.objectContaining({ id: made, type: 'resource' }));
        expect(gathered.response.semanticContext).toBeUndefined();
        expect(ms).toBeGreaterThanOrEqual(SHORT_SETTLE_MS - 100);
        expect(ms).toBeLessThan(SHORT_SETTLE_MS + 10_000);
        expect(world().settledSignals(made)).toEqual([]);
        const degraded = world()
          .output.slice(said)
          .filter((line) => /degraded/i.test(line) && line.includes(made));
        expect(degraded).not.toEqual([]);
        return made;
      });

      // A Smelter that has started holds in the index what the record held when it started: the same gather now finds the first copy.
      const gathered = await world().answered('gather:resource-requested', { resourceId: resource, options: PLAIN });
      expect(passageOf(gathered.response.semanticContext?.similar, neighbour)).toMatchObject({ resourceName: 'Cask, the first copy', text });
    } finally {
      await world().restartLibrarian();
    }
  }, 240_000);

  // ── A Librarian that was stopped ──────────────────────────────────────────

  it('answers a gather and a search as it did before it was stopped, and waits on neither writer for what both stores hold', async () => {
    const text = 'A clerk rules the columns of a ledger.\n';
    const first = await world().created(text, { name: 'Ledger, the first copy' });
    const second = await world().created(text, { name: 'Ledger, the second copy' });
    await world().highlighted(first, 'ledger');
    await world().ready(first, second);

    const gatheredBefore = await world().answered('gather:resource-requested', { resourceId: first, options: PLAIN });
    const foundBefore = await world().answered('match:resources-requested', { search: 'Ledger' });
    expect(passageOf(gatheredBefore.response.semanticContext?.similar, second)).toMatchObject({ resourceName: 'Ledger, the second copy', text });
    expect(foundBefore.response.matchKind).toBe('lexical');
    expect(foundBefore.response.resources.map((one) => String(one['@id'])).sort()).toEqual([first, second].sort());

    // The Librarian that answers next has heard neither writer say anything of these two resources.
    await world().restartLibrarian();

    const { value: gatheredAfter, ms } = await timed(() => world().answered('gather:resource-requested', { resourceId: first, options: PLAIN }));
    expect(gatheredAfter).toEqual(gatheredBefore);
    expect(ms).toBeLessThan(SETTLE_TIMEOUT_MS / 2);
    expect(await world().answered('match:resources-requested', { search: 'Ledger' })).toEqual(foundBefore);
    expect(world().output.filter((line) => /degraded/i.test(line))).toEqual([]);
  }, 180_000);
});
