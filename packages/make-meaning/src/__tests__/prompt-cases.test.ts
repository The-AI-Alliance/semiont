/**
 * The Librarian's five prompts, held to specs/src/librarian/prompt-cases.json:
 * what each is made from, and its text, token limit and temperature.
 *
 * Two of the five are functions, and are called. The other three are written
 * inside the Matcher and the annotation gather, and are reached the way a
 * caller reaches them: a search over the bus, a gather, a summary. The stores
 * those read are made from the case's plain values, and a client that records
 * what it is asked stands where the model would.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { firstValueFrom } from 'rxjs';
import {
  EventBus,
  annotationId,
  resourceId,
  type Annotation,
  type GatheredContext,
  type Logger,
  type ResourceDescriptor,
  type components,
} from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { MockInferenceClient } from '@semiont/inference';
import { Matcher, type MatcherStores } from '../matcher';
import { AnnotationGather, type AnnotationGatherReads } from '../annotation-gather';
import { generateResourceSummary, generateReferenceSuggestions } from '../generation/resource-generation';
import { createRecordFixture, type RecordFixture } from './helpers/record-fixtures';
import { createMockEmbeddingProvider } from './helpers/embedding-provider';

type TextualBody = components['schemas']['TextualBody'];
type TextPositionSelector = components['schemas']['TextPositionSelector'];

/** A text, or the pieces of a long one: a piece is a string, or a string written a number of times. */
type Text = string | Array<string | { repeat: string; times: number }>;

interface ScoreFrom {
  selected?: string;
  hint?: string;
  motivation: Annotation['motivation'];
  source: string;
  body?: string;
  entityTypes: string[];
  connected: string[];
  relationship?: string;
  candidates: Array<{ id: string; name: string; entityTypes: string[] }>;
}

interface RelationshipFrom {
  passage: string;
  connected: string[];
  citedBy: string[];
  siblingEntityTypes: string[];
  entityTypes: string[];
}

interface ResourceSummaryFrom {
  name: string;
  content: Text;
  entityTypes: string[];
}

interface ReferenceSuggestionsFrom {
  title: string;
  entityType?: string;
  stub?: Text;
}

interface AnnotationSummaryFrom {
  resource: string;
  before: Text;
  selected: Text;
  after: Text;
  entityTypes: string[];
}

type Case = { why: string; text: Text; maxTokens: number; temperature: number } & (
  | { prompt: 'score'; from: ScoreFrom }
  | { prompt: 'relationship'; from: RelationshipFrom }
  | { prompt: 'resource-summary'; from: ResourceSummaryFrom }
  | { prompt: 'reference-suggestions'; from: ReferenceSuggestionsFrom }
  | { prompt: 'annotation-summary'; from: AnnotationSummaryFrom }
);

const table: { cases: Case[] } = JSON.parse(
  readFileSync(new URL('../../../../specs/src/librarian/prompt-cases.json', import.meta.url), 'utf8'),
);

const textOf = (text: Text): string =>
  typeof text === 'string'
    ? text
    : text.map((piece) => (typeof piece === 'string' ? piece : piece.repeat.repeat(piece.times))).join('');

/** An offset counts code points, and so does the length of a text measured for one. */
const codePoints = (text: string): number => Array.from(text).length;

const AT = '2026-01-01T00:00:00.000Z';

const silent: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silent,
};

const described = (id: string, name: string, entityTypes: string[] = []): ResourceDescriptor => ({
  '@context': 'https://schema.org/',
  '@id': resourceId(id),
  name,
  entityTypes,
  representations: [],
});

/** An annotation on `on`, of a span of it where one is given, stating each entity type as a body that tags. */
function annotationOn(id: string, on: string, entityTypes: string[], span?: { start: number; end: number }): Annotation {
  const tags: TextualBody[] = entityTypes.map((value) => ({ type: 'TextualBody', value, purpose: 'tagging' }));
  const selector: TextPositionSelector | undefined = span
    ? { type: 'TextPositionSelector', start: span.start, end: span.end }
    : undefined;
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId(id),
    motivation: 'linking',
    created: AT,
    target: selector ? { source: resourceId(on), selector } : { source: resourceId(on) },
    ...(tags.length > 0 ? { body: tags } : {}),
  };
}

/**
 * The score prompt: a search asked of a Matcher over its bus. The name search
 * answers the case's candidates and every other source answers none, so the
 * candidates scored are the case's.
 */
async function scorePrompt(from: ScoreFrom, client: MockInferenceClient): Promise<void> {
  const main = resourceId('res-source');
  const candidates = from.candidates.map((c) => described(c.id, c.name, c.entityTypes));

  const body: TextualBody | undefined = from.body === undefined ? undefined : { type: 'TextualBody', value: from.body };
  const annotation: Annotation = {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'Annotation',
    id: annotationId('ann-reference'),
    motivation: from.motivation,
    created: AT,
    target: { source: main },
    ...(body ? { body } : {}),
  };

  // A connection is an edge out of the annotation's resource, named by the node it ends on.
  const nodes: GatheredContext['graph']['nodes'] = [{ id: main, type: 'resource', label: from.source }];
  const edges: GatheredContext['graph']['edges'] = [];
  from.connected.forEach((name, i) => {
    const peer = resourceId(`res-connected-${i + 1}`);
    nodes.push({ id: peer, type: 'resource', label: name });
    edges.push({ source: main, target: peer, type: 'link' });
  });

  const context: GatheredContext = {
    focus: {
      kind: 'annotation',
      annotation,
      sourceResource: described('res-source', from.source),
      ...(from.selected === undefined ? {} : { selected: { text: from.selected } }),
      ...(from.hint === undefined ? {} : { userHint: from.hint }),
    },
    graph: { nodes, edges },
    metadata: { entityTypes: from.entityTypes },
    ...(from.relationship === undefined ? {} : { inferredRelationshipSummary: from.relationship }),
  };

  const request = { resourceId: main, referenceId: annotation.id, context };
  const validate = validators.MatchSearchRequest;
  if (!validate(request)) throw new Error(`the case is not a search the bus carries: ${formatErrors(validate.errors)}`);

  const stores: MatcherStores = {
    graph: {
      listResources: async (filter) => {
        const resources = filter.search === undefined ? [] : candidates;
        return { resources, total: resources.length };
      },
      getResource: async () => null,
    },
    views: { get: async () => null },
    vectors: { searchResources: async () => [] },
  };

  const bus = new EventBus();
  const matcher = new Matcher(stores, bus, silent, client, createMockEmbeddingProvider());
  await matcher.initialize();
  try {
    const answered = firstValueFrom(bus.on('match:search-results'));
    const failed = firstValueFrom(bus.on('match:search-failed')).then(({ error }) => {
      throw new Error(`the search failed: ${error}`);
    });
    bus.emit('match:search-requested', request, { correlationId: 'prompt-case' });
    await Promise.race([answered, failed]);
  } finally {
    await matcher.stop();
    bus.destroy();
  }
}

/**
 * The relationship prompt: a gather of an annotation's context. The resource
 * and the resources that cite it are kept as views, with their annotations;
 * the graph answers the connections, the citing annotations and the
 * annotations on the resource.
 * The annotation's body has no link, so the gather asks the model nothing else.
 */
async function relationshipPrompt(id: string, from: RelationshipFrom, record: RecordFixture, client: MockInferenceClient): Promise<void> {
  const lead = 'It is written of ';
  await record.resource(id, { name: 'The annotated resource', text: `${lead}${from.passage}, and of more besides.` });
  const start = codePoints(lead);
  const focal = annotationOn(`${id}-focal`, id, from.entityTypes, { start, end: start + codePoints(from.passage) });
  const siblings = from.siblingEntityTypes.map((entityType, i) => annotationOn(`${id}-sibling-${i + 1}`, id, [entityType]));
  await record.annotate(id, focal, ...siblings);

  const citing: Annotation[] = [];
  for (let i = 0; i < from.citedBy.length; i++) {
    const citer = `${id}-citer-${i + 1}`;
    const citation: Annotation = {
      ...annotationOn(`${id}-citing-${i + 1}`, citer, []),
      body: { type: 'SpecificResource', source: resourceId(id), purpose: 'linking' },
    };
    await record.resource(citer, { name: from.citedBy[i] });
    await record.annotate(citer, citation);
    citing.push(citation);
  }

  const kb: AnnotationGatherReads = {
    views: record.views,
    content: record.content,
    anchoredText: async () => ({ kind: 'unknown' }),
    graph: {
      getResource: async (asked) => (await record.views.get(asked))?.resource ?? null,
      getResourceConnections: async () =>
        from.connected.map((name, i) => ({
          targetResource: described(`${id}-peer-${i + 1}`, name),
          annotations: [],
          bidirectional: false,
        })),
      getResourceReferencedBy: async () => citing,
      getResourceAnnotations: async () => [focal, ...siblings],
      getEntityTypeStats: async () => [],
    },
    vectors: { searchAnnotations: async () => [] },
    weaveProgress: { whenApplied: async () => {} },
  };

  await AnnotationGather.buildLLMContext(focal.id, resourceId(id), kb, createMockEmbeddingProvider(), {}, client, silent);
}

/** The annotation's summary prompt: a summary asked of an annotation whose resource's text is the case's three parts. */
async function annotationSummaryPrompt(id: string, from: AnnotationSummaryFrom, record: RecordFixture, client: MockInferenceClient): Promise<void> {
  const before = textOf(from.before);
  const selected = textOf(from.selected);
  await record.resource(id, { name: from.resource, text: before + selected + textOf(from.after) });
  const start = codePoints(before);
  const annotation = annotationOn(`${id}-focal`, id, from.entityTypes, { start, end: start + codePoints(selected) });
  await record.annotate(id, annotation);

  await AnnotationGather.generateAnnotationSummary(
    annotation.id,
    resourceId(id),
    { views: record.views, content: record.content, anchoredText: async () => ({ kind: 'unknown' }) },
    client,
  );
}

async function send(c: Case, id: string, record: RecordFixture, client: MockInferenceClient): Promise<void> {
  switch (c.prompt) {
    case 'score':
      await scorePrompt(c.from, client);
      return;
    case 'relationship':
      await relationshipPrompt(id, c.from, record, client);
      return;
    case 'resource-summary':
      await generateResourceSummary(c.from.name, textOf(c.from.content), c.from.entityTypes, client);
      return;
    case 'reference-suggestions':
      await generateReferenceSuggestions(
        { title: c.from.title, entityType: c.from.entityType, stub: c.from.stub === undefined ? undefined : textOf(c.from.stub) },
        client,
      );
      return;
    case 'annotation-summary':
      await annotationSummaryPrompt(id, c.from, record, client);
      return;
  }
}

describe("the Librarian's prompts (specs/src/librarian/prompt-cases.json)", () => {
  let record: RecordFixture;

  beforeAll(async () => {
    record = await createRecordFixture();
  });

  afterAll(async () => {
    await record.teardown();
  });

  it('has cases', () => {
    expect(table.cases.length).toBeGreaterThan(0);
  });

  table.cases.forEach((c, index) => {
    it(`${c.prompt}: ${c.why}`, async () => {
      const client = new MockInferenceClient();
      await send(c, `prompt-case-${index}`, record, client);
      expect(client.calls).toStrictEqual([
        { prompt: textOf(c.text), maxTokens: c.maxTokens, temperature: c.temperature },
      ]);
    });
  });
});
