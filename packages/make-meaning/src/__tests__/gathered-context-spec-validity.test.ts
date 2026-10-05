/**
 * A gathered context validates against the spec `/bus/emit` enforces.
 *
 * A source-only annotation has no `selector`. A store that manufactures one —
 * writing `'{}'` and reading back `{}` — yields a value that satisfies no
 * branch of the selector union, and the wizard's Search leg 400s once gather
 * embeds it.
 *
 * Both halves cross a package boundary and so read built `dist/`, not source:
 * a codec change verified only against this test WITHOUT rebuilding
 * `@semiont/graph` is verifying the previous build.
 */

import { describe, it, expect, vi } from 'vitest';
import { validators, formatErrors } from '@semiont/core/openapi';
import { MemoryGraphDatabase } from '@semiont/graph';
import {
  annotationId as makeAnnotationId,
  isObject,
  resourceId as makeResourceId,
  type Annotation,
  type Logger,
  type ResourceDescriptor,
  type components,
} from '@semiont/core';
import { GraphContext, type KnowledgeGraphReads } from '../graph-context';

type GatheredContext = components['schemas']['GatheredContext'];

const silentLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: () => silentLogger,
};

const SOURCE_ID = makeResourceId('res-cedar-county');
const DERIVED_FROM_ID = makeResourceId('res-iowa-counties');

const resource = (id: string, name: string): ResourceDescriptor => ({
  '@context': 'https://schema.org/',
  '@id': makeResourceId(id),
  name,
  entityTypes: ['Document'],
  representations: [],
});

/**
 * The shape under test: a generated-from provenance edge, which is
 * resource-level — `source`, no `selector`. Written through a REAL store,
 * which round-trips the codec; a hand-built fixture would validate whatever
 * the store does to a missing selector.
 */
async function seedGraph(): Promise<{ kb: KnowledgeGraphReads; annotation: Annotation }> {
  const graph = new MemoryGraphDatabase();
  await graph.createResource(resource(String(SOURCE_ID), 'Cedar County, Iowa'));
  await graph.createResource(resource(String(DERIVED_FROM_ID), 'Counties of Iowa'));

  const annotation = await graph.createAnnotation({
    id: makeAnnotationId('ann-provenance-1'),
    motivation: 'linking',
    target: { source: String(DERIVED_FROM_ID) },
    body: [{ type: 'SpecificResource', source: String(SOURCE_ID) }],
    // AgentPerson requires `name` as well as `@type`, or every branch fails.
    creator: { '@id': 'did:user:test', '@type': 'Person', name: 'Test User' },
    created: '2026-01-01T00:00:00.000Z',
  } as Parameters<MemoryGraphDatabase['createAnnotation']>[0]);

  const kb: KnowledgeGraphReads = {
    views: { get: vi.fn().mockResolvedValue({ resource: resource(String(DERIVED_FROM_ID), 'Counties of Iowa') }) } as KnowledgeGraphReads['views'],
    graph,
    weaveProgress: { whenApplied: vi.fn() } as KnowledgeGraphReads['weaveProgress'],
  };

  return { kb, annotation };
}

/** The envelope `annotation-context.ts` assembles around the graph. */
function gatheredContext(graph: GatheredContext['graph'], annotation: Annotation): GatheredContext {
  return {
    focus: {
      kind: 'annotation',
      annotation,
      sourceResource: resource(String(DERIVED_FROM_ID), 'Counties of Iowa'),
    },
    graph,
    metadata: { resourceType: 'document', entityTypes: [] },
  } as GatheredContext;
}

/** The generated validators `/bus/emit` runs — never a second Ajv setup here. */
function check(schema: 'GatherAnnotationComplete' | 'MatchSearchRequest', payload: unknown): string | null {
  const validate = validators[schema];
  return validate(payload) ? null : formatErrors(validate.errors);
}

describe('a gathered context carrying a resource-level edge is emittable', () => {
  it('round-trips the provenance annotation with no selector key at all', async () => {
    const { annotation } = await seedGraph();

    // Absence is absence: not `null`, not `{}` — the key must be gone.
    const { target } = annotation;
    if (!isObject(target)) throw new Error('expected a structured target');
    expect('selector' in target).toBe(false);
    expect(annotation.motivation).toBe('linking');
  });

  it('validates against GatherAnnotationComplete — the gather leg', async () => {
    const { kb, annotation } = await seedGraph();
    const graph = await GraphContext.buildKnowledgeGraph(DERIVED_FROM_ID, kb, silentLogger);

    // Or the payload would validate vacuously.
    const annotationNodes = graph.nodes.filter((n) => n.type === 'annotation');
    expect(annotationNodes.length).toBeGreaterThan(0);

    expect(check('GatherAnnotationComplete', {
      correlationId: 'cid-teeth-1',
      annotationId: String(annotation.id),
      response: gatheredContext(graph, annotation),
    })).toBeNull();
  });

  it('validates against MatchSearchRequest — the Search leg', async () => {
    const { kb, annotation } = await seedGraph();
    const graph = await GraphContext.buildKnowledgeGraph(DERIVED_FROM_ID, kb, silentLogger);

    expect(check('MatchSearchRequest', {
      correlationId: 'cid-teeth-2',
      resourceId: String(SOURCE_ID),
      referenceId: String(annotation.id),
      context: gatheredContext(graph, annotation),
    })).toBeNull();
  });

  it('still REJECTS a manufactured empty selector — the gate can fail', async () => {
    const { kb, annotation } = await seedGraph();
    const graph = await GraphContext.buildKnowledgeGraph(DERIVED_FROM_ID, kb, silentLogger);

    // A manufactured `{}` injected — so the passing assertions above are
    // provably load-bearing.
    const poisoned = structuredClone(graph);
    for (const node of poisoned.nodes) {
      if (node.type !== 'annotation') continue;
      node.annotation.target = {
        source: String(DERIVED_FROM_ID),
        selector: {},
      } as typeof node.annotation.target;
    }

    const failure = check('MatchSearchRequest', {
      correlationId: 'cid-teeth-3',
      resourceId: String(SOURCE_ID),
      referenceId: String(annotation.id),
      context: gatheredContext(poisoned, annotation),
    });
    expect(failure).not.toBeNull();
    expect(failure).toMatch(/selector|type|required/i);
  });
});
