/**
 * What a Librarian finds (LIBRARIAN.md § Reference search, § Text search,
 * § What refers to a resource, § Names, § Limits): the candidates it answers for a
 * reference, from the graph, the vector index, the gathered context and its
 * model; the page it answers a search of resources by text, from the graph or,
 * where nothing matches there, from the index; the references it answers for
 * a resource they are bound to; the names it gives the people a page
 * mentions; and the limits it reports of each actor's model.
 *
 * The scores, the prompt's text and the arithmetic of a page are the case
 * tables' (specs/src/librarian): these cases hold what crosses the bus, the
 * stores and the providers.
 *
 * The stand-in embedding provider gives a text a vector worked out from the
 * text alone, so two texts are near only when they are the same, or by
 * chance. A case that needs a chunk the index answers a search with records a
 * resource whose text is the search's own; one that needs a chunk at a stated
 * distance tries texts until the provider puts one there. The file's cases
 * share one index, so a search by meaning may be answered with a chunk of an
 * earlier case's: where a case states a whole page, it works the page out
 * from what the index holds.
 */
import { describe, expect, it } from 'vitest';
import type { components } from '@semiont/core';
import { GATHERER_MODEL, MATCHER_MODEL, SEMANTIC_FLOOR, eachLibrarian } from '../harness/librarian-world';
import { eventually } from '../harness/net';
import { embeddingOf } from '../harness/ollama-embed';
import { pdfOf } from '../smelter/support';
import { FOX, TIDE, prompts } from './support';

/** What the people projection holds. */
type People = components['schemas']['PeopleProjection'];

/** How near the stand-in provider puts two texts: the cosine of their vectors, each of which has length 1. */
function nearness(a: string, b: string): number {
  const other = embeddingOf(b);
  return embeddingOf(a).reduce((sum, n, at) => sum + n * other[at]!, 0);
}

/**
 * A text the stand-in provider puts at least `least` near `to` and at most
 * `most`. No text is near another but by chance, so texts are tried until one
 * is.
 */
function textNear(to: string, least: number, most: number): string {
  for (let n = 1; n <= 500_000; n++) {
    const text = `Passage ${n} of the survey of the lower marsh`;
    const score = nearness(to, text);
    if (score >= least && score <= most) return text;
  }
  throw new Error(`no text was found between ${least} and ${most} near ${JSON.stringify(to)}`);
}

/** The text a hit of a text search carries beside its description: a preview of a lexical hit, the passage that matched of a semantic one. */
const textOf = (hit: object): unknown => ('content' in hit ? hit.content : undefined);

/** What a search answered for one resource: its candidate of a reference search, or its hit of a text search. */
function candidate<C extends { '@id': string }>(candidates: readonly C[], resourceId: string): C {
  const found = candidates.find((one) => one['@id'] === resourceId);
  if (found === undefined) throw new Error(`the search did not answer ${resourceId}: ${JSON.stringify(candidates.map((one) => one['@id']))}`);
  return found;
}

/** The number a score prompt gives a candidate: the digits its line of the prompt begins with. Undefined when the prompt lists no such candidate. */
function numbered(prompt: string, resourceId: string): string | undefined {
  const line = prompt.split('\n').find((one) => /^\d+\./.test(one) && one.includes(resourceId));
  return line === undefined ? undefined : line.slice(0, line.indexOf('.'));
}

/** A provider's refusal of one request. */
const REFUSAL = { status: 500, body: JSON.stringify({ error: 'the stand-in refuses this request' }) };

/** The limits a Librarian reports of a model an Ollama serves with a window of `window` tokens: an Ollama has one window, for what a model reads and what it writes. */
const limitsOf = (model: string, window: number) => ({
  response: { limits: [{ provider: 'ollama', model, limits: { contextTokens: window, maxOutputTokens: window, acceptsTemperature: true } }] },
});

eachLibrarian('a Librarian, asked to find', (world) => {
  /**
   * The context of a reference, gathered as a client gathers it before it
   * searches. The reference links nowhere, so the Gatherer's model is asked
   * once: for how the passage relates to what is around it.
   */
  async function gathered(resourceId: string, referenceId: string) {
    world().gatherer.script({ response: 'The passage names something another resource is about.' });
    return (await world().answered('gather:requested', { annotationId: referenceId, resourceId })).response;
  }

  /**
   * What the index holds at or above `floor` of `text`: one entry for each
   * resource, with the text of its nearest chunk, nearest first. It is what a
   * page answered from the index must hold, worked out from the points the
   * Smelter wrote and the vectors the stand-in provider gives.
   */
  async function within(text: string, floor: number): Promise<Array<{ resourceId: string; passage: string }>> {
    const nearest = new Map<string, { resourceId: string; passage: string; score: number }>();
    for (const point of await world().index.points('resources')) {
      const resourceId = String(point.payload['resourceId']);
      const passage = String(point.payload['text']);
      const score = nearness(text, passage);
      const held = nearest.get(resourceId);
      if (score >= floor && (held === undefined || score > held.score)) nearest.set(resourceId, { resourceId, passage, score });
    }
    return [...nearest.values()].sort((a, b) => b.score - a.score).map(({ resourceId, passage }) => ({ resourceId, passage }));
  }

  /** A text recorded as a resource whose one chunk in the index is the text, whole: a search for the text finds that chunk. */
  async function recorded(text: string, name: string): Promise<string> {
    const resourceId = await world().created(text, { name });
    await world().ready(resourceId);
    expect((await world().index.pointsOf('resources', resourceId)).map((point) => point.payload['text'])).toEqual([text]);
    return resourceId;
  }

  describe('candidates for a reference', () => {
    it('answers a candidate from each of its four sources, each a description of its resource with a score and a reason; told not to score by meaning, it asks no model', async () => {
      const quoted = 'bittern booms from the sedge';
      const byName = await world().created('A page about one bird of the reedbed.\n', { name: 'Bittern booms from the sedge' });
      const byType = await world().created('A drawing of a brown bird among the reeds.\n', { name: 'Plate nine' });
      await world().tagged(byType, 'Marshbird');
      // Its one chunk is the quoted text itself, and its name has no word of it: only the index finds it.
      const byVector = await world().created(quoted, { name: 'Recording four' });
      const neighbour = await world().created('Places of the fen, listed from north to south.\n', { name: 'Gazetteer of the fen' });
      const source = await world().created(`At dusk a ${quoted}, and the tide turns.\n`, { name: 'Estuary notes' });
      // A second reference of the source's, bound to the neighbour: the graph then connects the two.
      await world().bound(source, await world().referenced(source, 'the tide'), neighbour);
      const reference = await world().referenced(source, quoted, { entityTypes: ['Marshbird'] });
      await world().ready(byName, byType, byVector, neighbour, source);
      expect((await world().index.pointsOf('resources', byVector)).map((point) => point.payload['text'])).toEqual([quoted]);

      const context = await gathered(source, reference);
      const asked = world().embedder.mark();
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context, useSemanticScoring: false });

      expect(found.referenceId).toBe(reference);
      expect(candidate(found.response, byName)).toMatchObject({ '@id': byName, name: 'Bittern booms from the sedge' });
      expect(candidate(found.response, byName).matchReason).toContain('name match');
      expect(candidate(found.response, byType)).toMatchObject({ '@id': byType, name: 'Plate nine', entityTypes: ['Marshbird'] });
      expect(candidate(found.response, byType).matchReason).toContain('entity types: Marshbird');
      expect(candidate(found.response, byVector)).toMatchObject({ '@id': byVector, name: 'Recording four' });
      expect(candidate(found.response, byVector).matchReason).toContain('semantic similarity');
      expect(candidate(found.response, neighbour)).toMatchObject({ '@id': neighbour, name: 'Gazetteer of the fen' });
      expect(candidate(found.response, neighbour).matchReason).toContain('connected');
      for (const one of found.response) {
        expect(typeof one.score).toBe('number');
        expect(typeof one.matchReason).toBe('string');
      }
      // The best candidate is first.
      const scores = found.response.map((one) => Number(one.score));
      expect(scores).toEqual([...scores].sort((a, b) => b - a));

      // The index was searched by the quoted text, embedded once; and no model was asked.
      expect(world().embedder.since(asked).map((request) => request.texts)).toEqual([[quoted]]);
      expect(world().matcher.generations).toEqual([]);
    });

    it('does not answer the resource the reference is on, though the index holds its very text', async () => {
      const quoted = 'dunlin turn as one over the mud';
      // Two resources whose one chunk is the quoted text: the reference's own, and another.
      const source = await world().created(quoted, { name: 'Shore log' });
      const twin = await world().created(quoted, { name: 'Fair copy of a log' });
      const reference = await world().referenced(source, quoted);
      await world().ready(source, twin);
      for (const resource of [source, twin]) {
        expect((await world().index.pointsOf('resources', resource)).map((point) => point.payload['text'])).toEqual([quoted]);
      }

      const context = await gathered(source, reference);
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context, useSemanticScoring: false });

      expect(candidate(found.response, twin).matchReason).toContain('semantic similarity');
      expect(found.response.map((one) => one['@id'])).not.toContain(source);
    });

    it('has its model score the candidates in one prompt, which states the passage and lists each candidate; a candidate it scores above a half says so in its reason', async () => {
      const target = await world().created('A white wader with a flat bill.\n', { name: 'Spoonbill' });
      const source = await world().created('A spoonbill sweeps the shallows at first light.\n', { name: 'Dawn log' });
      const reference = await world().referenced(source, 'spoonbill');
      await world().ready(target, source);
      const context = await gathered(source, reference);

      // The model scores the one candidate this case made, by the number the prompt gives it.
      world().matcher.choose = (body) => {
        const number = numbered(String(body['prompt']), target);
        return number === undefined ? undefined : { response: `${number}. 0.9` };
      };
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context });

      const sent = prompts(world().matcher);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain('spoonbill');
      expect(sent[0]).toContain('Spoonbill');
      expect(sent[0]).toContain(target);
      expect(world().matcher.generations[0]?.body['model']).toBe(MATCHER_MODEL);
      const scored = candidate(found.response, target);
      expect(scored.matchReason).toContain('semantic match');

      // The same search with no model asked: the candidate scores less, and its reason does not say the model matched it.
      const plain = candidate((await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context, useSemanticScoring: false })).response, target);
      expect(plain.matchReason).not.toContain('semantic match');
      expect(scored.score).toBeGreaterThan(Number(plain.score));
      expect(prompts(world().matcher)).toHaveLength(1);
    });

    it('answers all the same when its model fails: the candidates are scored without it, and no reason says the model matched', async () => {
      const target = await world().created('A small falcon of open moor.\n', { name: 'Merlin' });
      const source = await world().created('A merlin hunts low over the heather.\n', { name: 'Moor log' });
      const reference = await world().referenced(source, 'merlin');
      await world().ready(target, source);
      const context = await gathered(source, reference);

      world().matcher.choose = () => REFUSAL;
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context });

      expect(prompts(world().matcher).length).toBeGreaterThan(0);
      expect(found.referenceId).toBe(reference);
      expect(candidate(found.response, target).matchReason).toContain('name match');
      expect(found.response.filter((one) => one.matchReason?.includes('semantic match'))).toEqual([]);
    });

    it('answers no more candidates than the limit, and those are the best', async () => {
      const exact = await world().created('A black and white wader with an upturned bill.\n', { name: 'Avocet' });
      const longer = await world().created('Where they nest on the lagoon.\n', { name: 'Avocet colony' });
      const source = await world().created('An avocet sifts the brackish pool.\n', { name: 'Lagoon log' });
      const reference = await world().referenced(source, 'avocet');
      await world().ready(exact, longer, source);
      const context = await gathered(source, reference);
      const search = { resourceId: source, referenceId: reference, context, useSemanticScoring: false };

      const all = await world().answered('match:search-requested', search);
      expect(all.response.length).toBeGreaterThan(1);
      const limited = await world().answered('match:search-requested', { ...search, limit: 1 });
      expect(limited.response.map((one) => one['@id'])).toEqual([all.response[0]?.['@id']]);

      // A limit that asks for no candidate is refused, and the failure says which member it is about.
      const refused = await world().failed('match:search-requested', { ...search, limit: 0 });
      expect(refused.referenceId).toBe(reference);
      expect(refused.error).toMatch(/limit/);
    });

    it('fails a search whose context was gathered for a resource and not for a reference: the failure names the reference and is about the focus, and nothing is searched', async () => {
      const target = await world().created('A diving duck of the open sea.\n', { name: 'Scoter' });
      const source = await world().created('A scoter rides the swell beyond the bar.\n', { name: 'Sea watch' });
      const reference = await world().referenced(source, 'scoter');
      await world().ready(target, source);
      const context = await gathered(source, reference);
      const view = world().kb.view(source);
      if (view === undefined) throw new Error(`the record holds no view of ${source}`);

      const asked = world().embedder.mark();
      const failure = await world().failed('match:search-requested', {
        resourceId: source,
        referenceId: reference,
        context: { focus: { kind: 'resource', resource: view.resource }, graph: context.graph, metadata: context.metadata },
      });

      expect(failure.referenceId).toBe(reference);
      expect(failure.error).toMatch(/focus|annotation/i);
      expect(world().embedder.since(asked)).toEqual([]);
      expect(world().matcher.generations).toEqual([]);
    });

    it('answers from its other sources when the embedding provider fails: the index gives no candidate, and the one found by name is answered', async () => {
      const quoted = 'whimbrel passes over at night';
      const byName = await world().created('A page about one bird of passage.\n', { name: 'Whimbrel passes over at night' });
      // The index would answer this one, were the quoted text embedded.
      const byVector = await world().created(quoted, { name: 'Recording nine' });
      const source = await world().created(`In May a ${quoted}, calling.\n`, { name: 'Night log' });
      const reference = await world().referenced(source, quoted);
      await world().ready(byName, byVector, source);
      const context = await gathered(source, reference);

      const asked = world().embedder.mark();
      world().embedder.choose = () => REFUSAL;
      const found = await world().answered('match:search-requested', { resourceId: source, referenceId: reference, context, useSemanticScoring: false });

      expect(world().embedder.since(asked).length).toBeGreaterThan(0);
      expect(candidate(found.response, byName).matchReason).toContain('name match');
      expect(found.response.map((one) => one['@id'])).not.toContain(byVector);
      expect(found.response.filter((one) => one.matchReason?.includes('semantic similarity'))).toEqual([]);
    });
  });

  describe('resources by text', () => {
    it('answers a page of the resources the text matches by name, labelled `lexical`, each with a preview of its text; and asks for no embedding', async () => {
      const exactText = 'A rosette of quills under still water.\n';
      const longerText = 'Counted in the tarn, shore by shore.\n';
      const exact = await world().created(exactText, { name: 'Quillwort' });
      const longer = await world().created(longerText, { name: 'Quillwort survey' });
      await world().ready(exact, longer);

      const asked = world().embedder.mark();
      const page = (await world().answered('match:resources-requested', { search: 'quillwort' })).response;
      expect(page).toMatchObject({ total: 2, offset: 0, limit: 50, matchKind: 'lexical' });
      // The page's order is the graph's own, and is no rule of a Librarian's.
      const hits = page.resources.map((hit) => ({ id: hit['@id'], name: hit.name, preview: textOf(hit) }));
      expect(hits).toHaveLength(2);
      expect(hits).toEqual(expect.arrayContaining([
        { id: exact, name: 'Quillwort', preview: exactText },
        { id: longer, name: 'Quillwort survey', preview: longerText },
      ]));

      // A later page of it: the total is still of all that match.
      const second = (await world().answered('match:resources-requested', { search: 'quillwort', offset: 1, limit: 1 })).response;
      expect(second).toMatchObject({ total: 2, offset: 1, limit: 1, matchKind: 'lexical' });
      expect(second.resources.map((hit) => hit['@id'])).toEqual([hits[1]?.id]);

      expect(world().embedder.since(asked)).toEqual([]);
    });

    it('answers a search that no name matches from the index, labelled `semantic`: each hit carries the passage that matched, the nearest first, and the text is embedded once', async () => {
      const text = 'Glasswort reddens the upper marsh in autumn';
      const sheet = await recorded(text, 'Sheet twelve');

      const expected = await within(text, SEMANTIC_FLOOR);
      expect(expected[0]).toEqual({ resourceId: sheet, passage: text });
      const asked = world().embedder.mark();
      const page = (await world().answered('match:resources-requested', { search: text })).response;

      expect(page).toMatchObject({ total: expected.length, offset: 0, limit: 50, matchKind: 'semantic' });
      expect(page.resources.map((hit) => ({ resourceId: hit['@id'], passage: textOf(hit) }))).toEqual(expected.slice(0, 50));
      expect(page.resources[0]).toMatchObject({ '@id': sheet, name: 'Sheet twelve' });
      expect(world().embedder.since(asked).map((request) => request.texts)).toEqual([[text]]);
    });

    it('answers a later page of such a search with nothing, labelled `lexical`, and asks for no embedding: the index answers a first page only', async () => {
      const text = 'Sea lavender greys the creek banks';
      const sheet = await recorded(text, 'Sheet fourteen');
      const first = (await world().answered('match:resources-requested', { search: text })).response;
      expect(first.matchKind).toBe('semantic');
      expect(first.resources.map((hit) => hit['@id'])).toContain(sheet);

      const asked = world().embedder.mark();
      const later = (await world().answered('match:resources-requested', { search: text, offset: 1 })).response;
      expect(later).toEqual({ resources: [], total: 0, offset: 1, limit: 50, matchKind: 'lexical' });
      expect(world().embedder.since(asked)).toEqual([]);
    });

    it('answers a blank text with nothing, and asks for no embedding', async () => {
      const asked = world().embedder.mark();
      const page = (await world().answered('match:resources-requested', { search: ' \t ' })).response;
      expect(page).toEqual({ resources: [], total: 0, offset: 0, limit: 50, matchKind: 'lexical' });
      expect(world().embedder.since(asked)).toEqual([]);
    });

    it('keeps to the resources of an entity type, and to those that are archived or those that are not, where the search says so', async () => {
      const tagged = await world().created('It traps midges on the wet peat.\n', { name: 'Sundew of the bog' });
      const shelved = await world().created('Drawn in July, in flower.\n', { name: 'Sundew in flower' });
      const plain = await world().created('Raised under glass from seed.\n', { name: 'Sundew seedlings' });
      await world().tagged(tagged, 'Carnivore');
      await world().ready(tagged, shelved, plain);
      await world().archived(shelved);
      await world().woven(shelved);

      const found = async (filter: { entityType?: string; archived?: boolean }) => {
        const page = (await world().answered('match:resources-requested', { search: 'sundew', ...filter })).response;
        expect(page.matchKind).toBe('lexical');
        expect(page.total).toBe(page.resources.length);
        return page.resources.map((hit) => hit['@id']).sort();
      };
      expect(await found({})).toEqual([tagged, shelved, plain].sort());
      expect(await found({ entityType: 'Carnivore' })).toEqual([tagged]);
      expect(await found({ archived: true })).toEqual([shelved]);
      expect(await found({ archived: false })).toEqual([tagged, plain].sort());
    });

    it('keeps a page from the index to the entity type the search says, answers a search for archived resources from the graph alone, and refuses a limit that asks for no resource', async () => {
      // No name here has a word of either text, so a search by one of them matches nothing by name.
      const ofType = 'Butterwort holds its prey on a sticky leaf';
      const ofNone = 'Bladderwort floats free in the peat cutting';
      const tagged = await recorded(ofType, 'Sheet forty-one');
      const plain = await recorded(ofNone, 'Sheet forty-two');
      await world().tagged(tagged, 'Bogplant');
      // The Smelter writes a resource's entity types on its points when they change.
      await eventually(`the points of ${tagged} to carry its entity type`, 20_000, async () =>
        (await world().index.pointsOf('resources', tagged)).every((point) => JSON.stringify(point.payload['entityTypes']) === '["Bogplant"]') ? true : undefined,
      );

      const found = async (search: string, filter: { entityType?: string; archived?: boolean }) => {
        const page = (await world().answered('match:resources-requested', { search, ...filter })).response;
        expect(page.total).toBe(page.resources.length);
        return { matchKind: page.matchKind, resources: page.resources.map((hit) => hit['@id']) };
      };
      // By meaning, each text finds its own resource.
      expect((await found(ofNone, {})).resources).toContain(plain);
      expect(await found(ofType, { entityType: 'Bogplant' })).toEqual({ matchKind: 'semantic', resources: [tagged] });
      // Kept to an entity type, a search does not answer a resource that has none, though the index holds its very text.
      const kept = await found(ofNone, { entityType: 'Bogplant' });
      expect(kept.matchKind).toBe('semantic');
      expect(kept.resources).not.toContain(plain);
      // The index holds no archived resource: a search for them is the graph's answer, and nothing is embedded.
      const asked = world().embedder.mark();
      expect(await found(ofNone, { archived: true })).toEqual({ matchKind: 'lexical', resources: [] });
      expect(world().embedder.since(asked)).toEqual([]);
      expect((await found(ofNone, { archived: false })).resources).toContain(plain);

      const refused = await world().failed('match:resources-requested', { search: ofNone, limit: 0 });
      expect(refused.message).toMatch(/limit/);
    });

    it(
      'leaves out of a page from the index a resource below the semantic floor it was started with, and answers it under a lower floor',
      async () => {
        const text = 'Samphire is cut on the flats in June';
        const below = textNear(text, 0.3, 0.5);
        const above = textNear(text, 0.7, 0.95);
        const exact = await recorded(text, 'Sheet thirty-one');
        const belowFloor = await recorded(below, 'Sheet thirty-two');
        const aboveFloor = await recorded(above, 'Sheet thirty-three');

        // The world's floor is 0.6: the resource at 0.7 or more is answered, with its own passage, and the one at 0.5 or less is not.
        const expected = await within(text, SEMANTIC_FLOOR);
        const page = (await world().answered('match:resources-requested', { search: text })).response;
        expect(page).toMatchObject({ total: expected.length, matchKind: 'semantic' });
        const hits = page.resources.map((hit) => ({ resourceId: hit['@id'], passage: textOf(hit) }));
        expect(hits).toEqual(expected.slice(0, 50));
        expect(hits[0]).toEqual({ resourceId: exact, passage: text });
        expect(hits).toContainEqual({ resourceId: aboveFloor, passage: above });
        expect(hits.map((hit) => hit.resourceId)).not.toContain(belowFloor);

        // The floor is the Librarian's setting: started with one of 0.2, it answers the resource it left out.
        await world().restartLibrarian({ settings: { ...world().settings, semanticFloor: 0.2 } });
        try {
          const lower = await within(text, 0.2);
          const wider = (await world().answered('match:resources-requested', { search: text })).response;
          expect(wider).toMatchObject({ total: lower.length, matchKind: 'semantic' });
          const more = wider.resources.map((hit) => ({ resourceId: hit['@id'], passage: textOf(hit) }));
          expect(more).toEqual(lower.slice(0, 50));
          expect(more).toContainEqual({ resourceId: belowFloor, passage: below });
        } finally {
          await world().restartLibrarian();
        }
      },
      240_000,
    );

    it('answers the empty lexical page, and not a failure, when the embedding provider fails', async () => {
      const text = 'Scurvy grass flowers under the sea wall';
      // The index would answer this one, were the text embedded.
      await recorded(text, 'Sheet twenty-one');

      const asked = world().embedder.mark();
      world().embedder.choose = () => REFUSAL;
      const page = (await world().answered('match:resources-requested', { search: text })).response;

      expect(page).toEqual({ resources: [], total: 0, offset: 0, limit: 50, matchKind: 'lexical' });
      expect(world().embedder.since(asked).length).toBeGreaterThan(0);
    });

    it('previews a PDF it finds by name as the empty string, beside a text that previews as itself', async () => {
      const text = 'It floats, and traps what swims past.\n';
      const pdf = await world().created(pdfOf([['A bladderwort in flower', 'drawn from the dyke']]), { name: 'Bladderwort plate', format: 'application/pdf' });
      const notes = await world().created(text, { name: 'Bladderwort notes' });
      await world().woven(pdf, notes);

      const page = (await world().answered('match:resources-requested', { search: 'bladderwort' })).response;
      expect(page).toMatchObject({ total: 2, matchKind: 'lexical' });
      expect(textOf(candidate(page.resources, pdf))).toBe('');
      expect(textOf(candidate(page.resources, notes))).toBe(text);

      // The Smelter has then decided both, and the index is still for the next case.
      await world().settled(pdf);
      await world().settled(notes);
    });
  });

  describe('the references bound to a resource', () => {
    it('answers a reference that is bound to the resource, with the name of the resource it is in and the text it quotes', async () => {
      const citing = await world().created(FOX, { name: 'Ledger of the hunt' });
      const cited = await world().created(TIDE, { name: 'Table of the tides' });
      const reference = await world().referenced(citing, 'fox');
      await world().bound(citing, reference, cited);
      await world().woven(citing, cited);

      expect(await world().answered('gather:referenced-by-requested', { resourceId: cited })).toEqual({
        response: { referencedBy: [{ id: reference, resourceName: 'Ledger of the hunt', target: { source: citing, selector: { exact: 'fox' } } }] },
      });
      // The reference is in the citing resource, and nothing is bound to that one.
      expect(await world().answered('gather:referenced-by-requested', { resourceId: citing })).toEqual({ response: { referencedBy: [] } });
    });

    it('keeps to the references of one motivation, where the request states one', async () => {
      const citing = await world().created(FOX, { name: 'Ledger of the chase' });
      const cited = await world().created(TIDE, { name: 'Table of the neaps' });
      const reference = await world().referenced(citing, 'dog');
      await world().bound(citing, reference, cited);
      await world().highlighted(citing, 'quick');
      await world().woven(citing, cited);

      const linking = await world().answered('gather:referenced-by-requested', { resourceId: cited, motivation: 'linking' });
      expect(linking.response.referencedBy.map((one) => one.id)).toEqual([reference]);
      expect(await world().answered('gather:referenced-by-requested', { resourceId: cited, motivation: 'highlighting' })).toEqual({ response: { referencedBy: [] } });
    });

    it('answers an empty list for a resource nothing refers to', async () => {
      const alone = await world().created(TIDE, { name: 'Table of the springs' });
      await world().woven(alone);
      expect(await world().answered('gather:referenced-by-requested', { resourceId: alone })).toEqual({ response: { referencedBy: [] } });
    });

  });

  describe('the people a page mentions', () => {
    it('names who made a resource as the people projection holds them, on a lexical page and on a semantic one, where the record carries no name', async () => {
      const text = 'Thrift flowers pink along the shingle ridge';
      const resource = await world().created(text, { name: 'Thrift on the shingle', by: 'grace' });
      // A person is given a name when they first write through the gateway. An upload goes to the Archivist, and gives none.
      await world().tagged(resource, 'Coastal', 'grace');
      const did = world().personDid('grace');
      const profile = await eventually(`the people projection to hold ${did}`, 10_000, () => world().kb.projection<People>('people.json')?.people[did]);
      await world().ready(resource);
      expect((await world().index.pointsOf('resources', resource)).map((point) => point.payload['text'])).toEqual([text]);

      // The record says who, and gives no name.
      expect(world().kb.stored(resource)[0]?.payload['wasAttributedTo']).toEqual([{ '@type': 'Person', '@id': did }]);
      const named = [{ '@type': 'Person', '@id': did, name: profile.name }];

      const lexical = (await world().answered('match:resources-requested', { search: 'thrift' })).response;
      expect(lexical.matchKind).toBe('lexical');
      expect(candidate(lexical.resources, resource).wasAttributedTo).toEqual(named);

      const semantic = (await world().answered('match:resources-requested', { search: text })).response;
      expect(semantic.matchKind).toBe('semantic');
      expect(candidate(semantic.resources, resource).wasAttributedTo).toEqual(named);
    });
  });

  describe('the limits of its models', () => {
    it(
      "answers each limits request with the limits of its own actor's model, as that model's provider shows them",
      async () => {
        // A Librarian may keep what a provider showed it, so it is started again to be shown these.
        world().matcher.show = { contextLength: 4096 };
        world().gatherer.show = { contextLength: 2048 };
        await world().restartLibrarian();
        try {
          expect(await world().answered('match:limits-requested', {})).toEqual(limitsOf(MATCHER_MODEL, 4096));
          expect(await world().answered('gather:limits-requested', {})).toEqual(limitsOf(GATHERER_MODEL, 2048));
          // Each provider was asked about its own actor's model, and no other.
          expect(world().matcher.shows).toContainEqual(expect.objectContaining({ model: MATCHER_MODEL }));
          expect(world().matcher.shows).not.toContainEqual(expect.objectContaining({ model: GATHERER_MODEL }));
          expect(world().gatherer.shows).toContainEqual(expect.objectContaining({ model: GATHERER_MODEL }));
          expect(world().gatherer.shows).not.toContainEqual(expect.objectContaining({ model: MATCHER_MODEL }));
        } finally {
          // The next case's Librarian has been shown nothing.
          await world().restartLibrarian();
        }
      },
      240_000,
    );

    it(
      'leaves out a model whose provider does not answer for it, and still answers with a result within a few seconds; the model is reported again once its provider answers',
      async () => {
        world().matcher.show = { drop: true };
        world().gatherer.show = { status: 500 };
        await world().restartLibrarian();

        expect(await world().answered('match:limits-requested', {}, { timeoutMs: 5_000 })).toEqual({ response: { limits: [] } });
        expect(await world().answered('gather:limits-requested', {}, { timeoutMs: 5_000 })).toEqual({ response: { limits: [] } });
        expect(world().matcher.shows.length).toBeGreaterThan(0);
        expect(world().gatherer.shows.length).toBeGreaterThan(0);

        world().matcher.show = { contextLength: 8192 };
        world().gatherer.show = { contextLength: 8192 };
        expect(await world().answered('match:limits-requested', {}, { timeoutMs: 5_000 })).toEqual(limitsOf(MATCHER_MODEL, 8192));
        expect(await world().answered('gather:limits-requested', {}, { timeoutMs: 5_000 })).toEqual(limitsOf(GATHERER_MODEL, 8192));
      },
      180_000,
    );
  });
});
