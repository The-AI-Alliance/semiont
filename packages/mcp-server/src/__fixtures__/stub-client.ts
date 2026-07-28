/**
 * Test fixtures and a stubbed `McpClient`.
 *
 * Shared by handlers.test.ts (which drives the handlers directly) and
 * server.test.ts (which drives them through a real MCP client), so the two
 * cannot disagree about what a resource or an annotation looks like.
 */

import { vi } from 'vitest';
import { of, type Observable } from 'rxjs';
import { annotationId, resourceId } from '@semiont/core';
import type {
  Annotation,
  AnnotationId,
  BodyOperation,
  GatheredContext,
  Motivation,
  ResourceDescriptor,
  ResourceId,
} from '@semiont/core';
import type {
  CreateAnnotationInput,
  CreateResourceInput,
  GatherAnnotationProgress,
  GenerationOptions,
  MarkAssistEvent,
  MarkAssistOptions,
  YieldGenerationEvent,
} from '@semiont/sdk';

import type { McpClient } from '../handlers.js';

export const RESOURCE: ResourceDescriptor = {
  '@context': 'https://schema.org',
  '@id': resourceId('res-iliad'),
  name: 'The Iliad',
  representations: [],
  entityTypes: ['Book', 'Poem'],
};

export const HIGHLIGHT: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('anno-highlight'),
  motivation: 'highlighting',
  target: {
    source: 'res-iliad',
    selector: [
      { type: 'TextPositionSelector', start: 0, end: 15 },
      { type: 'TextQuoteSelector', exact: 'Sing, O goddess' },
    ],
  },
};

export const BOUND_REFERENCE: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('anno-reference'),
  motivation: 'linking',
  target: { source: 'res-iliad', selector: [{ type: 'TextQuoteSelector', exact: 'Achilles' }] },
  body: [{ type: 'SpecificResource', source: 'res-achilles', purpose: 'linking' }],
};

export const UNBOUND_REFERENCE: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('anno-unbound'),
  motivation: 'linking',
  target: { source: 'res-iliad', selector: [{ type: 'TextQuoteSelector', exact: 'Patroclus' }] },
};

export const CONTEXT: GatheredContext = {
  focus: {
    kind: 'annotation',
    annotation: BOUND_REFERENCE,
    sourceResource: RESOURCE,
    selected: { text: 'Achilles' },
  },
  graph: { nodes: [], edges: [] },
  metadata: { language: 'grc' },
};

/** What `gather.annotation` actually resolves to: the envelope, not the context. */
export const GATHER_COMPLETE: GatherAnnotationProgress = {
  correlationId: 'corr-1',
  annotationId: 'anno-reference',
  response: CONTEXT,
};

export const ASSIST_COMPLETE: MarkAssistEvent = {
  kind: 'complete',
  data: {
    resourceId: 'res-iliad',
    jobId: 'job-1',
    jobType: 'reference-annotation',
    result: { totalFound: 7, totalEmitted: 7, errors: 0 },
  },
};

export const GENERATION_COMPLETE: YieldGenerationEvent = {
  kind: 'complete',
  data: { resourceId: 'res-iliad', jobId: 'job-2', jobType: 'generation' },
};

/**
 * An `McpClient` whose every method is a mock with a working default. The
 * returned object exposes the namespaces directly so tests can assert on calls
 * and override return values.
 */
export function createStub() {
  const browse = {
    resource: vi.fn<(id: ResourceId) => Promise<ResourceDescriptor>>(async () => RESOURCE),
    resources: vi.fn<(filters: { limit?: number; archived?: boolean; search?: string }) => Promise<ResourceDescriptor[]>>(async () => [RESOURCE]),
    annotations: vi.fn<(id: ResourceId) => Promise<Annotation[]>>(async () => [HIGHLIGHT, BOUND_REFERENCE, UNBOUND_REFERENCE]),
  };
  const mark = {
    annotation: vi.fn<(input: CreateAnnotationInput) => Promise<{ annotationId: AnnotationId }>>(
      async () => ({ annotationId: annotationId('anno-new') }),
    ),
    assist: vi.fn<(id: ResourceId, motivation: Motivation, options: MarkAssistOptions) => Observable<MarkAssistEvent>>(
      () => of(ASSIST_COMPLETE),
    ),
  };
  const bind = {
    body: vi.fn<(r: ResourceId, a: AnnotationId, ops: BodyOperation[]) => Promise<void>>(async () => {}),
  };
  const gather = {
    annotation: vi.fn<(r: ResourceId, a: AnnotationId, options?: { contextWindow?: number }) => Promise<GatherAnnotationProgress>>(
      async () => GATHER_COMPLETE,
    ),
  };
  const yieldNamespace = {
    resource: vi.fn<(data: CreateResourceInput) => Promise<{ resourceId: ResourceId }>>(
      async () => ({ resourceId: resourceId('res-new') }),
    ),
    fromAnnotation: vi.fn<(r: ResourceId, a: AnnotationId, options: GenerationOptions) => Observable<YieldGenerationEvent>>(
      () => of(GENERATION_COMPLETE),
    ),
  };

  const client: McpClient = { browse, mark, bind, gather, yield: yieldNamespace };
  return { client, browse, mark, bind, gather, yield: yieldNamespace };
}
