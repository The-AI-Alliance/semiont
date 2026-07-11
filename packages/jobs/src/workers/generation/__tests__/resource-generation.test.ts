/**
 * Resource Generation — prompt-builder tests.
 *
 * The sole test home for `generateResourceFromTopic` (CONTEXT-UNIFICATION P5
 * consolidated the former make-meaning `generation/resource-generation.test.ts`
 * and the jobs `resource-generation.prompt.test.ts` into this one co-located
 * file). Calls the real builder against a `MockInferenceClient` and inspects the
 * prompt captured at the inference boundary.
 *
 * Fixtures use the unified `GatheredContext` (discriminated `focus` + shared
 * `graph`). The graph-derived prompt sections (connections, citedBy, siblings)
 * are exercised by building a `KnowledgeGraph` via `buildGraph` so the builder's
 * `deriveViews(graph, mainId, focalAnnotationId)` reproduces them — mirroring the
 * P4 matcher.test.ts pattern.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockInferenceClient } from '@semiont/inference';
import type { GatheredContext, Logger } from '@semiont/core';
import { generateResourceFromTopic } from '../resource-generation';

type AnnotationFocus = Extract<GatheredContext['focus'], { kind: 'annotation' }>;
type ResourceFocus = Extract<GatheredContext['focus'], { kind: 'resource' }>;
type KnowledgeGraph = GatheredContext['graph'];
type SemanticMatch = NonNullable<GatheredContext['semanticContext']>['similar'][number];

/** Resource id every fixture's graph is anchored on; equals `getResourceId(focus.sourceResource)`. */
const MAIN_ID = 'test-resource';

const testAnnotation: AnnotationFocus['annotation'] = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: 'test-annotation',
  motivation: 'commenting',
  target: { source: MAIN_ID },
  body: [{ type: 'TextualBody', value: 'test comment', purpose: 'commenting' }],
};

const testSourceResource: AnnotationFocus['sourceResource'] = {
  '@context': 'https://www.w3.org/ns/anno.jsonld',
  '@id': MAIN_ID,
  name: 'Test Resource',
  representations: [],
  archived: false,
  dateCreated: '2026-01-01T00:00:00Z',
};

/**
 * Build a `KnowledgeGraph` anchored on MAIN_ID so `deriveViews(graph, MAIN_ID, focalId)`
 * reproduces the flattened signals the prompt builder reads:
 * - `connections`: main→peer `related` edges (peer resource nodes), carrying `bidirectional`.
 * - `citedBy`/`citedByCount`: inbound `citation` edges. `citedByMissing` = an edge with no node
 *   (a missing-view citer — still counted, per P3/P4 (ii)=A).
 * - `siblingEntityTypes`: annotation nodes attached to the resource (focal excluded by deriveViews).
 */
function buildGraph(opts: {
  connections?: Array<{ resourceId: string; resourceName: string; bidirectional?: boolean; entityTypes?: string[] }>;
  citedByPresent?: Array<{ resourceId: string; resourceName: string }>;
  citedByMissing?: string[];
  siblingAnnotations?: Array<{ id: string; entityTypes?: string[] }>;
} = {}): KnowledgeGraph {
  const nodes: KnowledgeGraph['nodes'] = [{ id: MAIN_ID, type: 'resource', label: 'Test Resource' }];
  const edges: KnowledgeGraph['edges'] = [];

  for (const c of opts.connections ?? []) {
    nodes.push({ id: c.resourceId, type: 'resource', label: c.resourceName, entityTypes: c.entityTypes });
    edges.push({ source: MAIN_ID, target: c.resourceId, type: 'related', bidirectional: c.bidirectional ?? false });
  }
  for (const c of opts.citedByPresent ?? []) {
    nodes.push({ id: c.resourceId, type: 'resource', label: c.resourceName });
    edges.push({ source: c.resourceId, target: MAIN_ID, type: 'citation' });
  }
  for (const id of opts.citedByMissing ?? []) {
    edges.push({ source: id, target: MAIN_ID, type: 'citation' });
  }
  for (const a of opts.siblingAnnotations ?? []) {
    nodes.push({ id: a.id, type: 'annotation', label: a.id, entityTypes: a.entityTypes });
    edges.push({ source: a.id, target: MAIN_ID, type: 'annotation-of' });
  }
  return { nodes, edges };
}

/** Build a unified GatheredContext with an annotation focus. */
function makeContext(overrides: {
  annotation?: AnnotationFocus['annotation'];
  selected?: { before?: string; text: string; after?: string };
  userHint?: string;
  metadata?: GatheredContext['metadata'];
  graph?: KnowledgeGraph;
  semanticContext?: SemanticMatch[];
  inferredRelationshipSummary?: string;
} = {}): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation: overrides.annotation ?? testAnnotation,
      sourceResource: testSourceResource,
      ...(overrides.selected ? { selected: overrides.selected } : {}),
      ...(overrides.userHint !== undefined ? { userHint: overrides.userHint } : {}),
    },
    graph: overrides.graph ?? buildGraph(),
    metadata: overrides.metadata ?? {},
    ...(overrides.semanticContext ? { semanticContext: { similar: overrides.semanticContext } } : {}),
    ...(overrides.inferredRelationshipSummary !== undefined
      ? { inferredRelationshipSummary: overrides.inferredRelationshipSummary }
      : {}),
  };
}

/** Build a unified GatheredContext with a resource focus (the shared base still applies). */
function makeResourceContext(overrides: {
  resource?: ResourceFocus['resource'];
  graph?: KnowledgeGraph;
  semanticContext?: SemanticMatch[];
  inferredRelationshipSummary?: string;
} = {}): GatheredContext {
  return {
    focus: {
      kind: 'resource',
      resource: overrides.resource ?? testSourceResource,
    },
    graph: overrides.graph ?? buildGraph(),
    metadata: {},
    ...(overrides.semanticContext ? { semanticContext: { similar: overrides.semanticContext } } : {}),
    ...(overrides.inferredRelationshipSummary !== undefined
      ? { inferredRelationshipSummary: overrides.inferredRelationshipSummary }
      : {}),
  };
}

const LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => LOGGER,
};

const client = new MockInferenceClient(['']);

/** The prompt string the builder handed to inference. */
function promptArg(): string {
  return client.calls[0].prompt;
}

describe('generateResourceFromTopic', () => {
  beforeEach(() => {
    client.reset();
  });

  // ── Basics: title/content, parsing, params ─────────────────────────────────

  it('should generate resource with title and content', async () => {
    client.setResponses([
      '# Quantum Computing\n\nQuantum computing is a revolutionary technology. It uses quantum mechanics principles.',
    ]);

    const result = await generateResourceFromTopic('Quantum Computing', [], client, LOGGER);

    expect(result.title).toBe('Quantum Computing');
    expect(result.content).toContain('Quantum computing');
  });

  // NOTE: the function uses the topic parameter as the title rather than extracting it
  // from the markdown heading — intentional (see resource-generation.ts). Kept as a skipped
  // record of the alternative (AI-generated titles overriding the topic).
  it.skip('should extract title from markdown heading', async () => {
    client.setResponses(['# Machine Learning Basics\n\nMachine learning is a subset of AI.']);

    const result = await generateResourceFromTopic('Machine Learning', [], client, LOGGER);

    expect(result.title).toBe('Machine Learning Basics');
  });

  it('should handle markdown code fences', async () => {
    client.setResponses(['```markdown\n# Neural Networks\n\nNeural networks are computational models.\n```']);

    const result = await generateResourceFromTopic('Neural Networks', [], client, LOGGER);

    expect(result.title).toBe('Neural Networks');
    expect(result.content).toContain('Neural networks are computational models');
    expect(result.content).not.toContain('```');
  });

  it('should handle ```md code fence variant', async () => {
    client.setResponses(['```md\n# Short Syntax\n\nTesting the md variant.\n```']);

    const result = await generateResourceFromTopic('Markdown Variant', [], client, LOGGER);

    expect(result.title).toBe('Markdown Variant');
    expect(result.content).not.toContain('```md');
    expect(result.content).toContain('Short Syntax');
  });

  it('should handle response without markdown heading', async () => {
    client.setResponses(['Just some plain text without a heading. This should still work.']);

    const result = await generateResourceFromTopic('No Heading Topic', [], client, LOGGER);

    expect(result.title).toBe('No Heading Topic');
    expect(result.content).toContain('Just some plain text');
  });

  it('should trim whitespace from generated content', async () => {
    client.setResponses(['\n\n  # Whitespace Test  \n\nContent with extra spaces.   \n\n']);

    const result = await generateResourceFromTopic('Whitespace', [], client, LOGGER);

    expect(result.content.startsWith('\n\n')).toBe(false);
    expect(result.content.endsWith('\n\n')).toBe(false);
    expect(result.content).toContain('Whitespace Test');
  });

  it('should include entity types in generation', async () => {
    client.setResponses(['# AI Ethics\n\nAI ethics examines moral implications.']);

    await generateResourceFromTopic('AI Ethics', ['Person', 'Organization'], client, LOGGER);

    const prompt = promptArg();
    expect(prompt).toContain('Person');
    expect(prompt).toContain('Organization');
  });

  it('should handle user prompt', async () => {
    client.setResponses(['# Data Privacy\n\nData privacy protects personal information.']);

    await generateResourceFromTopic('Data Privacy', [], client, LOGGER, 'Focus on GDPR compliance');

    expect(promptArg()).toContain('GDPR compliance');
  });

  it('should pass temperature and maxTokens to inference', async () => {
    client.setResponses(['# Test Resource\n\nTest content here.']);

    await generateResourceFromTopic('Test Topic', [], client, LOGGER, undefined, undefined, undefined, 0.9, 1000);

    expect(client.calls[0].temperature).toBe(0.9);
    expect(client.calls[0].maxTokens).toBe(1000);
  });

  it('should use default temperature and maxTokens when not provided', async () => {
    client.setResponses(['# Default Settings\n\nUsing default parameters.']);

    await generateResourceFromTopic('Default Test', [], client, LOGGER);

    expect(client.calls[0].temperature).toBe(0.7);
    expect(client.calls[0].maxTokens).toBe(500);
  });

  // ── Locale handling ────────────────────────────────────────────────────────

  it('should include body-locale guidance for a non-English locale', async () => {
    client.setResponses(["# Apprentissage Automatique\n\nL'apprentissage automatique est une branche de l'IA."]);

    await generateResourceFromTopic('Machine Learning', [], client, LOGGER, undefined, 'fr');

    expect(promptArg()).toContain('French');
  });

  it('should include sourceLanguage guidance independently from body locale', async () => {
    client.setResponses(['# Maschinelles Lernen\n\nText.']);

    await generateResourceFromTopic(
      'Machine Learning', [], client, LOGGER,
      undefined, 'de', undefined, undefined, undefined, 'fr',
    );

    const prompt = promptArg();
    expect(prompt).toContain('Write the entire resource in German');
    expect(prompt).toContain('source resource and embedded context are in French');
  });

  it('should omit sourceLanguage guidance when not provided', async () => {
    client.setResponses(['# Topic\n\nText.']);

    await generateResourceFromTopic('Topic', [], client, LOGGER);

    expect(promptArg()).not.toContain('source resource and embedded context are in');
  });

  // ── Annotation focus: source context + annotation section ────────────────────

  it('should include source document context and the comment body', async () => {
    client.setResponses(['# Deep Learning\n\nDeep learning uses neural networks.']);

    await generateResourceFromTopic(
      'Deep Learning', [], client, LOGGER, undefined, undefined,
      makeContext({
        selected: { before: 'Machine learning includes', text: 'deep learning', after: 'as a powerful technique' },
      }),
    );

    const prompt = promptArg();
    expect(prompt).toContain('Source document context');
    expect(prompt).toContain('deep learning');
    expect(prompt).toContain('Machine learning includes');
    // commenting-motivation annotation surfaces its body
    expect(prompt).toContain('Comment: test comment');
  });

  // ── Annotation focus: graph-derived sections (via deriveViews over `graph`) ───

  describe('graph context in prompt', () => {
    it('should include connections in prompt', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Zeus', ['Person'], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Zeus' },
          graph: buildGraph({
            connections: [
              { resourceId: 'r1', resourceName: 'Mount Olympus', entityTypes: ['Location'] },
              { resourceId: 'r2', resourceName: 'Hera', entityTypes: ['Person', 'Deity'], bidirectional: true },
            ],
          }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Knowledge graph context');
      expect(prompt).toContain('Connected resources');
      expect(prompt).toContain('Mount Olympus (Location)');
      expect(prompt).toContain('Hera (Person, Deity)');
    });

    it('should include citedBy in prompt', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Prometheus', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Prometheus' },
          graph: buildGraph({
            citedByPresent: [
              { resourceId: 'c1', resourceName: 'Prometheus Bound' },
              { resourceId: 'c2', resourceName: 'Theogony' },
            ],
          }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('cited by 2 other resources');
      expect(prompt).toContain('Prometheus Bound');
      expect(prompt).toContain('Theogony');
    });

    it('should use singular "resource" for a single citer', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Icarus', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Icarus' },
          graph: buildGraph({ citedByPresent: [{ resourceId: 'c1', resourceName: 'Metamorphoses' }] }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('cited by 1 other resource');
      expect(prompt).not.toContain('cited by 1 other resources');
    });

    it('should count a missing-view citer (P3 (ii)=A)', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Atlas', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Atlas' },
          graph: buildGraph({
            citedByPresent: [{ resourceId: 'c1', resourceName: 'Theogony' }],
            citedByMissing: ['c-missing'],
          }),
        }),
      );

      // edge with no node still counts: 2 citations total.
      expect(promptArg()).toContain('cited by 2 other resources');
    });

    it('should include siblingEntityTypes in prompt', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Athens', ['Location'], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Athens' },
          graph: buildGraph({ siblingAnnotations: [{ id: 'sib1', entityTypes: ['Person', 'Event', 'Organization'] }] }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Related entity types');
      expect(prompt).toContain('Person');
      expect(prompt).toContain('Event');
      expect(prompt).toContain('Organization');
    });

    it('should exclude the focal annotation from siblingEntityTypes', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Focal', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Focal' },
          graph: buildGraph({
            siblingAnnotations: [
              { id: 'test-annotation', entityTypes: ['ShouldBeExcluded'] }, // the focal annotation id
              { id: 'sib1', entityTypes: ['Kept'] },
            ],
          }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Kept');
      expect(prompt).not.toContain('ShouldBeExcluded');
    });

    it('should include inferredRelationshipSummary in prompt', async () => {
      client.setResponses(['# Test\n\nContent.']);
      const summary = 'This passage relates to the mythology section, connecting several deity resources.';

      await generateResourceFromTopic(
        'Zeus', [], client, LOGGER, undefined, undefined,
        makeContext({ selected: { text: 'Zeus' }, inferredRelationshipSummary: summary }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Relationship summary');
      expect(prompt).toContain(summary);
    });

    it('should omit graph context section when the graph yields no signals', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Orphan', [], client, LOGGER, undefined, undefined,
        makeContext({ selected: { text: 'Orphan' } }), // empty buildGraph() default
      );

      expect(promptArg()).not.toContain('Knowledge graph context');
    });

    it('should handle connections without entityTypes', async () => {
      client.setResponses(['# Test\n\nContent.']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Topic' },
          graph: buildGraph({ connections: [{ resourceId: 'r1', resourceName: 'Untitled' }] }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Untitled');
      expect(prompt).not.toContain('()');
    });
  });

  // ── Shared base: semanticContext (RAG) ───────────────────────────────────────

  describe('semanticContext in prompt', () => {
    it('embeds semanticContext passages into the generation prompt', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({ semanticContext: [{ text: 'NEEDLE-PASSAGE', resourceId: 'r1', score: 0.82 }] }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('NEEDLE-PASSAGE');
      expect(prompt).toMatch(/related passages/i);
    });

    it('omits the related-passages section when semanticContext is absent', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, makeContext());

      expect(promptArg()).not.toMatch(/related passages/i);
    });

    it('omits the related-passages section when similar is empty', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({ semanticContext: [] }),
      );

      expect(promptArg()).not.toMatch(/related passages/i);
    });

    it('caps related passages at top-3 by score and truncates long passages', async () => {
      client.setResponses(['# X\n\nbody']);
      const long = 'X'.repeat(400);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({
          semanticContext: [
            { text: 'p-low-1', resourceId: 'r', score: 0.10 },
            { text: 'p-low-2', resourceId: 'r', score: 0.11 },
            { text: 'p-mid', resourceId: 'r', score: 0.50 },
            { text: 'p-hi', resourceId: 'r', score: 0.90 },
            { text: long, resourceId: 'r', score: 0.95 },
          ],
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('p-hi');
      expect(prompt).toContain('p-mid');
      expect(prompt).not.toContain('p-low-1');
      expect(prompt).not.toContain('p-low-2');
      expect(prompt).toContain('X'.repeat(240));
      expect(prompt).not.toContain(long);
    });
  });

  // ── Context identifiers (CONTEXT-IDENTIFIERS P1) — every excerpt carries a
  // stable, model-visible [<resourceId>] handle; annotation-derived semantic
  // matches add /<annotationId>. Same bracket convention as related-content blocks.

  describe('context identifiers', () => {
    it('semantic passages carry their source resourceId', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({ semanticContext: [{ text: 'NEEDLE', resourceId: 'sem-src-1', score: 0.8 }] }),
      );

      expect(promptArg()).toContain('[sem-src-1]');
    });

    it('annotation-derived semantic passages add the annotationId as a suffix', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({
          semanticContext: [{ text: 'NEEDLE', resourceId: 'sem-src-1', annotationId: 'ann-7', score: 0.8 }],
        }),
      );

      expect(promptArg()).toContain('[sem-src-1/ann-7]');
    });

    it('graph connections carry name + [resourceId]', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Topic' },
          graph: buildGraph({
            connections: [
              { resourceId: 'conn-1', resourceName: 'Olympus' },
              { resourceId: 'conn-2', resourceName: 'Hera', entityTypes: ['Person'] },
            ],
          }),
        }),
      );

      const prompt = promptArg();
      expect(prompt).toContain('Olympus [conn-1]');
      expect(prompt).toContain('Hera (Person) [conn-2]');
    });

    it('citedBy entries carry name + [resourceId]', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeContext({
          selected: { text: 'Topic' },
          graph: buildGraph({ citedByPresent: [{ resourceId: 'cit-1', resourceName: 'Theogony' }] }),
        }),
      );

      expect(promptArg()).toContain('Theogony [cit-1]');
    });

    it('the focal resource line carries its [@id] (resource focus)', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, makeResourceContext());

      expect(promptArg()).toContain('Resource: Test Resource [test-resource]');
    });

    it('the source-resource line carries its [@id] (annotation focus)', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, makeContext());

      expect(promptArg()).toContain('Source resource: Test Resource [test-resource]');
    });
  });

  // ── Resource focus (P5: focus.kind switch; full grounding is YIELD-FROM-RESOURCE) ─

  describe('resource focus', () => {
    it('renders the shared base and omits the annotation-only sections', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined,
        makeResourceContext({ semanticContext: [{ text: 'SHARED-PASSAGE', resourceId: 'r9', score: 0.9 }] }),
      );

      const prompt = promptArg();
      // shared base still renders for a resource focus
      expect(prompt).toContain('Related passages from the knowledge base');
      expect(prompt).toContain('SHARED-PASSAGE');
      // annotation-only sections must not appear (no focus.annotation to read)
      expect(prompt).not.toContain('Annotation motivation');
      expect(prompt).not.toContain('Source document context');
    });

    it('grounds the prompt in the resource summary, suggested references, and content', async () => {
      client.setResponses(['# X\n\nbody']);
      const context: GatheredContext = {
        focus: {
          kind: 'resource',
          resource: testSourceResource,
          summary: 'A concise summary of the focal resource.',
          suggestedReferences: ['Alpha', 'Beta'],
          content: { main: 'MAIN-CONTENT-BODY', related: { r2: 'RELATED-CONTENT-BODY' } },
        },
        graph: buildGraph(),
        metadata: {},
      };

      await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, context);

      const prompt = promptArg();
      expect(prompt).toContain('A concise summary of the focal resource.');
      expect(prompt).toContain('Alpha');
      expect(prompt).toContain('MAIN-CONTENT-BODY');
      expect(prompt).toContain('RELATED-CONTENT-BODY');
      expect(prompt).not.toContain('Annotation motivation');
    });

    it('omits resource sections that are absent (omit-empty)', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER, undefined, undefined, makeResourceContext());

      const prompt = promptArg();
      expect(prompt).not.toContain('Summary:');
      expect(prompt).not.toContain('Resource content:');
    });
  });

  // ── task / structure — explicit output-shape control (YIELD-STRUCTURE P1) ────
  // Positional signature tail: (..., sourceLanguage, outputMediaType, task, structure).

  describe('task framing and structure control', () => {
    function makeWarnLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
      const warn = vi.fn();
      const logger: Logger = { debug: () => {}, info: () => {}, warn, error: () => {}, child: () => logger };
      return { logger, warn };
    }

    it('task "answer" leads with answer framing and, with structure unset, forces no scaffolding', async () => {
      client.setResponses(['The answer.']);

      await generateResourceFromTopic(
        'What is the capital of France?', [], client, LOGGER,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        'answer',
      );

      const prompt = promptArg();
      expect(prompt).toMatch(/^Answer/);
      expect(prompt).not.toContain('informative resource about');
      // D2: structure unset ⇒ no structure directive, no forced heading
      expect(prompt).not.toContain('# Title');
      expect(prompt).not.toContain('## Section');
    });

    it('elevates the caller prompt to an Instruction, not "Additional context:"', async () => {
      client.setResponses(['The answer.']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER,
        'Ground every claim in the provided context',
        undefined, undefined, undefined, undefined, undefined, undefined,
        'answer',
      );

      const prompt = promptArg();
      expect(prompt).toContain('Instruction: Ground every claim in the provided context');
      expect(prompt).not.toContain('Additional context:');
    });

    it('structure "prose" beats a generous token budget (explicit beats budget)', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER,
        undefined, undefined, undefined, undefined, 2000, undefined, undefined,
        undefined, 'prose',
      );

      expect(promptArg()).not.toContain('## Section');
    });

    it('structure "sections" beats a small token budget', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER,
        undefined, undefined, undefined, undefined, 400, undefined, undefined,
        undefined, 'sections',
      );

      const prompt = promptArg();
      expect(prompt).toContain('titled sections');
      expect(prompt).toContain('# Title');
    });

    it('defaults (task and structure unset) keep the resource framing but impose NO structure directive', async () => {
      // Declared behavior change (D2): today's template always forces # Title +
      // a structure-guidance clause; unset now means neither is emitted.
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER);

      const prompt = promptArg();
      expect(prompt).toContain('informative resource about');
      expect(prompt).not.toContain('# Title');
      expect(prompt).not.toContain('organized into');
    });

    it('structure "chat" is canonical — conversational-turns guidance, no warn, no forced heading', async () => {
      const { logger, warn } = makeWarnLogger();
      client.setResponses(['**Q:** …\n**A:** …']);

      await generateResourceFromTopic(
        'Topic', [], client, logger,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, 'chat',
      );

      const prompt = promptArg();
      expect(prompt).toMatch(/conversational|chat transcript/i);
      expect(prompt).not.toContain('Organize the output as:'); // canonical, not the unknown-string passthrough
      expect(prompt).not.toContain('# Title');
      expect(warn).not.toHaveBeenCalled();
    });

    it('an unknown task string is used verbatim as the framing instruction, with a warn', async () => {
      const { logger, warn } = makeWarnLogger();
      client.setResponses(['La réponse.']);

      await generateResourceFromTopic(
        'Topic', [], client, logger,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        'Translate the source into idiomatic French',
      );

      expect(promptArg().startsWith('Translate the source into idiomatic French')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('an unknown structure string becomes a freeform organization instruction, with a warn and no forced heading', async () => {
      const { logger, warn } = makeWarnLogger();
      client.setResponses(['- a\n- b']);

      await generateResourceFromTopic(
        'Topic', [], client, logger,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        undefined, 'a bulleted list of key facts',
      );

      const prompt = promptArg();
      expect(prompt).toContain('Organize the output as: a bulleted list of key facts');
      expect(prompt).not.toContain('# Title');
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  describe('output media type', () => {
    it('text/markdown (default) instructs markdown formatting', async () => {
      client.setResponses(['# X\n\nbody']);

      await generateResourceFromTopic('Topic', [], client, LOGGER);

      expect(promptArg()).toMatch(/markdown/i);
    });

    it('text/plain drops the markdown scaffolding and asks for plain prose', async () => {
      client.setResponses(['X\n\nbody']);

      await generateResourceFromTopic(
        'Topic', [], client, LOGGER, undefined, undefined, undefined, undefined, undefined, undefined, 'text/plain',
      );

      const prompt = promptArg();
      expect(prompt).not.toMatch(/markdown/i);
      expect(prompt).not.toContain('# Title');
      expect(prompt).toMatch(/plain text/i);
    });
  });
});
