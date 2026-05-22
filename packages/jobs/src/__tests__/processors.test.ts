import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resourceId, annotationId, entityType } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { components, TagSchema } from '@semiont/core';

type Agent = components['schemas']['Agent'];

// Test schema — the dispatcher resolves schemaId → TagSchema before the
// processor sees the job, so processTagJob receives the full schema in
// params.schema.
const SCHEMA_1: TagSchema = {
  id: 'schema-1',
  name: 'Test Schema',
  description: 'Test',
  domain: 'test',
  tags: [
    { name: 'catA',  description: 'A',     examples: [] },
    { name: 'catB',  description: 'B',     examples: [] },
    { name: 'Issue', description: 'Issue', examples: [] },
  ],
};

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

// No `@semiont/core` mock — these tests exercise the real `reconcileSelector`
// against synthetic content. The processor's `buildTextAnnotation` invariant
// runs `content.substring(start, end) === exact`, so the test content has
// to actually contain the entities we feed in.

import { AnnotationDetection } from '../workers/annotation-detection';
import { extractEntities } from '../workers/detection/entity-extractor';
import { generateResourceFromTopic } from '../workers/generation/resource-generation';
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
const GENERATOR: Agent = {
  '@type': 'Software',
  '@id': 'did:web:test.local:agents:test:test',
  name: 'test test',
  provider: 'test',
  model: 'test',
};

function makeInferenceClient(): InferenceClient {
  return {
    generateText: vi.fn(),
  } as unknown as InferenceClient;
}

const LOGGER = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function (this: any) { return this; }),
} as unknown as import('@semiont/core').Logger;

describe('processHighlightJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('produces highlighting annotations and reports progress', async () => {
    // Content must actually contain the highlighted substrings — the
    // buildTextAnnotation invariant verifies content[start, end] === exact.
    const content = 'important text and the critical part is here.';
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'important', start: 0, end: 9 },
      { exact: 'critical', start: content.indexOf('critical'), end: content.indexOf('critical') + 'critical'.length },
    ]);

    const progress = vi.fn();
    const result = await processHighlightJob(
      content,
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
    // Highlights carry no body — motivation alone is the content per W3C.
    expect((result.annotations[0] as Record<string, unknown>).body).toBeUndefined();
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
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      { exact: 'Berlin', start: 10, end: 16, entityType: 'Location' } as any,
    ]);

    const progress = vi.fn();
    const result = await processReferenceJob(
      'Paris and Berlin',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      USER_DID,
      GENERATOR,
      progress,
      LOGGER,
    );

    expect(result.annotations).toHaveLength(2);
    expect((result.annotations[0] as any).motivation).toBe('linking');
    // Canonical unresolved-linking body — single-item array with the
    // entity type as a tagging TextualBody, stamped with format and the
    // body locale (defaults to 'en'). The bind flow later appends a
    // SpecificResource to resolve. Do not emit `[]` — that breaks the
    // append contract and trips the Annotation.body oneOf.
    expect((result.annotations[0] as any).body).toEqual([
      { type: 'TextualBody', value: 'Location', purpose: 'tagging', format: 'text/plain', language: 'en' },
    ]);
    expect(result.result).toEqual({ totalFound: 2, totalEmitted: 2, errors: 0 });
  });

  it('counts errors when reconciliation drops an entity (text not in source)', async () => {
    // 'good' is in the content; 'BADTEXT' is not — reconcileSelector drops
    // the second entity, the processor counts an error.
    vi.mocked(extractEntities).mockResolvedValue([
      { exact: 'good', start: 0, end: 4, entityType: 'Thing' } as any,
      { exact: 'BADTEXT', start: 99, end: 106, entityType: 'Thing' } as any,
    ]);

    const result = await processReferenceJob(
      'good stuff',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Thing')] },
      USER_DID,
      GENERATOR,
      vi.fn(),
      LOGGER,
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
      LOGGER,
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
      { resourceId: RID, schema: SCHEMA_1, categories: ['catA', 'catB'] },
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
      LOGGER,
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
      LOGGER,
    );

    expect(result.title).toBe('Fallback Title');
    expect(result.result.resourceName).toBe('Fallback Title');
  });
});

// ============================================================================
// Attribution composition (creator / generator / wasAttributedTo)
// ============================================================================

describe('annotation attribution composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps both creator (Person) and generator (Software) on human-prompted AI work', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'snippet', start: 0, end: 7 },
    ]);

    const result = await processHighlightJob(
      'snippet',
      makeInferenceClient(),
      { resourceId: RID, density: 1 },
      USER_DID, // human DID
      GENERATOR, // Software agent
      vi.fn(),
    );

    const ann = result.annotations[0] as Record<string, unknown>;
    const creator = ann['creator'] as { '@type': string; '@id': string };
    const generator = ann['generator'] as { '@type': string; '@id': string };
    const wasAttributedTo = ann['wasAttributedTo'] as Array<{ '@id': string }>;

    expect(creator['@type']).toBe('Person');
    expect(creator['@id']).toBe(USER_DID);
    expect(generator['@type']).toBe('Software');

    // wasAttributedTo combines both responsible parties (PROV-O)
    expect(Array.isArray(wasAttributedTo)).toBe(true);
    expect(wasAttributedTo.map(a => a['@id'])).toEqual([
      creator['@id'],
      generator['@id'],
    ]);
  });

  it('collapses wasAttributedTo to [generator] when an agent is acting on its own behalf', async () => {
    // Autonomous-agent work: the worker's principal DID *is* the agent.
    // creator and generator share an @id; wasAttributedTo collapses to one.
    const autonomousDid = GENERATOR['@id'];
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'snippet', start: 0, end: 7 },
    ]);

    const result = await processHighlightJob(
      'snippet',
      makeInferenceClient(),
      { resourceId: RID, density: 1 },
      autonomousDid as never,
      GENERATOR,
      vi.fn(),
    );

    const ann = result.annotations[0] as Record<string, unknown>;
    const wasAttributedTo = ann['wasAttributedTo'] as Array<{ '@id': string }>;

    expect(wasAttributedTo).toHaveLength(1);
    expect(wasAttributedTo[0]!['@id']).toBe(GENERATOR['@id']);
  });

  it('applies the same attribution shape across every motivation', async () => {
    vi.mocked(AnnotationDetection.detectComments).mockResolvedValue([
      { exact: 'x', start: 0, end: 1, comment: 'c' },
    ]);
    vi.mocked(AnnotationDetection.detectAssessments).mockResolvedValue([
      { exact: 'x', start: 0, end: 1, assessment: 'a' },
    ]);
    vi.mocked(extractEntities).mockResolvedValue([
      { exact: 'x', start: 0, end: 1, entityType: 'Person' } as any,
    ]);
    vi.mocked(AnnotationDetection.detectTags).mockResolvedValue([
      { exact: 'x', start: 0, end: 1, category: 'c' },
    ]);

    const sources = await Promise.all([
      processCommentJob('x', makeInferenceClient(), { resourceId: RID, density: 1 }, USER_DID, GENERATOR, vi.fn()),
      processAssessmentJob('x', makeInferenceClient(), { resourceId: RID, density: 1 }, USER_DID, GENERATOR, vi.fn()),
      processReferenceJob('x', makeInferenceClient(), { resourceId: RID, entityTypes: [entityType('Person')] }, USER_DID, GENERATOR, vi.fn(), LOGGER),
      processTagJob('x', makeInferenceClient(), { resourceId: RID, schema: 'schema-1', categories: ['c'], sourceLanguage: 'en' } as never, USER_DID, GENERATOR, vi.fn()),
    ]);

    for (const result of sources) {
      const ann = result.annotations[0] as Record<string, unknown>;
      expect(ann['creator']).toBeDefined();
      expect(ann['generator']).toBeDefined();
      expect(Array.isArray(ann['wasAttributedTo'])).toBe(true);
    }
  });
});

// ============================================================================
// Locale threading
// ============================================================================
//
// Two independent locales travel through the params:
//   - `language`       → annotation body locale (TextualBody.language stamp,
//                        and "write your <kind> in <X>" guidance for
//                        comments/assessments)
//   - `sourceLanguage` → source-resource locale (passed to the prompt
//                        builder for all five detection workers)
//
// These tests pin: (a) `language` reaches the right body-stamp slot and
// detection function; (b) `sourceLanguage` reaches every detection function;
// (c) defaults stay sensible when callers omit them.

describe('locale threading', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('annotation body locale', () => {
    it('stamps params.language on the comment TextualBody', async () => {
      vi.mocked(AnnotationDetection.detectComments).mockResolvedValue([
        { exact: 'passage', start: 0, end: 7, comment: 'commentaire' },
      ]);

      const result = await processCommentJob(
        'passage here',
        makeInferenceClient(),
        { resourceId: RID, language: 'fr' },
        USER_DID,
        GENERATOR,
        vi.fn(),
      );

      expect((result.annotations[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'commentaire', purpose: 'commenting', format: 'text/plain', language: 'fr' },
      ]);
    });

    it('stamps params.language on the assessment TextualBody', async () => {
      vi.mocked(AnnotationDetection.detectAssessments).mockResolvedValue([
        { exact: 'claim', start: 0, end: 5, assessment: 'évaluation' },
      ]);

      const result = await processAssessmentJob(
        'claim made',
        makeInferenceClient(),
        { resourceId: RID, language: 'fr' },
        USER_DID,
        GENERATOR,
        vi.fn(),
      );

      expect((result.annotations[0] as any).body).toEqual({
        type: 'TextualBody', value: 'évaluation', purpose: 'assessing', format: 'text/plain', language: 'fr',
      });
    });

    it('stamps params.language on the unresolved-reference TextualBody', async () => {
      vi.mocked(extractEntities).mockResolvedValue([
        { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      ]);

      const result = await processReferenceJob(
        'Paris',
        makeInferenceClient(),
        { resourceId: RID, entityTypes: [entityType('Location')], language: 'fr' },
        USER_DID,
        GENERATOR,
        vi.fn(),
        LOGGER,
      );

      expect((result.annotations[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'Location', purpose: 'tagging', format: 'text/plain', language: 'fr' },
      ]);
    });

    it('stamps params.language on the tagging TextualBody (not the classifying one)', async () => {
      vi.mocked(AnnotationDetection.detectTags).mockResolvedValueOnce([
        { exact: 'foo', start: 0, end: 3, category: 'Issue' } as any,
      ]);

      const result = await processTagJob(
        'foo bar',
        makeInferenceClient(),
        { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'], language: 'de' },
        USER_DID,
        GENERATOR,
        vi.fn(),
      );

      // Only the tagging body carries `language` — the classifying body is
      // a schema-id reference and has no natural-language interpretation.
      expect((result.annotations[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'Issue',    purpose: 'tagging',     format: 'text/plain', language: 'de' },
        { type: 'TextualBody', value: 'schema-1', purpose: 'classifying', format: 'text/plain' },
      ]);
    });

    it('defaults to "en" when params.language is omitted (comment)', async () => {
      vi.mocked(AnnotationDetection.detectComments).mockResolvedValue([
        { exact: 'passage', start: 0, end: 7, comment: 'note' },
      ]);

      const result = await processCommentJob(
        'passage here',
        makeInferenceClient(),
        { resourceId: RID },
        USER_DID,
        GENERATOR,
        vi.fn(),
      );

      expect((result.annotations[0] as any).body[0].language).toBe('en');
    });
  });

  describe('source-resource locale', () => {
    // sourceLanguage flows from params through to the detection function as
    // a positional argument. We assert each detection mock saw it.

    it('forwards sourceLanguage to detectHighlights', async () => {
      vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processHighlightJob(
        'content', client,
        { resourceId: RID, sourceLanguage: 'fr' },
        USER_DID, GENERATOR, vi.fn(),
      );

      expect(AnnotationDetection.detectHighlights).toHaveBeenCalledWith(
        'content', client, undefined, undefined, 'fr',
      );
    });

    it('forwards sourceLanguage and language to detectComments', async () => {
      vi.mocked(AnnotationDetection.detectComments).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processCommentJob(
        'content', client,
        { resourceId: RID, language: 'de', sourceLanguage: 'fr' },
        USER_DID, GENERATOR, vi.fn(),
      );

      expect(AnnotationDetection.detectComments).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined, 'de', 'fr',
      );
    });

    it('forwards sourceLanguage and language to detectAssessments', async () => {
      vi.mocked(AnnotationDetection.detectAssessments).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processAssessmentJob(
        'content', client,
        { resourceId: RID, language: 'es', sourceLanguage: 'pt' },
        USER_DID, GENERATOR, vi.fn(),
      );

      expect(AnnotationDetection.detectAssessments).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined, 'es', 'pt',
      );
    });

    it('forwards sourceLanguage to extractEntities for reference detection', async () => {
      vi.mocked(extractEntities).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processReferenceJob(
        'content', client,
        { resourceId: RID, entityTypes: [entityType('Location')], sourceLanguage: 'fr' },
        USER_DID, GENERATOR, vi.fn(),
        LOGGER,
      );

      expect(extractEntities).toHaveBeenCalledWith(
        'content', ['Location'], client, false, LOGGER, 'fr',
      );
    });

    it('forwards sourceLanguage to detectTags', async () => {
      vi.mocked(AnnotationDetection.detectTags).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processTagJob(
        'content', client,
        { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'], sourceLanguage: 'fr' },
        USER_DID, GENERATOR, vi.fn(),
      );

      // Worker now receives the full schema (resolved by the dispatcher),
      // not a schemaId.
      expect(AnnotationDetection.detectTags).toHaveBeenCalledWith(
        'content', client, SCHEMA_1, 'Issue', 'fr',
      );
    });

    it('passes undefined sourceLanguage when caller omits it', async () => {
      vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([]);
      const client = makeInferenceClient();

      await processHighlightJob(
        'content', client, { resourceId: RID }, USER_DID, GENERATOR, vi.fn(),
      );

      expect(AnnotationDetection.detectHighlights).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined,
      );
    });

    it('forwards sourceLanguage and language to generateResourceFromTopic', async () => {
      vi.mocked(generateResourceFromTopic).mockResolvedValue({
        content: 'text', title: 'T',
      } as any);
      const client = makeInferenceClient();

      await processGenerationJob(
        client,
        {
          referenceId: annotationId('ann-1'),
          sourceResourceId: RID,
          sourceResourceName: 'src',
          title: 'Topic',
          entityTypes: [],
          context: {} as any,
          annotation: {} as any,
          language: 'de',
          sourceLanguage: 'fr',
        },
        vi.fn(),
        LOGGER,
      );

      // Positional signature: topic, entityTypes, client, logger, prompt,
      // locale, context, temperature, maxTokens, sourceLanguage.
      expect(generateResourceFromTopic).toHaveBeenCalledWith(
        'Topic', [], client, LOGGER, undefined, 'de', expect.any(Object),
        undefined, undefined, 'fr',
      );
    });
  });
});

// ─── Layer 3: write-time invariant in buildTextAnnotation ───────────────
//
// The detection mocks here bypass the per-motivation parsers (which run
// `reconcileSelector` internally) and feed Match objects straight to the
// processor. That's exactly the path a bug or a future refactor that
// dropped reconciliation would create — the invariant in
// `buildTextAnnotation` must fail loudly in that case.

describe('buildTextAnnotation invariant', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws when content.substring(start, end) !== exact', async () => {
    // Highlight at offsets 0-9 but content there is "the quick" — mismatch.
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'important', start: 0, end: 9 },
    ]);

    await expect(
      processHighlightJob(
        'the quick brown fox',
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        USER_DID,
        GENERATOR,
        vi.fn(),
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content\.substring/);
  });

  it('throws when prefix does not align with content adjacent to start', async () => {
    // exact aligns, but prefix is bogus.
    const content = 'alpha BETA gamma';
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'BETA', start: 6, end: 10, prefix: 'WRONG PREFIX' },
    ]);

    await expect(
      processHighlightJob(
        content,
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        USER_DID,
        GENERATOR,
        vi.fn(),
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content prefix-slice/);
  });

  it('throws when suffix does not align with content adjacent to end', async () => {
    const content = 'alpha BETA gamma';
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'BETA', start: 6, end: 10, suffix: 'WRONG SUFFIX' },
    ]);

    await expect(
      processHighlightJob(
        content,
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        USER_DID,
        GENERATOR,
        vi.fn(),
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content suffix-slice/);
  });

  it('error message names the resource id and motivation', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockResolvedValue([
      { exact: 'never appears', start: 0, end: 13 },
    ]);

    await expect(
      processHighlightJob(
        'short',
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        USER_DID,
        GENERATOR,
        vi.fn(),
      ),
    ).rejects.toThrow(new RegExp(`resource ${RID}, motivation highlighting`));
  });
});

// ─── Layer 2: end-to-end through the real parsers ───────────────────────
//
// Per-motivation integration tests that feed synthetic LLM JSON responses
// with deliberately-bad offsets through the real
// `MotivationParsers` / `extractEntities` / `reconcileSelector` chain
// and assert the stored annotations satisfy the no-overlap invariant.
// These tests do NOT mock `@semiont/core`, so `reconcileSelector` runs
// for real against the test content.

describe('Layer 2: worker-parser integration via real reconcileSelector', () => {
  beforeEach(() => vi.clearAllMocks());

  it('highlight: no offsets in LLM response, reconciler anchors via unique-match', async () => {
    const content = 'preamble important text and more.';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(async (text) => {
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = JSON.stringify([{ exact: 'important' }]);
      return MotivationParsers.parseHighlights(fake, text);
    });

    const result = await processHighlightJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    const quoteSel = ann.target.selector.find((s: any) => s.type === 'TextQuoteSelector');
    expect(content.substring(posSel.start, posSel.end)).toBe(quoteSel.exact);
  });

  it('tag: overlapping LLM prefix is replaced with a source-extracted prefix', async () => {
    // The motivating bug pattern — LLM emits a prefix that overlaps the
    // start of exact. Reconciler must repair: anchor `exact` in the
    // source, extract a fresh prefix that no longer overlaps.
    const exact = 'The question for decision';
    const content = `Kenison, C.J.\n${exact} by this appeal.`;
    vi.mocked(AnnotationDetection.detectTags).mockImplementation(async (text) => {
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = JSON.stringify([
        {
          exact,
          prefix: 'Kenison, C.J.\nTh', // overlapping with start of exact
          suffix: ' by this appeal.',
        },
      ]);
      const parsed = MotivationParsers.parseTags(fake);
      return MotivationParsers.validateTagOffsets(parsed, text, 'Issue');
    });

    const result = await processTagJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'] },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    const quoteSel = ann.target.selector.find((s: any) => s.type === 'TextQuoteSelector');
    // Invariant: substring matches exact.
    expect(content.substring(posSel.start, posSel.end)).toBe(quoteSel.exact);
    // Returned prefix does not contain the overlapping "Th".
    expect(quoteSel.prefix).not.toContain('Th');
    // Stored start is at 14 (the true position), not 16.
    expect(posSel.start).toBe(14);
  });

  it('reference: hallucinated exact is dropped and counted as an error', async () => {
    vi.mocked(extractEntities).mockResolvedValue([
      { exact: 'Alice', start: 0, end: 5, entityType: 'Person' } as any,
      { exact: 'NoSuchPerson', start: 99, end: 111, entityType: 'Person' } as any,
    ]);

    const result = await processReferenceJob(
      'Alice went to Paris.',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Person')] },
      USER_DID,
      GENERATOR,
      vi.fn(),
      LOGGER,
    );

    expect(result.result).toEqual({ totalFound: 2, totalEmitted: 1, errors: 1 });
    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    const quoteSel = ann.target.selector.find((s: any) => s.type === 'TextQuoteSelector');
    expect((ann.target.source as string)).toBe(RID);
    expect(quoteSel.exact).toBe('Alice');
    expect(posSel.start).toBe(0);
    expect(posSel.end).toBe(5);
  });

  it('comment: multi-occurrence ambiguity with non-matching context falls back to first occurrence', async () => {
    // Content has three occurrences of 'foo'. Without offsets the LLM
    // can no longer hint; prefix/suffix that don't match anywhere yields
    // first-of-many, which is the first occurrence.
    const content = 'X foo Y foo Z foo W'; // foo at 2, 8, 14
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(async (text) => {
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = JSON.stringify([
        { exact: 'foo', prefix: 'IRRELEVANT_PREFIX', suffix: 'IRRELEVANT_SUFFIX', comment: 'one of them' },
      ]);
      return MotivationParsers.parseComments(fake, text);
    });

    const result = await processCommentJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    expect(posSel.start).toBe(2); // first occurrence
    expect(content.substring(posSel.start, posSel.end)).toBe('foo');
  });

  it('comment: matching prefix disambiguates to the right occurrence', async () => {
    const content = 'X foo Y foo Z foo W';
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(async (text) => {
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = JSON.stringify([
        { exact: 'foo', prefix: 'Y ', suffix: ' Z', comment: 'middle one' },
      ]);
      return MotivationParsers.parseComments(fake, text);
    });

    const result = await processCommentJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      USER_DID,
      GENERATOR,
      vi.fn(),
    );

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    expect(posSel.start).toBe(8); // middle occurrence, picked by prefix/suffix
    expect(content.substring(posSel.start, posSel.end)).toBe('foo');
  });
});
