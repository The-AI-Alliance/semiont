import { describe, expect, it, vi } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
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

import {
  bindBody,
  browseHighlights,
  browseReferences,
  browseResource,
  browseResources,
  callTool,
  gatherAnnotation,
  markAnnotation,
  markAssist,
  yieldFromAnnotation,
  yieldResource,
  type McpClient,
  type McpResult,
} from './handlers.js';
import { TOOLS } from './tools.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const RESOURCE: ResourceDescriptor = {
  '@context': 'https://schema.org',
  '@id': resourceId('res-iliad'),
  name: 'The Iliad',
  representations: [],
  entityTypes: ['Book', 'Poem'],
};

const HIGHLIGHT: Annotation = {
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

const BOUND_REFERENCE: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('anno-reference'),
  motivation: 'linking',
  target: { source: 'res-iliad', selector: [{ type: 'TextQuoteSelector', exact: 'Achilles' }] },
  body: [{ type: 'SpecificResource', source: 'res-achilles', purpose: 'linking' }],
};

const UNBOUND_REFERENCE: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  type: 'Annotation',
  id: annotationId('anno-unbound'),
  motivation: 'linking',
  target: { source: 'res-iliad', selector: [{ type: 'TextQuoteSelector', exact: 'Patroclus' }] },
};

const CONTEXT: GatheredContext = {
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
const GATHER_COMPLETE: GatherAnnotationProgress = {
  correlationId: 'corr-1',
  annotationId: 'anno-reference',
  response: CONTEXT,
};

const ASSIST_COMPLETE: MarkAssistEvent = {
  kind: 'complete',
  data: {
    resourceId: 'res-iliad',
    jobId: 'job-1',
    jobType: 'reference-annotation',
    result: { totalFound: 7, totalEmitted: 7, errors: 0 },
  },
};

const GENERATION_COMPLETE: YieldGenerationEvent = {
  kind: 'complete',
  data: { resourceId: 'res-iliad', jobId: 'job-2', jobType: 'generation' },
};

// ── Stub client ─────────────────────────────────────────────────────────────

function createStub() {
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

/** Every handler answers with exactly one text block. */
function text(result: McpResult): string {
  expect(result.content).toHaveLength(1);
  expect(result.content[0]!.type).toBe('text');
  return result.content[0]!.text;
}

// ── Browse ──────────────────────────────────────────────────────────────────

describe('browseResource', () => {
  it('reads the resource by id and returns it as JSON', async () => {
    const { client, browse } = createStub();

    const result = await browseResource(client, { id: 'res-iliad' });

    expect(browse.resource).toHaveBeenCalledWith('res-iliad');
    expect(JSON.parse(text(result))).toEqual(RESOURCE);
  });
});

describe('browseResources', () => {
  it('defaults to unarchived and sends no other filter', async () => {
    const { client, browse } = createStub();

    await browseResources(client, {});

    expect(browse.resources).toHaveBeenCalledWith({ archived: false });
  });

  it('passes search and limit through', async () => {
    const { client, browse } = createStub();

    await browseResources(client, { search: 'ontology', limit: 5, archived: true });

    expect(browse.resources).toHaveBeenCalledWith({ search: 'ontology', limit: 5, archived: true });
  });

  it('summarises each resource with its id and entity types', async () => {
    const { client } = createStub();

    const result = await browseResources(client, {});

    expect(text(result)).toBe('Found 1 resources:\n- The Iliad (res-iliad) — Book, Poem');
  });
});

describe('browseHighlights', () => {
  it('keeps only highlighting annotations and shows their quoted text', async () => {
    const { client, browse } = createStub();

    const result = await browseHighlights(client, { resourceId: 'res-iliad' });

    expect(browse.annotations).toHaveBeenCalledWith('res-iliad');
    expect(text(result)).toBe('Found 1 highlights:\n- Sing, O goddess');
  });
});

describe('browseReferences', () => {
  it('keeps only linking annotations and marks unbound ones as stubs', async () => {
    const { client, browse } = createStub();

    const result = await browseReferences(client, { resourceId: 'res-iliad' });

    expect(browse.annotations).toHaveBeenCalledWith('res-iliad');
    expect(text(result)).toBe(
      'Found 2 references:\n- Achilles → res-achilles\n- Patroclus → stub (no link)',
    );
  });
});

// ── Mark ────────────────────────────────────────────────────────────────────

describe('markAnnotation', () => {
  it('builds a highlight target from the selection and tags from entityTypes', async () => {
    const { client, mark } = createStub();

    const result = await markAnnotation(client, {
      resourceId: 'res-iliad',
      selectionData: { offset: 10, length: 8, text: 'Achilles' },
      entityTypes: ['Person'],
    });

    expect(mark.annotation).toHaveBeenCalledWith({
      motivation: 'highlighting',
      target: {
        source: 'res-iliad',
        selector: [
          { type: 'TextPositionSelector', start: 10, end: 18 },
          { type: 'TextQuoteSelector', exact: 'Achilles' },
        ],
      },
      body: [{ type: 'TextualBody', value: 'Person', purpose: 'tagging' }],
    });
    expect(text(result)).toBe('Annotation created: anno-new');
  });

  it('falls back to a zero-length empty selection and no body', async () => {
    const { client, mark } = createStub();

    await markAnnotation(client, { resourceId: 'res-iliad' });

    expect(mark.annotation).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        selector: [
          { type: 'TextPositionSelector', start: 0, end: 0 },
          { type: 'TextQuoteSelector', exact: '' },
        ],
      }),
      body: [],
    }));
  });
});

describe('markAssist', () => {
  it('requests linking detection with the caller\'s entity types and locales', async () => {
    const { client, mark } = createStub();

    await markAssist(client, {
      resourceId: 'res-iliad',
      entityTypes: ['Person', 'Place'],
      language: 'en',
      sourceLanguage: 'grc',
    });

    expect(mark.assist).toHaveBeenCalledWith('res-iliad', 'linking', {
      entityTypes: ['Person', 'Place'],
      includeDescriptiveReferences: false,
      language: 'en',
      sourceLanguage: 'grc',
    });
  });

  it('reports the total found and every progress stage', async () => {
    const { client, mark } = createStub();
    const events: MarkAssistEvent[] = [
      { kind: 'progress', data: { stage: 'analyzing', percentage: 40, message: 'reading' } },
      { kind: 'progress', data: { stage: 'creating', percentage: 90, message: 'writing' } },
      ASSIST_COMPLETE,
    ];
    mark.assist.mockReturnValue(of(...events));

    const result = await markAssist(client, { resourceId: 'res-iliad' });

    expect(text(result)).toBe('Detection complete. Found 7 entities.\nanalyzing: 40%\ncreating: 90%');
  });

  it('falls back to a motivation-specific count when totalFound is absent', async () => {
    const { client, mark } = createStub();
    const complete: MarkAssistEvent = {
      kind: 'complete',
      data: {
        resourceId: 'res-iliad',
        jobId: 'job-1',
        jobType: 'highlight-annotation',
        result: { highlightsFound: 3, highlightsCreated: 3 },
      },
    };
    mark.assist.mockReturnValue(of(complete));

    expect(text(await markAssist(client, { resourceId: 'res-iliad' })))
      .toContain('Found 3 entities.');
  });

  it('returns an error result when the job fails', async () => {
    const { client, mark } = createStub();
    mark.assist.mockReturnValue(throwError(() => new Error('worker unavailable')));

    const result = await markAssist(client, { resourceId: 'res-iliad' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Detection failed: worker unavailable');
  });
});

// ── Bind ────────────────────────────────────────────────────────────────────

describe('bindBody', () => {
  it('adds a linking SpecificResource body to the annotation', async () => {
    const { client, bind } = createStub();

    const result = await bindBody(client, {
      sourceResourceId: 'res-iliad',
      annotationId: 'anno-reference',
      targetResourceId: 'res-achilles',
    });

    expect(bind.body).toHaveBeenCalledWith('res-iliad', 'anno-reference', [
      { op: 'add', item: { type: 'SpecificResource', source: 'res-achilles', purpose: 'linking' } },
    ]);
    expect(text(result)).toBe('Linked anno-reference → res-achilles');
  });
});

// ── Gather ──────────────────────────────────────────────────────────────────

describe('gatherAnnotation', () => {
  it('returns the gathered context, not the completion envelope', async () => {
    const { client, gather } = createStub();

    const result = await gatherAnnotation(client, { resourceId: 'res-iliad', annotationId: 'anno-reference' });

    expect(gather.annotation).toHaveBeenCalledWith('res-iliad', 'anno-reference', { contextWindow: 2000 });
    expect(JSON.parse(text(result))).toEqual(CONTEXT);
  });

  it('honors an explicit context window', async () => {
    const { client, gather } = createStub();

    await gatherAnnotation(client, { resourceId: 'res-iliad', annotationId: 'anno-reference', contextWindow: 500 });

    expect(gather.annotation).toHaveBeenCalledWith('res-iliad', 'anno-reference', { contextWindow: 500 });
  });

  it('throws when the stream ends without a context payload', async () => {
    const { client, gather } = createStub();
    gather.annotation.mockResolvedValue({ message: 'still working', percentage: 50 });

    await expect(gatherAnnotation(client, { resourceId: 'res-iliad', annotationId: 'anno-reference' }))
      .rejects.toThrow('Gather finished without a context payload');
  });
});

// ── Yield ───────────────────────────────────────────────────────────────────

describe('yieldResource', () => {
  it('uploads the content as a text/plain file by default', async () => {
    const { client, yield: yieldNamespace } = createStub();

    const result = await yieldResource(client, {
      name: 'Notes',
      content: 'hello world',
      storageUri: 'file://docs/notes.md',
      entityTypes: ['Note'],
    });

    const input = yieldNamespace.resource.mock.calls[0]![0];
    expect(input).toMatchObject({
      name: 'Notes',
      format: 'text/plain',
      storageUri: 'file://docs/notes.md',
      entityTypes: ['Note'],
    });
    if (!(input.file instanceof File)) throw new Error('expected a File upload');
    expect(input.file.name).toBe('Notes.txt');
    expect(input.file.type).toBe('text/plain');
    expect(await input.file.text()).toBe('hello world');
    expect(text(result)).toBe('Resource created: res-new');
  });

  it('honors an explicit content type', async () => {
    const { client, yield: yieldNamespace } = createStub();

    await yieldResource(client, {
      name: 'Notes',
      content: '# hello',
      storageUri: 'file://docs/notes.md',
      contentType: 'text/markdown',
    });

    expect(yieldNamespace.resource.mock.calls[0]![0]).toMatchObject({ format: 'text/markdown', entityTypes: [] });
  });
});

describe('yieldFromAnnotation', () => {
  it('gathers first and generates from the unwrapped context', async () => {
    const { client, gather, yield: yieldNamespace } = createStub();

    const result = await yieldFromAnnotation(client, {
      resourceId: 'res-iliad',
      annotationId: 'anno-reference',
      storageUri: 'file://docs/achilles.md',
      prompt: 'Write about him',
    });

    expect(gather.annotation).toHaveBeenCalledWith('res-iliad', 'anno-reference', { contextWindow: 2000 });
    expect(yieldNamespace.fromAnnotation).toHaveBeenCalledWith('res-iliad', 'anno-reference', {
      title: 'Generated',
      storageUri: 'file://docs/achilles.md',
      context: CONTEXT,
      prompt: 'Write about him',
      language: undefined,
      // Defaulted from the gathered context's metadata.
      sourceLanguage: 'grc',
    });
    expect(text(result)).toBe('Generation complete.\n');
  });

  it('lets the caller override the title and both locales', async () => {
    const { client, yield: yieldNamespace } = createStub();

    await yieldFromAnnotation(client, {
      resourceId: 'res-iliad',
      annotationId: 'anno-reference',
      storageUri: 'file://docs/achilles.md',
      title: 'Achilles',
      language: 'fr',
      sourceLanguage: 'en',
    });

    expect(yieldNamespace.fromAnnotation).toHaveBeenCalledWith('res-iliad', 'anno-reference', expect.objectContaining({
      title: 'Achilles',
      language: 'fr',
      sourceLanguage: 'en',
    }));
  });

  it('reports every progress stage', async () => {
    const { client, yield: yieldNamespace } = createStub();
    const events: YieldGenerationEvent[] = [
      { kind: 'progress', data: { stage: 'generating', percentage: 50, message: 'writing' } },
      GENERATION_COMPLETE,
    ];
    yieldNamespace.fromAnnotation.mockReturnValue(of(...events));

    expect(text(await yieldFromAnnotation(client, {
      resourceId: 'res-iliad',
      annotationId: 'anno-reference',
      storageUri: 'file://docs/achilles.md',
    }))).toBe('Generation complete.\ngenerating: 50%');
  });

  it('returns an error result when generation fails', async () => {
    const { client, yield: yieldNamespace } = createStub();
    yieldNamespace.fromAnnotation.mockReturnValue(throwError(() => new Error('model timed out')));

    const result = await yieldFromAnnotation(client, {
      resourceId: 'res-iliad',
      annotationId: 'anno-reference',
      storageUri: 'file://docs/achilles.md',
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Generation failed: model timed out');
  });
});

// ── Dispatch ────────────────────────────────────────────────────────────────

describe('callTool', () => {
  const MINIMAL_ARGS: Record<string, unknown> = {
    browse_resource: { id: 'res-iliad' },
    browse_resources: {},
    browse_highlights: { resourceId: 'res-iliad' },
    browse_references: { resourceId: 'res-iliad' },
    mark_annotation: { resourceId: 'res-iliad', selectionData: { offset: 0, length: 1, text: 'S' } },
    mark_assist: { resourceId: 'res-iliad' },
    bind_body: { sourceResourceId: 'res-iliad', annotationId: 'anno-reference', targetResourceId: 'res-achilles' },
    gather_annotation: { resourceId: 'res-iliad', annotationId: 'anno-reference' },
    yield_resource: { name: 'Notes', content: 'hi', storageUri: 'file://docs/notes.md' },
    yield_from_annotation: { resourceId: 'res-iliad', annotationId: 'anno-reference', storageUri: 'file://docs/a.md' },
  };

  it.each(TOOLS.map(t => t.name))('routes %s to a handler', async (name) => {
    const { client } = createStub();

    const result = await callTool(client, name, MINIMAL_ARGS[name]);

    expect(result.isError).toBeUndefined();
  });

  it('reports an unknown tool as an error result', async () => {
    const { client } = createStub();

    const result = await callTool(client, 'semiont_hello', {});

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Error: Unknown tool: semiont_hello');
  });

  it('turns a handler failure into an error result rather than throwing', async () => {
    const { client, browse } = createStub();
    browse.resource.mockRejectedValue(new Error('connection refused'));

    const result = await callTool(client, 'browse_resource', { id: 'res-iliad' });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Error: connection refused');
  });
});
