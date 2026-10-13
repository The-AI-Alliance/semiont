/**
 * What a Librarian gathers (LIBRARIAN.md § Gathering around an annotation,
 * § Gathering around a resource, § An annotation's summary, § The knowledge
 * graph, § Order): the context around one annotation, the context of one
 * resource, and a model's summary of an annotation where it stands.
 * Each is asked on the bus by a person who is signed in, and answered from
 * what the Archivist recorded, the Weaver wove and the Smelter indexed. The
 * cases hold what crosses a store, a provider or the bus: which model calls
 * each option makes and which it leaves out, what a failing model costs, what
 * is read of another resource, and that two gathers for one resource are
 * answered one after the other. The text of a prompt, the cut of a window and
 * the build of a graph are the tables' (specs/src/librarian).
 *
 * The stand-in embedding provider gives two texts that differ two vectors
 * that have nothing to do with each other, so a passage is near another only
 * where both are the same words. The world is shared by the file, and what
 * earlier cases recorded stays in both stores: a case that reads similar
 * passages finds its own among them, by resource, and counts them only where
 * the request itself bounds how many are answered.
 */
import { describe, expect, it } from 'vitest';
import type { components } from '@semiont/core';
import { eachLibrarian, GATHERER_MODEL } from '../harness/librarian-world';
import { eventually } from '../harness/net';
import { pdfOf } from '../smelter/support';
import { FOX, TIDE, prompts } from './support';

type GatheredContext = components['schemas']['GatheredContext'];

/** The focus of a context gathered for an annotation. */
function annotationFocus(context: GatheredContext) {
  const focus = context.focus;
  if (focus.kind !== 'annotation') throw new Error(`the context's focus is a ${focus.kind}, and an annotation was gathered`);
  return focus;
}

/** The focus of a context gathered for a resource. */
function resourceFocus(context: GatheredContext) {
  const focus = context.focus;
  if (focus.kind !== 'resource') throw new Error(`the context's focus is an ${focus.kind}, and a resource was gathered`);
  return focus;
}

/** What a provider that fails answers. */
const FAILS = { status: 500, body: JSON.stringify({ error: 'the stand-in fails this generation' }) };

/** A resource gather that asks for the texts and no summary: what a case changes one member of. */
const TEXTS = { depth: 1, maxResources: 10, includeContent: true, includeSummary: false };

eachLibrarian('a Librarian, asked to gather', (world) => {
  /** A resource's view, as the Archivist wrote it. */
  function recorded(resourceId: string) {
    const view = world().kb.view(resourceId);
    if (view === undefined) throw new Error(`the record holds no view of ${resourceId}`);
    return view;
  }

  /** An annotation, as its resource's view holds it. */
  function recordedAnnotation(resourceId: string, annotationId: string) {
    const annotation = recorded(resourceId).annotations.annotations.find((one) => one.id === annotationId);
    if (annotation === undefined) throw new Error(`the view of ${resourceId} holds no annotation ${annotationId}`);
    return annotation;
  }

  /** Wait until the index holds the point of each annotation: the Smelter signals nothing when it writes one. */
  async function pointed(...annotationIds: string[]): Promise<void> {
    for (const annotationId of annotationIds) {
      await eventually(`the point of the annotation ${annotationId}`, 20_000, () => world().index.annotationPoint(annotationId));
    }
  }

  /** A reference on `exact` in a new copy of the fox text, bound to a new resource that holds `target`: the three ids, once both stores hold them. */
  async function boundReference(target: string | Buffer, options: { name: string; format?: string }) {
    const source = await world().created(FOX, { name: 'A fox and a dog' });
    const linked = await world().created(target, options);
    const reference = await world().referenced(source, 'fox', { entityTypes: ['Animal'] });
    await world().bound(source, reference, linked);
    await world().ready(source, linked);
    return { source, linked, reference };
  }

  describe('for an annotation', () => {
    it('answers a highlight on a text with the annotation as the record holds it, its resource, the text it selects with what is before and after it, and the sentence its model wrote', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const highlight = await world().highlighted(source, 'fox');
      await world().ready(source);

      // A highlight links nowhere: the one generation is the relationship sentence.
      world().gatherer.script({ response: 'The passage names an animal.' });
      const reply = await world().answered('gather:requested', { annotationId: highlight, resourceId: source });

      expect(reply.annotationId).toBe(highlight);
      const focus = annotationFocus(reply.response);
      expect(focus.annotation).toEqual(recordedAnnotation(source, highlight));
      expect(focus.sourceResource).toEqual(recorded(source).resource);
      expect(focus.selected).toEqual({ before: 'The quick brown ', text: 'fox', after: ' jumps over the lazy dog.\n' });
      expect(focus).not.toHaveProperty('targetResource');
      expect(focus).not.toHaveProperty('targetContext');
      expect(reply.response.inferredRelationshipSummary).toBe('The passage names an animal.');

      // The sentence was asked of the Gatherer's model, about the passage, and the Matcher's model was asked nothing.
      expect(prompts(world().gatherer)).toHaveLength(1);
      expect(prompts(world().gatherer)[0]).toContain('fox');
      expect(world().gatherer.generations[0]?.body['model']).toBe(GATHERER_MODEL);
      expect(world().matcher.generations).toEqual([]);
    });

    it('answers a bound reference with what it links to: the target as the record holds it, its text, its model\'s summary of it, and the target as a resource the graph connects', async () => {
      const { source, linked, reference } = await boundReference(TIDE, { name: 'A salt marsh' });
      const highlight = await world().highlighted(source, 'dog');
      await world().ready(source);

      // Two generations, in this order: the summary of the target, then the relationship sentence.
      world().gatherer.script({ response: 'A marsh that floods twice a day.' }, { response: 'The passage links to a marsh.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source });

      const focus = annotationFocus(reply.response);
      expect(focus.annotation).toEqual(recordedAnnotation(source, reference));
      expect(focus.targetResource).toEqual(recorded(linked).resource);
      expect(focus.targetContext).toEqual({ content: TIDE, summary: 'A marsh that floods twice a day.' });
      expect(reply.response.inferredRelationshipSummary).toBe('The passage links to a marsh.');
      expect(reply.response.metadata.entityTypes).toEqual(['Animal']);

      // The graph: the resource first, the resource the reference links to, and each annotation on the resource.
      const { nodes, edges } = reply.response.graph;
      expect(nodes[0]).toMatchObject({ id: source, type: 'resource', label: 'A fox and a dog' });
      expect(nodes).toContainEqual(expect.objectContaining({ id: linked, type: 'resource', label: 'A salt marsh' }));
      expect(edges).toContainEqual(expect.objectContaining({ source, target: linked }));
      for (const annotation of [reference, highlight]) {
        expect(nodes).toContainEqual(expect.objectContaining({ id: annotation, type: 'annotation' }));
        expect(edges).toContainEqual(expect.objectContaining({ source: annotation, target: source, type: 'annotation-of' }));
      }

      // The first prompt is about the target's text, and the second about the passage and what its resource is connected to.
      const asked = prompts(world().gatherer);
      expect(asked).toHaveLength(2);
      expect(asked[0]).toContain('A salt marsh');
      expect(asked[0]).toContain(TIDE.trim());
      expect(asked[1]).toContain('fox');
      expect(asked[1]).toContain('A salt marsh');
    });

    it('reads the text of a target that is a PDF from what the Smelter derived of it', async () => {
      const { source, linked, reference } = await boundReference(pdfOf([['A grebe dives under the jetty', 'and a coot keeps to the reeds']]), { name: 'Birds of the jetty', format: 'application/pdf' });

      world().gatherer.script({ response: 'Two birds by a jetty.' }, { response: 'The passage links to a page about birds.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source });

      // The anchored text the Archivist serves is the text the Smelter stored: no byte of the PDF is read as text.
      const derived = (await world().kb.anchoredText(linked))['text'];
      const focus = annotationFocus(reply.response);
      expect(focus.targetContext).toEqual({ content: derived, summary: 'Two birds by a jetty.' });
      for (const word of ['grebe', 'jetty', 'coot', 'reeds']) expect(focus.targetContext?.content).toContain(word);
      expect(prompts(world().gatherer)[0]).toContain('grebe');
    });

    it('states the entity types of the annotation, and how many resources of the knowledge base have each entity type', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const other = await world().created(TIDE, { name: 'A salt marsh' });
      const reference = await world().referenced(source, 'fox', { entityTypes: ['Mammal', 'Predator'] });
      // No other case of this file gives a resource either of these two.
      await world().tagged(source, 'Fable');
      await world().tagged(other, 'Fable');
      await world().tagged(other, 'Almanac');
      await world().ready(source, other);

      world().gatherer.script({ response: 'The passage names a mammal.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source });

      expect(reply.response.metadata.entityTypes).toEqual(['Mammal', 'Predator']);
      expect(reply.response.metadata.entityTypeFrequencies).toMatchObject({ Fable: 2, Almanac: 1 });
    });

    it('answers without the relationship sentence when its model fails on it, and with everything else', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const highlight = await world().highlighted(source, 'lazy');
      await world().ready(source);

      world().gatherer.script(FAILS);
      const reply = await world().answered('gather:requested', { annotationId: highlight, resourceId: source });

      expect(reply.response).not.toHaveProperty('inferredRelationshipSummary');
      const focus = annotationFocus(reply.response);
      expect(focus.annotation).toEqual(recordedAnnotation(source, highlight));
      expect(focus.selected?.text).toBe('lazy');
      expect(reply.response.graph.nodes[0]).toMatchObject({ id: source, type: 'resource' });
      // It asked once, and did not ask again.
      expect(world().gatherer.generations).toHaveLength(1);
    });

    it('answers a bound reference with the target\'s text and without a summary of it when its model fails on the summary, and with everything else', async () => {
      const { source, linked, reference } = await boundReference(TIDE, { name: 'A salt marsh' });

      // Two generations, in this order: the summary of the target, which fails, then the relationship sentence.
      world().gatherer.script(FAILS, { response: 'The passage links to a marsh.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source });

      const focus = annotationFocus(reply.response);
      expect(focus.targetResource).toEqual(recorded(linked).resource);
      expect(focus.targetContext).toEqual({ content: TIDE });
      expect(focus.selected?.text).toBe('fox');
      expect(reply.response.inferredRelationshipSummary).toBe('The passage links to a marsh.');
      expect(world().gatherer.generations).toHaveLength(2);
    });

    it('finds the passages of other resources that are near the selected text, names each by its resource, and takes none from the annotation\'s own resource', async () => {
      const phrase = 'a bittern booms';
      const source = await world().created(`At dusk ${phrase} from the sedge.\n`, { name: 'The sedge at dusk' });
      const elsewhere = await world().created(`Before rain ${phrase} twice, and stops.\n`, { name: 'Signs of rain' });
      const focal = await world().highlighted(source, phrase);
      // A second highlight of the same words on the same resource: as near as a passage can be, and not another resource's.
      const twin = await world().highlighted(source, phrase);
      const near = await world().highlighted(elsewhere, phrase);
      await world().ready(source, elsewhere);
      await pointed(focal, twin, near);

      const embedded = world().embedder.mark();
      world().gatherer.script({ response: 'The passage is about a bird that calls.' });
      const reply = await world().answered('gather:requested', { annotationId: focal, resourceId: source });

      const similar = reply.response.semanticContext?.similar ?? [];
      const found = similar.find((match) => match.resourceId === elsewhere);
      expect(found).toMatchObject({ text: phrase, resourceId: elsewhere, resourceName: 'Signs of rain', annotationId: near });
      expect(found?.score).toBeGreaterThan(0.99);
      // No passage is the annotation's own resource's, though two of its highlights quote these very words.
      expect(similar.filter((match) => match.resourceId === source)).toEqual([]);
      // Every passage is named as the record names its resource.
      for (const match of similar) expect(match.resourceName).toBe(recorded(match.resourceId).resource.name);

      // The text it had embedded to search by is the selected text, and that alone.
      expect(world().embedder.since(embedded).flatMap((request) => request.texts)).toEqual([phrase]);
    });

    it('leaves out the selected text when it is told not to include the source: it then asks for no relationship sentence, and searches for no similar passage', async () => {
      const { source, linked, reference } = await boundReference(TIDE, { name: 'A salt marsh' });

      const embedded = world().embedder.mark();
      // The one generation is the summary of the target.
      world().gatherer.script({ response: 'A marsh that floods twice a day.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source, options: { includeSourceContext: false } });

      const focus = annotationFocus(reply.response);
      expect(focus.annotation).toEqual(recordedAnnotation(source, reference));
      expect(focus.sourceResource).toEqual(recorded(source).resource);
      expect(focus).not.toHaveProperty('selected');
      expect(focus.targetResource).toEqual(recorded(linked).resource);
      expect(focus.targetContext).toEqual({ content: TIDE, summary: 'A marsh that floods twice a day.' });
      expect(reply.response).not.toHaveProperty('inferredRelationshipSummary');
      expect(reply.response).not.toHaveProperty('semanticContext');
      expect(prompts(world().gatherer)).toHaveLength(1);
      expect(world().embedder.since(embedded)).toEqual([]);
    });

    it('leaves out the target\'s text and its summary when it is told not to include the target, and still says what the reference links to', async () => {
      const { source, linked, reference } = await boundReference(TIDE, { name: 'A salt marsh' });

      // The one generation is the relationship sentence: no summary of the target is asked for.
      world().gatherer.script({ response: 'The passage links to a marsh.' });
      const reply = await world().answered('gather:requested', { annotationId: reference, resourceId: source, options: { includeTargetContext: false } });

      const focus = annotationFocus(reply.response);
      expect(focus.targetResource).toEqual(recorded(linked).resource);
      expect(focus).not.toHaveProperty('targetContext');
      expect(focus.selected?.text).toBe('fox');
      expect(reply.response.inferredRelationshipSummary).toBe('The passage links to a marsh.');
      const asked = prompts(world().gatherer);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('fox');
    });

    it('takes as much text on each side of the selection as the window it is given, and all there is within the window it is given none for', async () => {
      const text = `${'x'.repeat(150)} vixen ${'y'.repeat(150)}\n`;
      const at = text.indexOf('vixen');
      const end = at + 'vixen'.length;
      const source = await world().created(text, { name: 'A vixen between two runs of letters' });
      const highlight = await world().highlighted(source, 'vixen');
      await world().ready(source);

      world().gatherer.script({ response: 'The passage names an animal.' }, { response: 'The passage names an animal.' });
      const windowed = await world().answered('gather:requested', { annotationId: highlight, resourceId: source, options: { contextWindow: 100 } });
      expect(annotationFocus(windowed.response).selected).toEqual({ before: text.slice(at - 100, at), text: 'vixen', after: text.slice(end, end + 100) });

      // With no window stated, the text on each side is shorter than the window, and is all taken.
      const whole = await world().answered('gather:requested', { annotationId: highlight, resourceId: source });
      expect(annotationFocus(whole.response).selected).toEqual({ before: text.slice(0, at), text: 'vixen', after: text.slice(end) });
    });

    it.each([99, 5001])('fails a gather whose window is %i, which is out of bounds, and asks its model nothing', async (contextWindow) => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const highlight = await world().highlighted(source, 'fox');
      await world().ready(source);

      const failure = await world().failed('gather:requested', { annotationId: highlight, resourceId: source, options: { contextWindow } });

      expect(failure.annotationId).toBe(highlight);
      expect(failure.message).toMatch(/window/i);
      expect(world().gatherer.generations).toEqual([]);
    });

    it('fails a gather for an annotation the record does not hold, and names the annotation it was asked for', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      await world().ready(source);

      const failure = await world().failed('gather:requested', { annotationId: 'no-such-annotation', resourceId: source });

      expect(failure.annotationId).toBe('no-such-annotation');
      expect(failure.message).toMatch(/annotation/i);
      expect(world().gatherer.generations).toEqual([]);
    });

    it('fails a gather for an annotation that is on another resource than the one named', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const other = await world().created(TIDE, { name: 'A salt marsh' });
      const highlight = await world().highlighted(source, 'fox');
      await world().ready(source, other);

      const failure = await world().failed('gather:requested', { annotationId: highlight, resourceId: other });

      expect(failure.annotationId).toBe(highlight);
      expect(failure.message).toMatch(/annotation/i);
      expect(world().gatherer.generations).toEqual([]);
    });
  });

  describe('for a resource', () => {
    it('answers with the resource as the record holds it and, when asked for content, its text and the text of each resource the graph relates to it, by id', async () => {
      const { source, linked } = await boundReference(TIDE, { name: 'A salt marsh' });

      const outward = await world().answered('gather:resource-requested', { resourceId: source, options: TEXTS });
      expect(outward.resourceId).toBe(source);
      const focus = resourceFocus(outward.response);
      expect(focus.resource).toEqual(recorded(source).resource);
      expect(focus.content).toEqual({ main: FOX, related: { [linked]: TIDE } });
      expect(outward.response.graph.nodes[0]).toMatchObject({ id: source, type: 'resource', label: 'A fox and a dog' });
      expect(outward.response.graph.nodes).toContainEqual(expect.objectContaining({ id: linked, type: 'resource', label: 'A salt marsh' }));

      // The resource a reference links to is related to the resource the reference is on.
      const inward = await world().answered('gather:resource-requested', { resourceId: linked, options: TEXTS });
      expect(resourceFocus(inward.response).content).toEqual({ main: TIDE, related: { [source]: FOX } });

      // No summary was asked for, and no model was asked anything.
      expect(focus).not.toHaveProperty('summary');
      expect(focus).not.toHaveProperty('suggestedReferences');
      expect(world().gatherer.generations).toEqual([]);
    });

    it('answers with no text when it is not asked for content: the resource and its graph alone', async () => {
      const { source, linked } = await boundReference(TIDE, { name: 'A salt marsh' });

      const reply = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, includeContent: false } });

      const focus = resourceFocus(reply.response);
      expect(focus.resource).toEqual(recorded(source).resource);
      expect(focus).not.toHaveProperty('content');
      expect(reply.response.graph.nodes).toContainEqual(expect.objectContaining({ id: linked, type: 'resource' }));
      expect(world().gatherer.generations).toEqual([]);
    });

    it('reads the text of a PDF from what the Smelter derived of it', async () => {
      const pdf = await world().created(pdfOf([['A snipe drums over the fen', 'and a teal sleeps on the mere']]), { name: 'Birds of the fen', format: 'application/pdf' });
      await world().ready(pdf);

      const reply = await world().answered('gather:resource-requested', { resourceId: pdf, options: TEXTS });

      const main = resourceFocus(reply.response).content?.main;
      expect(main).toBe((await world().kb.anchoredText(pdf))['text']);
      for (const word of ['snipe', 'fen', 'teal', 'mere']) expect(main).toContain(word);
    });

    it('asks its model for a summary of the resource and then for suggestions, when it is asked for a summary, and answers with both', async () => {
      const source = await world().created(TIDE, { name: 'A salt marsh' });
      await world().ready(source);

      // Two generations, in this order: the summary, then the suggestions, one to a line.
      world().gatherer.script({ response: 'A marsh that floods twice a day.' }, { response: 'Read the tide tables\nWalk the sea wall' });
      const reply = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, includeSummary: true } });

      const focus = resourceFocus(reply.response);
      expect(focus.summary).toBe('A marsh that floods twice a day.');
      expect(focus.suggestedReferences).toEqual(['Read the tide tables', 'Walk the sea wall']);
      expect(focus.content?.main).toBe(TIDE);

      // The first prompt is about the resource's text, and the second names the resource.
      const asked = prompts(world().gatherer);
      expect(asked).toHaveLength(2);
      expect(asked[0]).toContain(TIDE.trim());
      expect(asked[1]).toContain('A salt marsh');
      expect(world().gatherer.generations[0]?.body['model']).toBe(GATHERER_MODEL);
    });

    it('makes a summary of the resource\'s text when it is asked for a summary and not for the texts, and answers the summary without the text', async () => {
      const source = await world().created(TIDE, { name: 'A salt marsh' });
      await world().ready(source);

      world().gatherer.script({ response: 'A marsh that floods twice a day.' }, { response: 'Read the tide tables' });
      const reply = await world().answered('gather:resource-requested', {
        resourceId: source,
        options: { ...TEXTS, includeContent: false, includeSummary: true },
      });

      const focus = resourceFocus(reply.response);
      expect(focus.summary).toBe('A marsh that floods twice a day.');
      expect(focus.suggestedReferences).toEqual(['Read the tide tables']);
      expect(focus).not.toHaveProperty('content');
      expect(prompts(world().gatherer)[0]).toContain(TIDE.trim());
    });

    it('answers without a summary or suggestions when its model fails on the summary, and asks for no suggestions', async () => {
      const source = await world().created(TIDE, { name: 'A salt marsh' });
      await world().ready(source);

      world().gatherer.script(FAILS);
      const reply = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, includeSummary: true } });

      const focus = resourceFocus(reply.response);
      expect(focus).not.toHaveProperty('summary');
      expect(focus).not.toHaveProperty('suggestedReferences');
      expect(focus.resource).toEqual(recorded(source).resource);
      expect(focus.content?.main).toBe(TIDE);
      expect(world().gatherer.generations).toHaveLength(1);
    });

    it('answers without a summary or suggestions when its model fails on the suggestions', async () => {
      const source = await world().created(TIDE, { name: 'A salt marsh' });
      await world().ready(source);

      world().gatherer.script({ response: 'A marsh that floods twice a day.' }, FAILS);
      const reply = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, includeSummary: true } });

      const focus = resourceFocus(reply.response);
      expect(focus).not.toHaveProperty('summary');
      expect(focus).not.toHaveProperty('suggestedReferences');
      expect(focus.content?.main).toBe(TIDE);
      expect(world().gatherer.generations).toHaveLength(2);
    });

    it('reads the text of one resource fewer than the most it is told, counting the resource itself, and leaves the graph whole', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      const texts = { marsh: 'A redshank pipes over the saltings.\n', shore: 'A turnstone works along the strandline.\n' };
      const marsh = await world().created(texts.marsh, { name: 'The saltings' });
      const shore = await world().created(texts.shore, { name: 'The strandline' });
      await world().bound(source, await world().referenced(source, 'fox'), marsh);
      await world().bound(source, await world().referenced(source, 'dog'), shore);
      await world().ready(source, marsh, shore);
      const textOf: Record<string, string> = { [marsh]: texts.marsh, [shore]: texts.shore };

      const all = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, maxResources: 3 } });
      expect(resourceFocus(all.response).content).toEqual({ main: FOX, related: textOf });

      // Two at most, itself and one other: which of the two others is the graph's to order.
      const two = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, maxResources: 2 } });
      const related = Object.entries(resourceFocus(two.response).content?.related ?? {});
      expect(related).toHaveLength(1);
      for (const [id, text] of related) expect(text).toBe(textOf[id]);
      // The graph is not cut: both resources are in it.
      for (const id of [marsh, shore]) expect(two.response.graph.nodes).toContainEqual(expect.objectContaining({ id, type: 'resource' }));

      const one = await world().answered('gather:resource-requested', { resourceId: source, options: { ...TEXTS, maxResources: 1 } });
      expect(resourceFocus(one.response).content).toEqual({ main: FOX, related: {} });
    });

    it('finds the resources near it by the vectors the index already holds of it, leaves out those of an excluded entity type, and records the exclusion on the reply', async () => {
      // Three resources of the same words: each is as near the others as a text can be.
      const text = 'A dipper bobs on a wet stone below the weir.\n';
      const source = await world().created(text, { name: 'The weir, first copy' });
      const plain = await world().created(text, { name: 'The weir, second copy' });
      const question = await world().created(text, { name: 'The weir, asked about' });
      await world().tagged(question, 'Question');
      await world().ready(source, plain, question);
      // The Smelter signals nothing when it writes an entity type on a resource's points.
      await eventually('the entity type on the points of the resource that was given it', 20_000, async () => {
        const points = await world().index.pointsOf('resources', question);
        return points.length > 0 && points.every((point) => JSON.stringify(point.payload['entityTypes']) === JSON.stringify(['Question'])) ? true : undefined;
      });

      const embedded = world().embedder.mark();
      const options = { ...TEXTS, includeContent: false };

      const every = await world().answered('gather:resource-requested', { resourceId: source, options });
      const unfiltered = every.response.semanticContext?.similar ?? [];
      for (const [id, name] of [[plain, 'The weir, second copy'], [question, 'The weir, asked about']] as const) {
        const found = unfiltered.find((match) => match.resourceId === id);
        expect(found).toMatchObject({ text, resourceId: id, resourceName: name });
        expect(found?.score).toBeGreaterThan(0.99);
        // A passage of a resource's text is no annotation's.
        expect(found).not.toHaveProperty('annotationId');
      }
      expect(unfiltered.filter((match) => match.resourceId === source)).toEqual([]);
      expect(every.response.semanticContext).not.toHaveProperty('excludedEntityTypes');

      const filtered = await world().answered('gather:resource-requested', { resourceId: source, options: { ...options, excludeEntityTypes: ['Question'] } });
      const kept = filtered.response.semanticContext?.similar ?? [];
      expect(kept.find((match) => match.resourceId === plain)).toMatchObject({ text, resourceName: 'The weir, second copy' });
      expect(kept.filter((match) => match.resourceId === question)).toEqual([]);
      expect(filtered.response.semanticContext?.excludedEntityTypes).toEqual(['Question']);

      // The most resources it is told is the most passages it answers with: one of the two copies, and nothing farther.
      const one = await world().answered('gather:resource-requested', { resourceId: source, options: { ...options, maxResources: 1 } });
      const nearest = one.response.semanticContext?.similar ?? [];
      expect(nearest).toHaveLength(1);
      expect([plain, question]).toContain(nearest[0]?.resourceId);

      // It searched by the resource's own vectors: its embedding provider was asked for none.
      expect(world().embedder.since(embedded)).toEqual([]);
    });

    it('builds the graph as many links out as the depth it is told: at 1 what the resource links to, at 2 what that links to as well, with an edge between the two, and at 4 nothing', async () => {
      // A chain: the first resource links to the second, and the second to the third.
      const first = await world().created(FOX, { name: 'The first of a chain' });
      const second = await world().created(FOX, { name: 'The second of a chain' });
      const third = await world().created(TIDE, { name: 'The third of a chain' });
      const toSecond = await world().referenced(first, 'fox');
      const toThird = await world().referenced(second, 'dog');
      await world().bound(first, toSecond, second);
      await world().bound(second, toThird, third);
      await world().ready(first, second, third);
      const options = { ...TEXTS, includeContent: false };
      const idsOf = (graph: GatheredContext['graph'], type: 'resource' | 'annotation') => graph.nodes.filter((node) => node.type === type).map((node) => node.id);

      const one = await world().answered('gather:resource-requested', { resourceId: first, options: { ...options, depth: 1 } });
      expect(idsOf(one.response.graph, 'resource')).toEqual([first, second]);

      const two = await world().answered('gather:resource-requested', { resourceId: first, options: { ...options, depth: 2 } });
      const { nodes, edges } = two.response.graph;
      // The nearest first: the resource, what it links to, and what that links to.
      expect(idsOf(two.response.graph, 'resource')).toEqual([first, second, third]);
      expect(nodes).toContainEqual(expect.objectContaining({ id: third, type: 'resource', label: 'The third of a chain' }));
      expect(edges).toContainEqual(expect.objectContaining({ source: second, target: third, type: 'link' }));
      // The second resource is cited by the first, which is how it was reached: that link is one edge.
      expect(edges.filter((edge) => edge.source === first && edge.target === second)).toHaveLength(1);
      // Only the resource asked for has its annotations as nodes: the reference on the second resource is not one.
      expect(idsOf(two.response.graph, 'annotation')).toEqual([toSecond]);
      expect(two.response.graph).not.toHaveProperty('truncated');

      // A depth out of bounds is not gathered: the gateway refuses the request, or the Librarian fails it.
      const refused = await world()
        .ask('gather:resource-requested', { resourceId: first, options: { ...options, depth: 4 } })
        .then((reply) => (reply.ok ? 'answered' : reply.failure.message), (thrown: unknown) => String(thrown));
      expect(refused).not.toBe('answered');
      expect(refused).toMatch(/depth|gather:resource-requested/i);
      expect(world().gatherer.generations).toEqual([]);
    });

    it('fails a gather for a resource the record does not hold, and names the resource it was asked for', async () => {
      const failure = await world().failed('gather:resource-requested', { resourceId: 'no-such-resource', options: TEXTS });

      expect(failure.resourceId).toBe('no-such-resource');
      expect(failure.message).toMatch(/resource/i);
      expect(world().gatherer.generations).toEqual([]);
    });
  });

  describe('for a summary of an annotation', () => {
    it('answers with its model\'s summary, the resource\'s name, the annotation\'s entity types, and the selected text with a bounded run of the text on each side', async () => {
      // More text on each side of the selection than the answer carries.
      const text = `${'b'.repeat(300)} heron ${'c'.repeat(300)}\n`;
      const at = text.indexOf('heron');
      const end = at + 'heron'.length;
      const source = await world().created(text, { name: 'A heron between two runs of letters' });
      const reference = await world().referenced(source, 'heron', { entityTypes: ['Bird'] });
      await world().ready(source);

      world().gatherer.script({ response: 'The passage names a wading bird.' });
      const { response } = await world().answered('gather:summary-requested', { annotationId: reference, resourceId: source });

      expect(response.summary).toBe('The passage names a wading bird.');
      expect(response.relevantFields).toMatchObject({ resourceName: 'A heron between two runs of letters', entityTypes: ['Bird'] });
      // Two hundred on each side: the end of what is before, and the start of what is after.
      expect(response.context).toEqual({ before: text.slice(at - 200, at), selected: 'heron', after: text.slice(end, end + 200) });

      // The one prompt its model saw quotes the selection, and names the resource.
      const asked = prompts(world().gatherer);
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain('heron');
      expect(asked[0]).toContain('A heron between two runs of letters');
      expect(world().gatherer.generations[0]?.body['model']).toBe(GATHERER_MODEL);
    });

    it('fails for an annotation the record does not hold, and asks its model nothing', async () => {
      const source = await world().created(FOX, { name: 'A fox and a dog' });
      await world().ready(source);

      const failure = await world().failed('gather:summary-requested', { annotationId: 'no-such-annotation', resourceId: source });

      expect(failure.message).toMatch(/annotation/i);
      expect(world().gatherer.generations).toEqual([]);
    });
  });

  describe('for two annotations of one resource', () => {
    it('answers the gathers for one resource one after the other, and does not hold a gather for another resource behind them', async () => {
      const source = await world().created(FOX, { name: 'A text of nine words' });
      const other = await world().created(TIDE, { name: 'A text of nine more' });
      const first = await world().highlighted(source, 'quick');
      const second = await world().highlighted(source, 'lazy');
      const elsewhere = await world().highlighted(other, 'marsh');
      await world().ready(source, other);

      // Each gather makes one generation, about the word its highlight selects. The first is held.
      world().gatherer.choose = (body) => {
        const prompt = String(body['prompt']);
        if (prompt.includes('quick')) return { hold: true };
        if (prompt.includes('lazy')) return { response: 'The second gather of the resource.' };
        if (prompt.includes('marsh')) return { response: 'A gather of another resource.' };
        return undefined;
      };
      const about = (word: string) => prompts(world().gatherer).filter((prompt) => prompt.includes(word));

      const held = world().ask('gather:requested', { annotationId: first, resourceId: source });
      await world().gatherer.asked(1);
      const behind = world().ask('gather:requested', { annotationId: second, resourceId: source });

      // While the first is held, a gather for another resource is answered, and then another: time enough for the
      // second gather of the first resource to have asked its model, were it not waiting.
      for (let round = 0; round < 2; round += 1) {
        const reply = await world().answered('gather:requested', { annotationId: elsewhere, resourceId: other });
        expect(reply.response.inferredRelationshipSummary).toBe('A gather of another resource.');
      }
      expect(about('quick')).toHaveLength(1);
      expect(about('marsh')).toHaveLength(2);
      expect(about('lazy')).toEqual([]);

      // Released, the first is answered, and only then is the second's generation asked for.
      world().gatherer.release({ response: 'The first gather of the resource.' });
      const [one, two] = await Promise.all([held, behind]);
      if (!one.ok || !two.ok) throw new Error(`a gather failed, and both should have been answered: ${JSON.stringify([one, two]).slice(0, 400)}`);
      expect(one.reply.annotationId).toBe(first);
      expect(one.reply.response.inferredRelationshipSummary).toBe('The first gather of the resource.');
      expect(two.reply.annotationId).toBe(second);
      expect(two.reply.response.inferredRelationshipSummary).toBe('The second gather of the resource.');
      expect(about('lazy')).toHaveLength(1);
      expect(prompts(world().gatherer).at(-1)).toContain('lazy');
    });
  });
});
