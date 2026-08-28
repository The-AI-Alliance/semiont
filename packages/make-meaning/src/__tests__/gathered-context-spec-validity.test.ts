/**
 * A gathered context validates against the spec `/bus/emit` enforces —
 * GRAPH-ANNOTATION-CODEC P3.
 *
 * The stores used to require a `selector`, so a source-only annotation was
 * stored as `'{}'` and read back as `{}` — which satisfies no branch of the
 * selector union, 400ing the wizard's Search leg once gather embedded it.
 *
 * Both halves cross a package boundary and so read built `dist/`, not source:
 * a codec change verified only against this test WITHOUT rebuilding
 * `@semiont/graph` is verifying the previous build (measured — a poisoned
 * codec left this file green until the rebuild).
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
 * The shape the bug produced: a generated-from provenance edge, which is
 * resource-level — `source`, no `selector`. Written through a REAL store,
 * which round-trips the codec (D7); a hand-built fixture would have validated
 * against the old lying store too.
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

describe('a gathered context carrying a resource-level edge is emittable (GRAPH-ANNOTATION-CODEC P3)', () => {
  it('round-trips the provenance annotation with no selector key at all', async () => {
    const { annotation } = await seedGraph();

    // Absence is absence (D4): not `null`, not `{}` — the key must be gone.
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

  it('validates against MatchSearchRequest — the leg that actually 400\'d', async () => {
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

    // The old lie, re-injected — so the green assertions above are provably
    // load-bearing.
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
