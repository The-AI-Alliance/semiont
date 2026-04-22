import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resourceId, annotationId, entityType } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { components } from '@semiont/core';

type Agent = components['schemas']['Agent'];

vi.mock('../workers/annotation-detection', () => ({
  AnnotationDetection: {
    detectHighlights: vi.fn(),
    detectComments: vi.fn(),
    detectAssessments: vi.fn(),
    detectTags: vi.fn(),
  },
}));

vi.mock('../workers/detection/entity-extractor', () => ({
  extractEntities: vi.fn(),
}));

vi.mock('../workers/generation/resource-generation', () => ({
  generateResourceFromTopic: vi.fn(),
}));

vi.mock('@semiont/event-sourcing', () => ({
  generateAnnotationId: vi.fn(() => 'ann-test-123'),
}));

vi.mock('@semiont/api-client', () => ({
  validateAndCorrectOffsets: vi.fn((_content, start, end, exact) => ({
    start, end, exact, prefix: '', suffix: '', corrected: false,
  })),
}));

import { AnnotationDetection } from '../workers/annotation-detection';
import { extractEntities } from '../workers/detection/entity-extractor';
import { generateResourceFromTopic } from '../workers/generation/resource-generation';
import { validateAndCorrectOffsets } from '@semiont/api-client';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
} from '../processors';

const RID = resourceId('res-test');
const USER_DID = 'did:web:test.local:users:alice%40test.local';
const GENERATOR: Agent = { type: 'SoftwareAgent', id: 'generator:test', name: 'test' };

function makeInferenceClient(): InferenceClient {
  return {
    generateText: vi.fn(),
  } as unknown as InferenceClient;
}

describe('processHighlightJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces highlighting annotations and reports progress', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'important', start: 0, end: 9 },
      { exact: 'critical', start: 20, end: 28 },
    ]);

    const progress = vi.fn();
    const result = await processHighlightJob(
      'text content',
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      USER_DID,
      GENERATOR,
      progress,
    );

    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0]).toMatchObject({
      motivation: 'highlighting',
      target: expect.objectContaining({ source: RID }),
    });
    expect(result.result).toEqual({ highlightsFound: 2, highlightsCreated: 2 });
    expect(progress).toHaveBeenCalledWith(10, expect.any(String), 'analyzing');
    expect(progress).toHaveBeenLastCalledWith(100, expect.stringContaining('2 highlights'), 'creating');
  });
});

describe('processCommentJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces commenting annotations with TextualBody', async () => {
    vi.mocked(AnnotationDetection.detectComments).mockResolvedValue([
      { exact: 'passage', start: 0, end: 7, comment: 'interesting point' },
    ]);

    const result = await processCommentJob(
      'passage here',
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    expect((result.annotations[0] as any).motivation).toBe('commenting');
    // Canonical commenting body — single-item array of TextualBody with
    // format + language. Do not drop format/language; the pre-#651
    // CommentAnnotationWorker emitted them and consumers may rely on
    // them for rendering.
    expect((result.annotations[0] as any).body).toEqual([
      { type: 'TextualBody', value: 'interesting point', purpose: 'commenting', format: 'text/plain', language: 'en' },
    ]);
    expect(result.result).toEqual({ commentsFound: 1, commentsCreated: 1 });
  });
});

describe('processAssessmentJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces assessing annotations with TextualBody', async () => {
    vi.mocked(AnnotationDetection.detectAssessments).mockResolvedValue([
      { exact: 'claim', start: 0, end: 5, assessment: 'dubious' },
    ]);

    const result = await processAssessmentJob(
      'claim made',
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    expect((result.annotations[0] as any).motivation).toBe('assessing');
    // Canonical assessing body — a single AnnotationBody object (not an
    // array), purpose aligned to motivation. Matches the pre-#651
    // AssessmentAnnotationWorker and the majority of persisted
    // assessments. Do not flip to array or to purpose='describing' —
    // either change loses signal or breaks readers that access
    // `body.value` directly on the object.
    expect((result.annotations[0] as any).body).toEqual({
      type: 'TextualBody', value: 'dubious', purpose: 'assessing', format: 'text/plain', language: 'en',
    });
    expect(result.result).toEqual({ assessmentsFound: 1, assessmentsCreated: 1 });
  });
});

describe('processReferenceJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces linking annotations and tracks per-entity-type progress', async () => {
    vi.mocked(extractEntities).mockResolvedValue([
      { exact: 'Paris', startOffset: 0, endOffset: 5, entityType: 'Location' } as any,
      { exact: 'Berlin', startOffset: 10, endOffset: 16, entityType: 'Location' } as any,
    ]);

    const progress = vi.fn();
    const result = await processReferenceJob(
      'Paris and Berlin',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      USER_DID,
      GENERATOR,
      progress,
    );

    expect(result.annotations).toHaveLength(2);
    expect((result.annotations[0] as any).motivation).toBe('linking');
    // Canonical unresolved-linking body — single-item array with the
    // entity type as a tagging TextualBody. The bind flow later appends
    // a SpecificResource to resolve. Do not emit `[]` — that breaks the
    // append contract and trips the Annotation.body oneOf.
    expect((result.annotations[0] as any).body).toEqual([
      { type: 'TextualBody', value: 'Location', purpose: 'tagging' },
    ]);
    expect(result.result).toEqual({ totalFound: 2, totalEmitted: 2, errors: 0 });
  });

  it('counts errors when offset validation throws', async () => {
    vi.mocked(extractEntities).mockResolvedValue([
      { exact: 'good', startOffset: 0, endOffset: 4, entityType: 'Thing' } as any,
      { exact: 'bad', startOffset: 99, endOffset: 102, entityType: 'Thing' } as any,
    ]);
    vi.mocked(validateAndCorrectOffsets)
      .mockImplementationOnce((_c, start, end, exact) => ({ start, end, exact, prefix: '', suffix: '', corrected: false }))
      .mockImplementationOnce(() => { throw new Error('offset out of range'); });

    const result = await processReferenceJob(
      'good stuff',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Thing')] },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    expect(result.result).toEqual({ totalFound: 2, totalEmitted: 1, errors: 1 });
  });

  it('returns zero counts when no entities are found', async () => {
    vi.mocked(extractEntities).mockResolvedValue([]);

    const result = await processReferenceJob(
      'content',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(0);
    expect(result.result).toEqual({ totalFound: 0, totalEmitted: 0, errors: 0 });
  });
});

describe('processTagJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces tagging annotations grouped by category', async () => {
    vi.mocked(AnnotationDetection.detectTags)
      .mockResolvedValueOnce([
        { exact: 'foo', start: 0, end: 3, category: 'catA' } as any,
        { exact: 'bar', start: 4, end: 7, category: 'catA' } as any,
      ])
      .mockResolvedValueOnce([
        { exact: 'baz', start: 8, end: 11, category: 'catB' } as any,
      ]);

    const result = await processTagJob(
      'foo bar baz',
      makeInferenceClient(),
      { resourceId: RID, schemaId: 'schema-1', categories: ['catA', 'catB'] },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(3);
    expect(result.annotations.every((a: any) => a.motivation === 'tagging')).toBe(true);
    // Canonical tagging body — two TextualBody entries: the category
    // (purpose: 'tagging') and the tagging-schema id (purpose:
    // 'classifying'). The classifying body is the only record of schema
    // provenance; do not drop it.
    for (const ann of result.annotations as any[]) {
      expect(ann.body).toEqual([
        { type: 'TextualBody', value: expect.any(String),  purpose: 'tagging',     format: 'text/plain', language: 'en' },
        { type: 'TextualBody', value: 'schema-1',          purpose: 'classifying', format: 'text/plain' },
      ]);
    }
    expect(result.result).toEqual({
      tagsFound: 3,
      tagsCreated: 3,
      byCategory: { catA: 2, catB: 1 },
    });
  });
});

describe('processGenerationJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates content and returns title + format', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: '# Generated resource\n\nBody.',
      title: 'Generated Title',
    } as any);

    const progress = vi.fn();
    const result = await processGenerationJob(
      makeInferenceClient(),
      {
        referenceId: annotationId('ann-1'),
        sourceResourceId: RID,
        sourceResourceName: 'src',
        title: 'Initial',
        entityTypes: [],
        context: {} as any,
        annotation: {} as any,
      },
      progress,
    );

    expect(result.content).toContain('Generated resource');
    expect(result.title).toBe('Generated Title');
    expect(result.format).toBe('text/markdown');
    expect(result.result.resourceName).toBe('Generated Title');
    expect(progress).toHaveBeenCalledWith(20, expect.any(String), 'fetching');
    expect(progress).toHaveBeenCalledWith(40, expect.any(String), 'generating');
    expect(progress).toHaveBeenCalledWith(85, expect.any(String), 'creating');
  });

  it('falls back to request title when generator omits it', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: 'text',
    } as any);

    const result = await processGenerationJob(
      makeInferenceClient(),
      {
        referenceId: annotationId('ann-1'),
        sourceResourceId: RID,
        sourceResourceName: 'src',
        title: 'Fallback Title',
        entityTypes: [],
        context: {} as any,
        annotation: {} as any,
      },
      vi.fn(),
    );

    expect(result.title).toBe('Fallback Title');
    expect(result.result.resourceName).toBe('Fallback Title');
  });
});
