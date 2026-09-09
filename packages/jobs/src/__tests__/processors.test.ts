import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GEN_REQUIRED } from './fixtures/generation-fixtures';
import { resourceId, entityType } from '@semiont/core';
import type { InferenceClient } from '@semiont/inference';
import type { components, TagSchema, GatheredContext, Logger, Annotation } from '@semiont/core';

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
  // Real value, not a stand-in: the fail-fast error message names this ceiling.
  DEFAULT_MAX_TOKENS: 500,
}));

vi.mock('../workers/generation/typst-compiler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workers/generation/typst-compiler')>()),
  compileTypst: vi.fn(),
}));

// No `@semiont/event-sourcing` mock: annotation ids are content-addressed
// (JOB-RESTART-SAFETY P3), so the real function is already deterministic. The
// mock existed only to buy that determinism, and keeping it would hide the
// identity these builders now compute — which is the thing worth exercising.

// No `@semiont/core` mock — these tests exercise the real `reconcileSelector`
// against synthetic content. The processor's `buildTextAnnotation` invariant
// runs `content.substring(start, end) === exact`, so the test content has
// to actually contain the entities we feed in.

import { AnnotationDetection } from '../workers/annotation-detection';
import { extractEntities } from '../workers/detection/entity-extractor';
import { generateResourceFromTopic } from '../workers/generation/resource-generation';
import { compileTypst, MAX_COMPILE_REPAIRS } from '../workers/generation/typst-compiler';
import type { PdfTextLayer } from '@semiont/content';
import {
  processHighlightJob,
  processCommentJob,
  processAssessmentJob,
  processReferenceJob,
  processTagJob,
  processGenerationJob,
  assertWithinOutputBudget,
  buildTextAnnotation,
  buildPdfAnnotation,
  type BuildAnnotation,
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

// The detection processors now take a media-agnostic `buildAnnotation`; for
// these text-detection tests it is `buildTextAnnotation` curried with the
// resource + attribution context (exactly what the processors used to do
// internally). Attribution shape is exercised through this closure.
const textBuild = (content: string, userId: string = USER_DID): BuildAnnotation =>
  (motivation, match, body) => buildTextAnnotation(content, RID, userId, GENERATOR, motivation, match, body);

// Synthetic two-line text layer — "alpha beta" / "gamma delta" — for the PDF
// path. `.text` is what a PDF processor detects over; `pdfBuild` anchors each
// detected span via `buildPdfAnnotation` (FragmentSelector viewrects, no
// TextPositionSelector), the media-appropriate builder `prepareDetection`
// hands a `pdf-text-layer` job.
const PDF_LAYER: PdfTextLayer = {
  pages: [{ pageNumber: 1, widthPt: 612, heightPt: 792, textStart: 0, textEnd: 22, hasTextLayer: true }],
  text: 'alpha beta\ngamma delta',
  items: [
    { start: 0,  end: 5,  page: 1, x: 72,  y: 720, width: 40, height: 12 }, // alpha
    { start: 6,  end: 10, page: 1, x: 118, y: 720, width: 34, height: 12 }, // beta
    { start: 11, end: 16, page: 1, x: 72,  y: 700, width: 45, height: 12 }, // gamma
    { start: 17, end: 22, page: 1, x: 125, y: 700, width: 42, height: 12 }, // delta
  ],
  fields: [],
};
const pdfBuild = (layer: PdfTextLayer, userId: string = USER_DID): BuildAnnotation =>
  (motivation, match, body) => buildPdfAnnotation(layer, RID, userId, GENERATOR, motivation, match, body);

// The concurrency the fake provider advertises — detection reads it off the
// client now (a real provider hard-codes its own), so tests set it here.
const TEST_MAX_CONCURRENCY = 4;
function makeInferenceClient(): InferenceClient {
  return {
    generateText: vi.fn(),
    maxConcurrency: TEST_MAX_CONCURRENCY,
  } as unknown as InferenceClient;
}

/**
 * Deliver mocked matches through the chunk-results callback (the last
 * positional argument) in one chunk — a plain mockResolvedValue starves the
 * processor of results entirely.
 */
const inOneChunk = (matches: unknown[]) => (async (...args: unknown[]) => {
  const cb = args[args.length - 1];
  if (typeof cb === 'function') await (cb as (m: unknown[]) => Promise<void>)(matches);
  return matches;
}) as never;

/** Run a motivation processor, collecting its chunk-committed annotations. */
async function collected<R>(
  run: (onChunkComplete: (a: Annotation[]) => Promise<void>) => Promise<{ result: R }>,
): Promise<{ annotations: Annotation[]; result: R }> {
  const annotations: Annotation[] = [];
  const { result } = await run(async (batch) => { annotations.push(...batch); });
  return { annotations, result };
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
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'important', start: 0, end: 9 },
      { exact: 'critical', start: content.indexOf('critical'), end: content.indexOf('critical') + 'critical'.length },
    ]));

    const progress = vi.fn();
    const result = await collected((onChunkComplete) => processHighlightJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      textBuild(content),
      progress, onChunkComplete));

    expect(result.annotations).toHaveLength(2);
    expect(result.annotations[0]).toMatchObject({
      motivation: 'highlighting',
      target: expect.objectContaining({ source: RID }),
    });
    // Highlights carry no body — motivation alone is the content per W3C.
    expect((result.annotations[0] as Record<string, unknown>).body).toBeUndefined();
    expect(result.result).toEqual({ kind: 'highlight-annotation', highlightsFound: 2, highlightsCreated: 2 });
    // The run's own parameters ride every event, including the first and last.
    const echo = { requestParams: [{ label: 'density', value: '5' }] };
    expect(progress).toHaveBeenCalledWith(10, { code: 'loading' }, echo);
    expect(progress).toHaveBeenLastCalledWith(
      100, { code: 'complete-created', count: 2, kind: 'highlight' }, echo,
    );
  });

  it('keeps distinct PDF highlights (dedupe must not key on an absent TextPositionSelector)', async () => {
    // Regression: PDF annotations carry no TextPositionSelector, so a dedupe
    // key built only from position offsets degrades to `highlighting|?|?|null`
    // and collapses every bodiless PDF highlight to one. Two distinct spans
    // must survive as two annotations, anchored by FragmentSelector geometry.
    const content = PDF_LAYER.text; // 'alpha beta\ngamma delta'
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'alpha', start: 0, end: 5 },
      { exact: 'delta', start: 17, end: 22 },
    ]));

    const result = await collected((onChunkComplete) => processHighlightJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      pdfBuild(PDF_LAYER),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(2);
    expect(result.result).toEqual({ kind: 'highlight-annotation', highlightsFound: 2, highlightsCreated: 2 });
    for (const ann of result.annotations) {
      const selectors = (ann as { target: { selector: Array<{ type: string }> } }).target.selector;
      expect(selectors.some((s) => s.type === 'FragmentSelector')).toBe(true);
      expect(selectors.some((s) => s.type === 'TextPositionSelector')).toBe(false);
    }
  });
});

describe('processCommentJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces commenting annotations with TextualBody', async () => {
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
      { exact: 'passage', start: 0, end: 7, comment: 'interesting point' },
    ]));

    const result = await collected((onChunkComplete) => processCommentJob(
      'passage here',
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      textBuild('passage here'),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(1);
    expect((result.annotations[0] as any).motivation).toBe('commenting');
    // Canonical commenting body — single-item array of TextualBody with
    // format + language. Do not drop format/language; the pre-#651
    // CommentAnnotationWorker emitted them and consumers may rely on
    // them for rendering.
    expect((result.annotations[0] as any).body).toEqual([
      { type: 'TextualBody', value: 'interesting point', purpose: 'commenting', format: 'text/plain', language: 'en' },
    ]);
    expect(result.result).toEqual({ kind: 'comment-annotation', commentsFound: 1, commentsCreated: 1 });
  });
});

describe('processAssessmentJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces assessing annotations with TextualBody', async () => {
    vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([
      { exact: 'claim', start: 0, end: 5, assessment: 'dubious' },
    ]));

    const result = await collected((onChunkComplete) => processAssessmentJob(
      'claim made',
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      textBuild('claim made'),
      vi.fn(), onChunkComplete));

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
    expect(result.result).toEqual({ kind: 'assessment-annotation', assessmentsFound: 1, assessmentsCreated: 1 });
  });
});

describe('processReferenceJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces linking annotations and tracks per-entity-type progress', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      { exact: 'Berlin', start: 10, end: 16, entityType: 'Location' } as any,
    ]));

    const progress = vi.fn();
    const committed: unknown[] = [];
    const outcome = await processReferenceJob(
      'Paris and Berlin',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris and Berlin'),
      progress,
      LOGGER,
      async () => {},
      undefined,
      async (annotations) => {
        committed.push(...annotations);
      },
    );

    expect(committed).toHaveLength(2);
    expect((committed[0] as any).motivation).toBe('linking');
    // Canonical unresolved-linking body — single-item array with the
    // entity type as a tagging TextualBody, stamped with format and the
    // body locale (defaults to 'en'). The bind flow later appends a
    // SpecificResource to resolve. Do not emit `[]` — that breaks the
    // append contract and trips the Annotation.body oneOf.
    expect((committed[0] as any).body).toEqual([
      { type: 'TextualBody', value: 'Location', purpose: 'tagging', format: 'text/plain', language: 'en' },
    ]);
    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 2, totalEmitted: 2, errors: 0 });
  });

  // ── P6: entity types run concurrently (DETECTION-QUALITY-THROUGHPUT) ──
  //
  // The sequential per-type loop was the 9×-sequential grind. These pin that
  // types now run bounded-concurrent: every type still commits exactly once and
  // reports its own found/persisted, order-independent, and no more than
  // DETECTION_TYPE_CONCURRENCY are ever in flight.

  it('runs multiple entity types and commits each exactly once', async () => {
    // Each type returns its own entity (verbatim in the content so anchoring holds).
    const content = 'Paris and Ada and Sony are here.';
    vi.mocked(extractEntities).mockImplementation(async (_c, types, _cl, _i, _l, _sl, _act, _verdicts, _counts, onChunkResults) => {
      const t = String(types[0]);
      const map: Record<string, any> = {
        Location: [{ exact: 'Paris', entityType: 'Location' }],
        Person: [{ exact: 'Ada', entityType: 'Person' }],
        Organization: [{ exact: 'Sony', entityType: 'Organization' }],
      };
      const items = map[t] ?? [];
      await onChunkResults?.(items);
      return items;
    });

    const units: string[] = [];
    const outcome = await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location'), entityType('Person'), entityType('Organization')] },
      textBuild(content), vi.fn(), LOGGER,
      async (unit) => { units.push(unit); },
    );

    expect(units.sort()).toEqual(['Location', 'Organization', 'Person']);
    expect(outcome.result.totalFound).toBe(3);
    expect(outcome.result.totalEmitted).toBe(3);
  });

  it('never runs more than the provider maxConcurrency types at once', async () => {
    const content = 'x '.repeat(50);
    let inFlight = 0, maxInFlight = 0;
    vi.mocked(extractEntities).mockImplementation(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });

    // More types than the bound, so the cap must actually clamp.
    const many = Array.from({ length: TEST_MAX_CONCURRENCY + 4 }, (_, i) => entityType(`T${i}`));
    await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: many },
      textBuild(content), vi.fn(), LOGGER, async () => {},
    );

    expect(maxInFlight).toBeGreaterThan(1); // actually concurrent
    expect(maxInFlight).toBeLessThanOrEqual(TEST_MAX_CONCURRENCY);
  });

  it('runs SEQUENTIALLY when the provider advertises maxConcurrency 1 (the Ollama case)', async () => {
    // A local single-model server gets no aggregate speedup from concurrent
    // requests and pays KV-cache memory for them, so its client advertises 1 —
    // and detection must then never overlap calls, exactly as before P6.
    const content = 'x '.repeat(50);
    let inFlight = 0, maxInFlight = 0;
    vi.mocked(extractEntities).mockImplementation(async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return [];
    });
    const ollamaShaped = { generateText: vi.fn(), maxConcurrency: 1 } as unknown as InferenceClient;

    await processReferenceJob(
      content, ollamaShaped,
      { resourceId: RID, entityTypes: [entityType('A'), entityType('B'), entityType('C'), entityType('D')] },
      textBuild(content), vi.fn(), LOGGER, async () => {},
    );

    expect(maxInFlight).toBe(1);
  });

  it('reports each unit once even when types finish OUT OF ORDER', async () => {
    const content = 'Paris and Ada are here.';
    // Location resolves slowly, Person fast — completion order reversed.
    vi.mocked(extractEntities).mockImplementation(async (_c, types, _cl, _i, _l, _sl, _act, _verdicts, _counts, onChunkResults) => {
      const t = String(types[0]);
      const items = t === 'Location'
        ? (await new Promise((r) => setTimeout(r, 20)), [{ exact: 'Paris', entityType: 'Location' }])
        : [{ exact: 'Ada', entityType: 'Person' }];
      await onChunkResults?.(items as any);
      return items as any;
    });

    const progress = vi.fn();
    const outcome = await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location'), entityType('Person')] },
      textBuild(content), progress, LOGGER, async () => {},
    );

    // The terminal frame carries the full completed set; each type appears once.
    const last = progress.mock.calls.at(-1)![2] as { completedItems?: Array<{ value: string }> };
    const values = (last.completedItems ?? []).map((i) => i.value).sort();
    expect(values).toEqual(['Location', 'Person']);
    expect(outcome.result.totalEmitted).toBe(2);
  });

  it('counts errors when reconciliation drops an entity (text not in source)', async () => {
    // 'good' is in the content; 'BADTEXT' is not — reconcileSelector drops
    // the second entity, the processor counts an error.
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'good', start: 0, end: 4, entityType: 'Thing' } as any,
      { exact: 'BADTEXT', start: 99, end: 106, entityType: 'Thing' } as any,
    ]));

    const committed: unknown[] = [];
    const outcome = await processReferenceJob(
      'good stuff',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Thing')] },
      textBuild('good stuff'),
      vi.fn(),
      LOGGER,
      async () => {},
      undefined,
      async (annotations) => {
        committed.push(...annotations);
      },
    );

    expect(committed).toHaveLength(1);
    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 2, totalEmitted: 1, errors: 1 });
  });

  it('returns zero counts when no entities are found — and still commits the empty unit', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([]));

    const onUnitComplete = vi.fn(async () => {});
    const outcome = await processReferenceJob(
      'content',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('content'),
      vi.fn(),
      LOGGER,
      onUnitComplete,
    );

    // Legitimately-empty is a completed unit (A3 v) — a retry must skip it.
    expect(onUnitComplete).toHaveBeenCalledExactlyOnceWith('Location');
    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 0, totalEmitted: 0, errors: 0 });
  });
});

// ── JOB-RESTART-SAFETY P6: the unit gates on the COMMIT, not on the emit ────
//
// `onUnitComplete` is the durability seam. Before P6 the worker's version of it
// emitted `mark:create` fire-and-forget and returned, so a down Archivist lost
// the unit silently and a flapping one hung the worker forever. It now awaits a
// `mark:commit` acknowledgement, which means a rejecting sink must stop the
// unit from counting — and a recovering one must let it through.
//
// Tested here rather than at the worker because this is where "counts anywhere"
// is decided: the loop awaits the callback BEFORE touching totals, completed
// items, or the checkpoint list.
describe('processReferenceJob — unit completion gates on the commit (P6)', () => {
  beforeEach(() => vi.clearAllMocks());

  // DETECTION-QUALITY-THROUGHPUT P1. The baseline's headline number — "Person
  // 935 found / 844 persisted" — had to be reconstructed by reading logs,
  // because the per-unit result reported only what the model PROPOSED. The gap
  // is dedupe plus the commit ack, and it is the yield every sizing decision is
  // judged against, so it belongs on the result rather than in an operator's
  // head.
  it('reports found AND persisted per unit — the gap between them is the yield', async () => {
    // Three proposals, two distinct spans: the duplicate collapses in dedupe,
    // so found and persisted must differ here or the test proves nothing.
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      { exact: 'Berlin', start: 10, end: 16, entityType: 'Location' } as any,
    ]));
    const onProgress = vi.fn();

    await processReferenceJob(
      'Paris and Berlin',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris and Berlin'),
      onProgress,
      LOGGER,
      vi.fn(async () => {}),
    );

    const completed = onProgress.mock.calls
      .map(c => (c[2] as { completedItems?: Array<{ value: string; foundCount: number; persistedCount?: number }> } | undefined)?.completedItems)
      .filter((items): items is Array<{ value: string; foundCount: number; persistedCount?: number }> => !!items?.length)
      .at(-1);

    expect(completed).toEqual([
      { value: 'Location', foundCount: 3, persistedCount: 2 },
    ]);
  });

  it('a rejecting sink stops the unit counting, and the failure reaches the caller', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
    ]));
    const onUnitComplete = vi.fn(async () => {});
    const onChunkComplete = vi.fn(async () => { throw new Error('mark:commit failed: sink down'); });

    await expect(processReferenceJob(
      'Paris and Berlin',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris and Berlin'),
      vi.fn(),
      LOGGER,
      onUnitComplete,
      undefined,
      onChunkComplete,
    )).rejects.toThrow(/sink down/);

    // The point of the phase: an un-acked chunk must NOT let the unit
    // checkpoint. Swallowing here is what turned an Archivist outage into
    // silent data loss — the unit would advance, the checkpoint would record
    // it, and a resume would skip work that never persisted.
    expect(onChunkComplete).toHaveBeenCalledTimes(1);
    expect(onUnitComplete).not.toHaveBeenCalled();
  });

  it('a sink that recovers lets the unit through and counts it once', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
    ]));
    let attempt = 0;
    const onChunkComplete = vi.fn(async () => {
      if (++attempt === 1) throw new Error('mark:commit failed: sink down');
    });

    // First pass fails at the chunk commit.
    await expect(processReferenceJob(
      'Paris and Berlin', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris and Berlin'), vi.fn(), LOGGER, async () => {}, undefined, onChunkComplete,
    )).rejects.toThrow();

    // The retry — the whole unit again; the log dedupes by id.
    const outcome = await processReferenceJob(
      'Paris and Berlin', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris and Berlin'), vi.fn(), LOGGER, async () => {}, undefined, onChunkComplete,
    );

    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 1, totalEmitted: 1, errors: 0 });
    expect(attempt).toBe(2);
  });
});

describe('processTagJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('produces tagging annotations grouped by category', async () => {
    vi.mocked(AnnotationDetection.detectTags)
      .mockImplementationOnce(inOneChunk([
        { exact: 'foo', start: 0, end: 3, category: 'catA' } as any,
        { exact: 'bar', start: 4, end: 7, category: 'catA' } as any,
      ]))
      .mockImplementationOnce(inOneChunk([
        { exact: 'baz', start: 8, end: 11, category: 'catB' } as any,
      ]));

    const result = await collected((onChunkComplete) => processTagJob(
      'foo bar baz',
      makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['catA', 'catB'] },
      textBuild('foo bar baz'),
      vi.fn(), onChunkComplete));

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
      kind: 'tag-annotation',
      tagsFound: 3,
      tagsCreated: 3,
      byCategory: { catA: 2, catB: 1 },
    });
  });
});

describe('processGenerationJob', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates content and returns the CALLER\'s title + format', async () => {
    // The generator echoes the caller's topic verbatim (resource-generation.ts
    // parseResponse: "Title is provided by the caller (topic), not extracted") —
    // so the processor's title is the request's title, unconditionally. The mock
    // mirrors that contract; a diverging title is a state that cannot occur.
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: '# Generated resource\n\nBody.',
      title: 'Initial',
      truncated: false,
    });

    const progress = vi.fn();
    const result = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED,
        title: 'Initial',
        entityTypes: [],
      },
      progress,
      LOGGER,
    );

    expect(new TextDecoder().decode(result.content)).toContain('Generated resource');
    expect(result.title).toBe('Initial');
    expect(result.format).toBe('text/markdown');
    expect(result.result.resourceName).toBe('Initial');
    // A natural stop reports truncated: false — required, never absent (P3a/D6:
    // the producer always knows; structure expresses it).
    expect(result.result.truncated).toBe(false);
    // Honest lifecycle: generation has exactly two real transitions — the LLM
    // call starting, and content finalized / creation beginning. No 'fetching'
    // stage (it labeled zero work; context arrives pre-gathered in params).
    // Percentages approximate the share of expected wall-clock complete at each
    // transition: inference dominates, so its start is ~5 and its end ~95.
    // The producer owns terminality (GENERATE-FROM-RESOURCE P1/D1): the run
    // ends with a terminal code at 100, like every annotation flow — without
    // it, the client's last frame forever says 95% "creating".
    expect(progress).toHaveBeenCalledTimes(3);
    expect(progress).toHaveBeenNthCalledWith(1, 5, { code: 'generating-resource' });
    expect(progress).toHaveBeenNthCalledWith(2, 95, { code: 'creating-resource' });
    expect(progress).toHaveBeenNthCalledWith(3, 100, { code: 'complete-generated', truncated: false });
  });

  it('a max_tokens stop reports truncated on the terminal event AND the result (P3a)', async () => {
    // N7: the worker KNOWS the artifact was cut off and used to tell nobody.
    // The bit rides both surfaces — the event (the frame P3b renders) and the
    // result (the record).
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: 'Cut off mid-sen',
      title: 'Initial',
      truncated: true,
    });

    const progress = vi.fn();
    const result = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'Initial', entityTypes: [] },
      progress,
      LOGGER,
    );

    expect(result.result.truncated).toBe(true);
    expect(progress).toHaveBeenNthCalledWith(3, 100, { code: 'complete-generated', truncated: true });
  });

});

describe('processGenerationJob — inline citations (INLINE-CITATIONS P1)', () => {
  // The resolver runs inside processGenerationJob: parse [[<id>]] transport
  // tokens from the generated content, validate each against the ids actually
  // present in the embedded context (hallucination guard), STRIP the tokens
  // from the stored content, and return claim-span citations for the worker
  // to mint as linking annotations.
  const CITE_CONTEXT: GatheredContext = {
    focus: {
      kind: 'resource',
      resource: {
        '@context': 'https://www.w3.org/ns/anno.jsonld',
        '@id': 'src-1',
        name: 'Source Doc',
        representations: [],
      },
    },
    graph: {
      nodes: [
        { id: 'src-1', type: 'resource', label: 'Source Doc' },
        { id: 'ctx-9', type: 'resource', label: 'Context Doc' },
      ],
      edges: [],
    },
    metadata: {},
  };

  function makeWarnLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
    const warn = vi.fn();
    const logger: Logger = { debug: () => {}, info: () => {}, warn, error: () => {}, child: () => logger };
    return { logger, warn };
  }

  it('strips tokens from the content and returns claim-span citations', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: 'Paris is the capital of France. [[ctx-9]] It is large.',
      title: 'T',
      truncated: false,
    });

    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', cite: true, context: CITE_CONTEXT },
      vi.fn(),
      LOGGER,
    );

    const text = new TextDecoder().decode(r.content);
    expect(text).toBe('Paris is the capital of France. It is large.');
    expect(r.citations).toHaveLength(1);
    const c = r.citations[0]!;
    expect(c.resourceId).toBe('ctx-9');
    expect(c.exact).toBe('Paris is the capital of France.');
    // anchor invariant: the selector must reproduce exact from the FINAL content
    // (citation offsets index the decoded text)
    expect(text.substring(c.start, c.end)).toBe(c.exact);
  });

  it('drops a hallucinated id loudly — stripped, warned, no citation', async () => {
    const { logger, warn } = makeWarnLogger();
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: 'A bold claim. [[not-in-context]]',
      title: 'T',
      truncated: false,
    });

    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', cite: true, context: CITE_CONTEXT },
      vi.fn(),
      logger,
    );

    expect(new TextDecoder().decode(r.content)).toBe('A bold claim.');
    expect(r.citations).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('cite unset leaves bracketed content untouched (no accidental stripping)', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: 'Wiki-style [[links]] are legitimate content.',
      title: 'T',
      truncated: false,
    });

    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', context: CITE_CONTEXT },
      vi.fn(),
      LOGGER,
    );

    expect(new TextDecoder().decode(r.content)).toBe('Wiki-style [[links]] are legitimate content.');
    expect(r.citations).toHaveLength(0);
  });
});

describe('processGenerationJob — byte return (PDF-GENERATION P1)', () => {
  // The artifact is bytes. Text is an encoding of them — one shape for every
  // output media type, so a string can never travel mislabeled as a binary
  // format. The sole consumer (worker upload) already does Buffer.from().
  it('returns the artifact content as Uint8Array', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: 'Generated body', title: 'T', truncated: false });

    const r = await processGenerationJob(makeInferenceClient(), { ...GEN_REQUIRED, title: 'T' }, vi.fn(), LOGGER);

    expect(r.content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(r.content)).toBe('Generated body');
  });
});

describe('processGenerationJob — PDF generation via Typst (PDF-GENERATION P3)', () => {
  beforeEach(() => {
    vi.mocked(compileTypst).mockReset();
    vi.mocked(generateResourceFromTopic).mockReset();
  });

  it('compiles model-authored Typst to PDF bytes', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: '= Title\nBody.', title: 'T', truncated: false });
    const pdf = new TextEncoder().encode('%PDF-FAKE');
    vi.mocked(compileTypst).mockReturnValue({ pdf });

    const progress = vi.fn();
    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf' },
      progress,
      LOGGER,
    );

    expect(compileTypst).toHaveBeenCalledWith('= Title\nBody.');
    expect(r.content).toBe(pdf);
    expect(r.format).toBe('application/pdf');
    // Terminal honesty (GENERATE-FROM-RESOURCE P1): the PDF path ends like
    // every other flow — a terminal code at 100, never a dangling 95.
    expect(progress.mock.calls.at(-1)).toEqual([100, { code: 'complete-generated', truncated: false }]);
  });

  it('a truncated source that still compiles carries the truncated flag (P3a)', async () => {
    // Truncation that happens to land at a syntactic boundary compiles fine —
    // the artifact is still incomplete, and the bit still travels.
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: '= Title\nCut off', title: 'T', truncated: true });
    const pdf = new TextEncoder().encode('%PDF-FAKE');
    vi.mocked(compileTypst).mockReturnValue({ pdf });

    const progress = vi.fn();
    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf' },
      progress,
      LOGGER,
    );

    expect(r.result.truncated).toBe(true);
    expect(progress.mock.calls.at(-1)).toEqual([100, { code: 'complete-generated', truncated: true }]);
  });

  it('a truncated source that fails to compile fails FAST, naming the ceiling — no repairs (P3a)', async () => {
    // Repair cannot restore content that was never generated: the source is
    // cut off, not wrong, and every repair regenerates under the same ceiling.
    // Burning the repair budget here would end in an error naming a compile
    // problem the user cannot fix; the honest error names the token ceiling.
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: '#let broken = [cut', title: 'T', truncated: true });
    vi.mocked(compileTypst).mockReturnValue({ error: 'error: unclosed delimiter' });

    await expect(
      processGenerationJob(
        makeInferenceClient(),
        { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf' },
        vi.fn(),
        LOGGER,
      ),
    ).rejects.toThrow(/maxTokens ceiling/);

    expect(generateResourceFromTopic).toHaveBeenCalledTimes(1);
  });

  it('feeds a compile error back for a bounded repair, then succeeds', async () => {
    vi.mocked(generateResourceFromTopic)
      .mockResolvedValueOnce({ content: '#let broken = [unclosed', title: 'T', truncated: false })
      .mockResolvedValueOnce({ content: '= Fixed\nBody.', title: 'T', truncated: false });
    const pdf = new TextEncoder().encode('%PDF-FAKE');
    vi.mocked(compileTypst)
      .mockReturnValueOnce({ error: 'error: unclosed delimiter\n  ┌─ doc.typ:1:14' })
      .mockReturnValueOnce({ pdf });

    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf' },
      vi.fn(),
      LOGGER,
    );

    expect(r.content).toBe(pdf);
    expect(generateResourceFromTopic).toHaveBeenCalledTimes(2);
    // The repair call carries the failed source + the legible error (last arg).
    const repairArg = vi.mocked(generateResourceFromTopic).mock.calls[1]!.at(-1);
    expect(repairArg).toMatchObject({
      source: '#let broken = [unclosed',
      error: expect.stringContaining('unclosed delimiter'),
    });
  });

  it('gives up loudly after the bounded repairs are exhausted', async () => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: '#broken', title: 'T', truncated: false });
    vi.mocked(compileTypst).mockReturnValue({ error: 'error: unclosed delimiter' });

    await expect(
      processGenerationJob(makeInferenceClient(), { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf' }, vi.fn(), LOGGER),
    ).rejects.toThrow(/unclosed delimiter/);

    // 1 initial + MAX_COMPILE_REPAIRS attempts, then fail — no unbounded loop.
    expect(generateResourceFromTopic).toHaveBeenCalledTimes(1 + MAX_COMPILE_REPAIRS);
  });

  it('cite with application/pdf strips tokens BEFORE compile and carries citations (P4)', async () => {
    // Tokens must never render into the PDF; the claim `exact` strings travel
    // to the worker, which anchors them by page geometry after extraction.
    const CITE_PDF_CONTEXT = {
      focus: {
        kind: 'resource',
        resource: { '@context': 'https://www.w3.org/ns/anno.jsonld', '@id': 'src-1', name: 'Src', representations: [] },
      },
      graph: { nodes: [{ id: 'src-1', type: 'resource', label: 'Src' }, { id: 'ctx-9', type: 'resource', label: 'Ctx' }], edges: [] },
      metadata: {},
    } as GatheredContext;
    vi.mocked(generateResourceFromTopic).mockResolvedValue({
      content: '= Answer\nParis is the capital of France. [[ctx-9]]',
      title: 'T',
      truncated: false,
    });
    const pdf = new TextEncoder().encode('%PDF-FAKE');
    vi.mocked(compileTypst).mockReturnValue({ pdf });

    const r = await processGenerationJob(
      makeInferenceClient(),
      { ...GEN_REQUIRED, title: 'T', outputMediaType: 'application/pdf', cite: true, context: CITE_PDF_CONTEXT },
      vi.fn(),
      LOGGER,
    );

    // stripped source reached the compiler — no token in the artifact
    expect(compileTypst).toHaveBeenCalledWith('= Answer\nParis is the capital of France.');
    expect(r.content).toBe(pdf);
    expect(r.citations).toHaveLength(1);
    expect(r.citations[0]).toMatchObject({
      resourceId: 'ctx-9',
      exact: 'Paris is the capital of France.',
    });
  });
});

describe('processGenerationJob — output bound (PDF-GENERATION P5)', () => {
  // Symmetric with #1124's extraction byte budget, and deliberately the SAME
  // threshold: a generated artifact larger than what extraction accepts would
  // be a resource our own Smelter declines as 'too-large'. Tested by the
  // numbers — the judgment doesn't require materializing 200 MB (the same
  // rationale content's withinByteBudget records).
  it('accepts an artifact exactly at the budget and refuses one past it', async () => {
    const { MAX_PDF_BYTES } = await import('@semiont/content');
    expect(() => assertWithinOutputBudget(MAX_PDF_BYTES)).not.toThrow();
    expect(() => assertWithinOutputBudget(MAX_PDF_BYTES + 1)).toThrow(/output byte budget/);
  });
});

describe('processGenerationJob — outputMediaType', () => {
  beforeEach(() => {
    vi.mocked(generateResourceFromTopic).mockResolvedValue({ content: 'c', title: 'T', truncated: false });
  });

  it('defaults the generated resource format to text/markdown', async () => {
    const r = await processGenerationJob(makeInferenceClient(), { ...GEN_REQUIRED, title: 'T' }, vi.fn(), LOGGER);
    expect(r.format).toBe('text/markdown');
  });

  it('honors a requested text/plain outputMediaType', async () => {
    const r = await processGenerationJob(makeInferenceClient(), { ...GEN_REQUIRED, title: 'T', outputMediaType: 'text/plain' }, vi.fn(), LOGGER);
    expect(r.format).toBe('text/plain');
  });

  it('throws for an unsupported outputMediaType — before the LLM call, no silent fallback', async () => {
    vi.mocked(generateResourceFromTopic).mockClear();
    await expect(
      processGenerationJob(makeInferenceClient(), { ...GEN_REQUIRED, title: 'T', outputMediaType: 'image/png' }, vi.fn(), LOGGER),
    ).rejects.toThrow(/unsupported outputMediaType/i);
    expect(generateResourceFromTopic).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Attribution composition (creator / generator / wasAttributedTo)
// ============================================================================

describe('annotation attribution composition', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stamps both creator (Person) and generator (Software) on human-prompted AI work', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'snippet', start: 0, end: 7 },
    ]));

    const result = await collected((onChunkComplete) => processHighlightJob(
      'snippet',
      makeInferenceClient(),
      { resourceId: RID, density: 1 },
      textBuild('snippet'),
      vi.fn(), onChunkComplete));

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
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'snippet', start: 0, end: 7 },
    ]));

    const result = await collected((onChunkComplete) => processHighlightJob(
      'snippet',
      makeInferenceClient(),
      { resourceId: RID, density: 1 },
      textBuild('snippet', autonomousDid),
      vi.fn(), onChunkComplete));

    const ann = result.annotations[0] as Record<string, unknown>;
    const wasAttributedTo = ann['wasAttributedTo'] as Array<{ '@id': string }>;

    expect(wasAttributedTo).toHaveLength(1);
    expect(wasAttributedTo[0]!['@id']).toBe(GENERATOR['@id']);
  });

  it('applies the same attribution shape across every motivation', async () => {
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
      { exact: 'x', start: 0, end: 1, comment: 'c' },
    ]));
    vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([
      { exact: 'x', start: 0, end: 1, assessment: 'a' },
    ]));
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'x', start: 0, end: 1, entityType: 'Person' } as any,
    ]));
    vi.mocked(AnnotationDetection.detectTags).mockImplementation(inOneChunk([
      { exact: 'x', start: 0, end: 1, category: 'c' },
    ]));

    const referenceCommitted: unknown[] = [];
    const sources = await Promise.all([
      collected((onChunkComplete) => processCommentJob('x', makeInferenceClient(), { resourceId: RID, density: 1 }, textBuild('x'), vi.fn(), onChunkComplete)),
      collected((onChunkComplete) => processAssessmentJob('x', makeInferenceClient(), { resourceId: RID, density: 1 }, textBuild('x'), vi.fn(), onChunkComplete)),
      processReferenceJob('x', makeInferenceClient(), { resourceId: RID, entityTypes: [entityType('Person')] }, textBuild('x'), vi.fn(), LOGGER,
        async () => {}, undefined, async (annotations) => { referenceCommitted.push(...annotations); }),
      collected((onChunkComplete) => processTagJob('x', makeInferenceClient(), { resourceId: RID, schema: 'schema-1', categories: ['c'], sourceLanguage: 'en' } as never, textBuild('x'), vi.fn(), onChunkComplete)),
    ]);

    const firstAnnotations = [
      ...sources.flatMap((s) => ('annotations' in s ? [s.annotations[0]] : [])),
      referenceCommitted[0],
    ];
    for (const first of firstAnnotations) {
      const ann = first as Record<string, unknown>;
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
      vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
        { exact: 'passage', start: 0, end: 7, comment: 'commentaire' },
      ]));

      const result = await collected((onChunkComplete) => processCommentJob(
        'passage here',
        makeInferenceClient(),
        { resourceId: RID, language: 'fr' },
        textBuild('passage here'),
        vi.fn(), onChunkComplete));

      expect((result.annotations[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'commentaire', purpose: 'commenting', format: 'text/plain', language: 'fr' },
      ]);
    });

    it('stamps params.language on the assessment TextualBody', async () => {
      vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([
        { exact: 'claim', start: 0, end: 5, assessment: 'évaluation' },
      ]));

      const result = await collected((onChunkComplete) => processAssessmentJob(
        'claim made',
        makeInferenceClient(),
        { resourceId: RID, language: 'fr' },
        textBuild('claim made'),
        vi.fn(), onChunkComplete));

      expect((result.annotations[0] as any).body).toEqual({
        type: 'TextualBody', value: 'évaluation', purpose: 'assessing', format: 'text/plain', language: 'fr',
      });
    });

    it('stamps params.language on the unresolved-reference TextualBody', async () => {
      vi.mocked(extractEntities).mockImplementation(inOneChunk([
        { exact: 'Paris', start: 0, end: 5, entityType: 'Location' } as any,
      ]));

      const committed: unknown[] = [];
      await processReferenceJob(
        'Paris',
        makeInferenceClient(),
        { resourceId: RID, entityTypes: [entityType('Location')], language: 'fr' },
        textBuild('Paris'),
        vi.fn(),
        LOGGER,
        async () => {},
        undefined,
        async (annotations) => {
          committed.push(...annotations);
        },
      );

      expect((committed[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'Location', purpose: 'tagging', format: 'text/plain', language: 'fr' },
      ]);
    });

    it('stamps params.language on the tagging TextualBody (not the classifying one)', async () => {
      vi.mocked(AnnotationDetection.detectTags).mockImplementationOnce(inOneChunk([
        { exact: 'foo', start: 0, end: 3, category: 'Issue' } as any,
      ]));

      const result = await collected((onChunkComplete) => processTagJob(
        'foo bar',
        makeInferenceClient(),
        { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'], language: 'de' },
        textBuild('foo bar'),
        vi.fn(), onChunkComplete));

      // Only the tagging body carries `language` — the classifying body is
      // a schema-id reference and has no natural-language interpretation.
      expect((result.annotations[0] as any).body).toEqual([
        { type: 'TextualBody', value: 'Issue',    purpose: 'tagging',     format: 'text/plain', language: 'de' },
        { type: 'TextualBody', value: 'schema-1', purpose: 'classifying', format: 'text/plain' },
      ]);
    });

    it('defaults to "en" when params.language is omitted (comment)', async () => {
      vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
        { exact: 'passage', start: 0, end: 7, comment: 'note' },
      ]));

      const result = await collected((onChunkComplete) => processCommentJob(
        'passage here',
        makeInferenceClient(),
        { resourceId: RID },
        textBuild('passage here'),
        vi.fn(), onChunkComplete));

      expect((result.annotations[0] as any).body[0].language).toBe('en');
    });
  });

  describe('source-resource locale', () => {
    // sourceLanguage flows from params through to the detection function as
    // a positional argument. We assert each detection mock saw it.

    it('forwards sourceLanguage to detectHighlights', async () => {
      vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await collected((onChunkComplete) => processHighlightJob(
        'content', client,
        { resourceId: RID, sourceLanguage: 'fr' },
        textBuild('content'), vi.fn(), onChunkComplete));

      expect(AnnotationDetection.detectHighlights).toHaveBeenCalledWith(
        'content', client, undefined, undefined, 'fr',
        expect.any(Function), // chunk-boundary progress heartbeat (Phase 3b)
        expect.any(Function), // chunk-results emission
      );
    });

    it('forwards sourceLanguage and language to detectComments', async () => {
      vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await collected((onChunkComplete) => processCommentJob(
        'content', client,
        { resourceId: RID, language: 'de', sourceLanguage: 'fr' },
        textBuild('content'), vi.fn(), onChunkComplete));

      expect(AnnotationDetection.detectComments).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined, 'de', 'fr',
        expect.any(Function), // chunk-boundary progress heartbeat (Phase 3b)
        expect.any(Function), // chunk-results emission
      );
    });

    it('forwards sourceLanguage and language to detectAssessments', async () => {
      vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await collected((onChunkComplete) => processAssessmentJob(
        'content', client,
        { resourceId: RID, language: 'es', sourceLanguage: 'pt' },
        textBuild('content'), vi.fn(), onChunkComplete));

      expect(AnnotationDetection.detectAssessments).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined, 'es', 'pt',
        expect.any(Function), // chunk-boundary progress heartbeat (Phase 3b)
        expect.any(Function), // chunk-results emission
      );
    });

    it('forwards sourceLanguage to extractEntities for reference detection', async () => {
      vi.mocked(extractEntities).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await processReferenceJob(
        'content', client,
        { resourceId: RID, entityTypes: [entityType('Location')], sourceLanguage: 'fr' },
        textBuild('content'), vi.fn(),
        LOGGER, async () => {},
      );

      expect(extractEntities).toHaveBeenCalledWith(
        'content', ['Location'], client, false, LOGGER, 'fr',
        expect.any(Function), // chunk-boundary progress heartbeat
        expect.any(Function), // under-report verdicts
        expect.any(Function), // accepted-piece counts
        expect.any(Function), // chunk-results emission
      );
    });

    it('forwards sourceLanguage to detectTags', async () => {
      vi.mocked(AnnotationDetection.detectTags).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await collected((onChunkComplete) => processTagJob(
        'content', client,
        { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'], sourceLanguage: 'fr' },
        textBuild('content'), vi.fn(), onChunkComplete));

      // Worker now receives the full schema (resolved by the dispatcher),
      // not a schemaId.
      expect(AnnotationDetection.detectTags).toHaveBeenCalledWith(
        'content', client, SCHEMA_1, 'Issue', 'fr',
        expect.any(Function), // chunk-boundary progress heartbeat (Phase 3b)
        expect.any(Function), // chunk-results emission
      );
    });

    it('passes undefined sourceLanguage when caller omits it', async () => {
      vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([]));
      const client = makeInferenceClient();

      await collected((onChunkComplete) => processHighlightJob(
        'content', client, { resourceId: RID }, textBuild('content'), vi.fn(), onChunkComplete));

      expect(AnnotationDetection.detectHighlights).toHaveBeenCalledWith(
        'content', client, undefined, undefined, undefined,
        expect.any(Function), // chunk-boundary progress heartbeat (Phase 3b)
        expect.any(Function), // chunk-results emission
      );
    });

    it('forwards sourceLanguage and language to generateResourceFromTopic', async () => {
      vi.mocked(generateResourceFromTopic).mockResolvedValue({
        content: 'text', title: 'T', truncated: false,
      } as any);
      const client = makeInferenceClient();

      await processGenerationJob(
        client,
        {
          ...GEN_REQUIRED,
          title: 'Topic',
          entityTypes: [],
          language: 'de',
          sourceLanguage: 'fr',
        },
        vi.fn(),
        LOGGER,
      );

      // Positional signature: topic, entityTypes, client, logger, prompt, locale,
      // context, temperature, maxTokens, sourceLanguage, outputMediaType, task, structure, cite.
      // Context is no longer optional on the wire (GenerationJobParams
      // required trio) — the fixture context threads through where the
      // all-optional era pinned `undefined`.
      expect(generateResourceFromTopic).toHaveBeenCalledWith(
        'Topic', [], client, LOGGER, undefined, 'de', GEN_REQUIRED.context,
        undefined, undefined, 'fr', 'text/markdown', undefined, undefined, undefined,
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
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'important', start: 0, end: 9 },
    ]));

    await expect(
      processHighlightJob(
        'the quick brown fox',
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        textBuild('the quick brown fox'),
        vi.fn(),
        async () => {},
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content\.substring/);
  });

  it('throws when prefix does not align with content adjacent to start', async () => {
    // exact aligns, but prefix is bogus.
    const content = 'alpha BETA gamma';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'BETA', start: 6, end: 10, prefix: 'WRONG PREFIX' },
    ]));

    await expect(
      processHighlightJob(
        content,
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        textBuild(content),
        vi.fn(),
        async () => {},
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content prefix-slice/);
  });

  it('throws when suffix does not align with content adjacent to end', async () => {
    const content = 'alpha BETA gamma';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'BETA', start: 6, end: 10, suffix: 'WRONG SUFFIX' },
    ]));

    await expect(
      processHighlightJob(
        content,
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        textBuild(content),
        vi.fn(),
        async () => {},
      ),
    ).rejects.toThrow(/buildTextAnnotation invariant: content suffix-slice/);
  });

  it('error message names the resource id and motivation', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'never appears', start: 0, end: 13 },
    ]));

    await expect(
      processHighlightJob(
        'short',
        makeInferenceClient(),
        { resourceId: RID, density: 5 },
        textBuild('short'),
        vi.fn(),
        async () => {},
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
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation((async (...args: unknown[]) => {
      const text = args[0] as string;
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = [{ exact: 'important' }];
      const parsed = MotivationParsers.parseHighlights(fake, text);
      const cb = args[args.length - 1];
      if (typeof cb === 'function') await (cb as (x: unknown[]) => Promise<void>)(parsed as never);
      return parsed;
    }) as never);

    const result = await collected((onChunkComplete) => processHighlightJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      textBuild(content),
      vi.fn(), onChunkComplete));

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
    vi.mocked(AnnotationDetection.detectTags).mockImplementation((async (...args: unknown[]) => {
      const text = args[0] as string;
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = [
        {
          exact,
          prefix: 'Kenison, C.J.\nTh', // overlapping with start of exact
          suffix: ' by this appeal.',
        },
      ];
      // detectTags delivers only ANCHORED matches; the stand-in does too.
      const parsed = MotivationParsers.validateTagOffsets(MotivationParsers.parseTags(fake), text, 'Issue');
      const cb = args[args.length - 1];
      if (typeof cb === 'function') await (cb as (x: unknown[]) => Promise<void>)(parsed as never);
      return parsed;
    }) as never);

    const result = await collected((onChunkComplete) => processTagJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'] },
      textBuild(content),
      vi.fn(), onChunkComplete));

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
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Alice', start: 0, end: 5, entityType: 'Person' } as any,
      { exact: 'NoSuchPerson', start: 99, end: 111, entityType: 'Person' } as any,
    ]));

    const committed: unknown[] = [];
    const outcome = await processReferenceJob(
      'Alice went to Paris.',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Person')] },
      textBuild('Alice went to Paris.'),
      vi.fn(),
      LOGGER,
      async () => {},
      undefined,
      async (annotations) => {
        committed.push(...annotations);
      },
    );

    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 2, totalEmitted: 1, errors: 1 });
    expect(committed).toHaveLength(1);
    const ann = committed[0] as any;
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
    vi.mocked(AnnotationDetection.detectComments).mockImplementation((async (...args: unknown[]) => {
      const text = args[0] as string;
      void text;
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = [
        { exact: 'foo', prefix: 'IRRELEVANT_PREFIX', suffix: 'IRRELEVANT_SUFFIX', comment: 'one of them' },
      ];
      const parsed = MotivationParsers.parseComments(fake, text);
      const cb = args[args.length - 1];
      if (typeof cb === 'function') await (cb as (x: unknown[]) => Promise<void>)(parsed as never);
      return parsed;
    }) as never);

    const result = await collected((onChunkComplete) => processCommentJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      textBuild(content),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    expect(posSel.start).toBe(2); // first occurrence
    expect(content.substring(posSel.start, posSel.end)).toBe('foo');
  });

  it('comment: matching prefix disambiguates to the right occurrence', async () => {
    const content = 'X foo Y foo Z foo W';
    vi.mocked(AnnotationDetection.detectComments).mockImplementation((async (...args: unknown[]) => {
      const text = args[0] as string;
      void text;
      const { MotivationParsers } = await import('../workers/detection/motivation-parsers');
      const fake = [
        { exact: 'foo', prefix: 'Y ', suffix: ' Z', comment: 'middle one' },
      ];
      const parsed = MotivationParsers.parseComments(fake, text);
      const cb = args[args.length - 1];
      if (typeof cb === 'function') await (cb as (x: unknown[]) => Promise<void>)(parsed as never);
      return parsed;
    }) as never);

    const result = await collected((onChunkComplete) => processCommentJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 3 },
      textBuild(content),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(1);
    const ann = result.annotations[0] as any;
    const posSel = ann.target.selector.find((s: any) => s.type === 'TextPositionSelector');
    expect(posSel.start).toBe(8); // middle occurrence, picked by prefix/suffix
    expect(content.substring(posSel.start, posSel.end)).toBe('foo');
  });
});

// ─── De-dupe: the collapse must not produce duplicate events ────────────
//
// Multiple LLM entries for a repeated phrase, reconciled independently,
// can all land on the same span via reconcileSelector's first-of-many
// fallback. dedupeAnnotations (applied identically in every processor)
// collapses identical events (same motivation + span + body) to one,
// while keeping same-span/different-body annotations distinct.

describe('annotation de-duplication', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reference: three entries collapsing onto the same span yield one annotation', async () => {
    // 'Paris' appears once; three LLM entries with non-distinctive context
    // all reconcile (first-of-many) to that single occurrence.
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' },
      { exact: 'Paris', entityType: 'Location' },
      { exact: 'Paris', entityType: 'Location' },
    ] as any));

    const committed: unknown[] = [];
    const outcome = await processReferenceJob(
      'A trip to Paris.',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('A trip to Paris.'),
      vi.fn(),
      LOGGER,
      async () => {},
      undefined,
      async (annotations) => {
        committed.push(...annotations);
      },
    );

    expect(committed).toHaveLength(1);
    expect(outcome.result.totalEmitted).toBe(1);
    expect(outcome.result.totalFound).toBe(3);
  });

  it('reference: same span but different entity types are kept (not duplicates)', async () => {
    // 'Mercury' tagged as both a Planet and an Element on the same span —
    // different bodies, so both survive.
    vi.mocked(extractEntities)
      .mockImplementationOnce(inOneChunk([{ exact: 'Mercury', entityType: 'Planet' }] as any))
      .mockImplementationOnce(inOneChunk([{ exact: 'Mercury', entityType: 'Element' }] as any));

    const committed: unknown[] = [];
    const outcome = await processReferenceJob(
      'The metal Mercury is dense.',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Planet'), entityType('Element')] },
      textBuild('The metal Mercury is dense.'),
      vi.fn(),
      LOGGER,
      async () => {},
      undefined,
      async (annotations) => {
        committed.push(...annotations);
      },
    );

    expect(committed).toHaveLength(2);
    expect(outcome.result.totalEmitted).toBe(2);
  });

  it('highlight: duplicate identical highlights collapse to one', async () => {
    const content = 'Only one phrase here to highlight.';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'one phrase', start: 5, end: 15 },
      { exact: 'one phrase', start: 5, end: 15 },
    ]));

    const result = await collected((onChunkComplete) => processHighlightJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, density: 5 },
      textBuild(content),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(1);
    expect(result.result.highlightsCreated).toBe(1);
    expect(result.result.highlightsFound).toBe(2);
  });

  it('tag: identical tags collapse and byCategory reflects the deduped count', async () => {
    const content = 'Issue: the duty of care.';
    vi.mocked(AnnotationDetection.detectTags).mockImplementation(inOneChunk([
      { exact: 'duty of care', start: 11, end: 23, category: 'Issue' },
      { exact: 'duty of care', start: 11, end: 23, category: 'Issue' },
    ]));

    const result = await collected((onChunkComplete) => processTagJob(
      content,
      makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'] },
      textBuild(content),
      vi.fn(), onChunkComplete));

    expect(result.annotations).toHaveLength(1);
    expect(result.result.tagsCreated).toBe(1);
    expect(result.result.byCategory).toEqual({ Issue: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// ASSIST-PROGRESS-CONSOLIDATION P2 (A6, producer half): a progress event
// carries a CODE plus typed params, never a prose sentence. The gateway
// reports what happened; each client renders it in the user's language.
//
// Pinned at the PROCESSOR call, deliberately: P1 already severed prose at
// the wire (`worker-process.ts` drops the argument), so a wire-level
// assertion would pass today without a single producer changing. The
// processors are where the English literals still live.
// ─────────────────────────────────────────────────────────────────────

/** Every message a processor emitted, in order. */
function messagesFrom(progress: ReturnType<typeof vi.fn>): unknown[] {
  return progress.mock.calls.map(call => call[1]);
}

/** The `extra` payload of every event, in order (undefined where none). */
function extrasFrom(progress: ReturnType<typeof vi.fn>): Array<Record<string, unknown> | undefined> {
  return progress.mock.calls.map(call => call[2]);
}

describe('progress messages are codes, not prose (A6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('highlight: loading → analyzing → creating-annotations → complete-created', async () => {
    const content = 'A critical finding and a second one.';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'critical', start: content.indexOf('critical'), end: content.indexOf('critical') + 8 },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processHighlightJob(
      content, makeInferenceClient(), { resourceId: RID, density: 5 },
      textBuild(content), progress, onChunkComplete));

    const messages = messagesFrom(progress);
    expect(messages[0]).toEqual({ code: 'loading' });
    expect(messages).toContainEqual({ code: 'analyzing' });
    expect(messages).toContainEqual({ code: 'creating-annotations', count: 1 });
    expect(messages[messages.length - 1]).toEqual({
      code: 'complete-created', count: 1, kind: 'highlight',
    });
  });

  it('reference: detecting-entities carries the entity type as a param, not in a sentence', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' } as never,
    ]));

    const progress = vi.fn();
    await processReferenceJob(
      'Paris', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris'), progress, LOGGER, async () => {},
    );

    const messages = messagesFrom(progress);
    expect(messages).toContainEqual({ code: 'detecting-entities', entityType: 'Location' });
    expect(messages[messages.length - 1]).toEqual({
      code: 'complete-created', count: 1, kind: 'reference',
    });
  });

  it('tag: its own analyzing and creating codes, distinct from the annotation ones', async () => {
    const content = 'Issue: the duty of care.';
    vi.mocked(AnnotationDetection.detectTags).mockImplementation(inOneChunk([
      { exact: 'duty of care', start: 11, end: 23, category: 'Issue' },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processTagJob(
      content, makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['Issue'] },
      textBuild(content), progress, onChunkComplete));

    const messages = messagesFrom(progress);
    expect(messages).toContainEqual({ code: 'analyzing-tags' });
    expect(messages).toContainEqual({ code: 'creating-tag-annotations', count: 1 });
    expect(messages[messages.length - 1]).toEqual({
      code: 'complete-created', count: 1, kind: 'tag',
    });
  });

  it('NO processor emits a prose sentence — the census is the enum, and tsc is its enforcement', async () => {
    // The sweeping guard: whatever a processor reports, it is an object with
    // a `code`. A string here is the defect this phase exists to remove.
    const content = 'A critical finding.';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10 },
    ]));
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10, comment: 'note' },
    ]));
    vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10, assessment: 'weak' },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processHighlightJob(content, makeInferenceClient(), { resourceId: RID }, textBuild(content), progress, onChunkComplete));
    await collected((onChunkComplete) => processCommentJob(content, makeInferenceClient(), { resourceId: RID }, textBuild(content), progress, onChunkComplete));
    await collected((onChunkComplete) => processAssessmentJob(content, makeInferenceClient(), { resourceId: RID }, textBuild(content), progress, onChunkComplete));

    const messages = messagesFrom(progress);
    expect(messages.length).toBeGreaterThan(6);
    for (const message of messages) {
      expect(typeof message).toBe('object');
      expect(message).toHaveProperty('code');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// The user's own request, echoed for the whole run.
//
// The client's `progress$` REPLACES its value on each event, so a field
// describing the RUN (not the moment) must ride EVERY event — sent once, it
// flashes at 10% and vanishes. The comment flow showed "Marking…" and nothing
// else for the rest of the run because of exactly that.
// ─────────────────────────────────────────────────────────────────────
describe('request parameters ride every event', () => {
  beforeEach(() => vi.clearAllMocks());

  it('comment: every event carries the instructions, as a CODE plus the raw value', async () => {
    const content = 'A critical finding.';
    vi.mocked(AnnotationDetection.detectComments).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10, comment: 'note' },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processCommentJob(
      content, makeInferenceClient(),
      { resourceId: RID, instructions: 'Focus on methodology', tone: 'scholarly', density: 5 },
      textBuild(content), progress, onChunkComplete));

    const extras = extrasFrom(progress);
    expect(extras.length).toBeGreaterThan(1);
    for (const extra of extras) {
      expect(extra?.requestParams).toEqual([
        { label: 'instructions', value: 'Focus on methodology' },
        { label: 'tone', value: 'scholarly' },
        { label: 'density', value: '5' },
      ]);
    }
  });

  it('the label is a wire code and the value is the user\'s words, verbatim', async () => {
    // The label is localized by the client; the value never is — translating
    // someone's own instructions back at them would be absurd.
    const content = 'A critical finding.';
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10 },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processHighlightJob(
      content, makeInferenceClient(),
      { resourceId: RID, instructions: '  Mark the Führer-era citations  ' },
      textBuild(content), progress, onChunkComplete));

    const params = extrasFrom(progress)[0]?.requestParams as Array<{ label: string; value: string }>;
    expect(params[0]?.label).toBe('instructions');
    expect(params[0]?.value).toBe('Mark the Führer-era citations');
  });

  it('omits the block entirely when the user supplied nothing to echo', async () => {
    // An empty array would render an empty box. Absent means absent.
    const content = 'A critical finding.';
    vi.mocked(AnnotationDetection.detectAssessments).mockImplementation(inOneChunk([
      { exact: 'critical', start: 2, end: 10, assessment: 'weak' },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processAssessmentJob(
      content, makeInferenceClient(), { resourceId: RID }, textBuild(content), progress, onChunkComplete));

    for (const extra of extrasFrom(progress)) {
      expect(extra?.requestParams).toBeUndefined();
    }
  });

  it('reference: the entity types survive to the terminal event too', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' } as never,
    ]));

    const progress = vi.fn();
    await processReferenceJob(
      'Paris', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris'), progress, LOGGER, async () => {},
    );

    const extras = extrasFrom(progress);
    expect(extras[extras.length - 1]?.requestParams).toEqual([
      { label: 'entity-types', value: 'Location' },
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// CLEAN-PROGRESS Lane B — one vocabulary for "what is in flight".
//
// Reference and tag iterate the same way over a user-chosen list, so they
// report the same shape: `current: {kind, value}` + `processed` + `total`.
// `kind` is a wire CODE the client localizes; `value` is KB data (an entity
// type, a category) shown verbatim.
// ─────────────────────────────────────────────────────────────────────
describe('what is in flight is reported one way (CLEAN-PROGRESS A4/A5)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reference: the entity type rides `current`, kind-tagged, with its position', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' } as never,
    ]));

    const progress = vi.fn();
    await processReferenceJob(
      'Paris', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location'), entityType('Person')] },
      textBuild('Paris'), progress, LOGGER, async () => {},
    );

    const detecting = extrasFrom(progress).filter((e) => e?.current);
    expect(detecting.length).toBeGreaterThan(0);
    expect(detecting[0]).toMatchObject({
      current: { kind: 'entity-type', value: 'Location' },
      processed: 0,
      total: 2,
    });
  });

  it('tag: the category rides the SAME field, kind-tagged — tags get a subject at last', async () => {
    // processTagJob already loops per category; it just never said so. This is
    // the parity gap Copilot flagged on #1179, now a one-field change.
    const content = 'Issue: the duty of care.';
    vi.mocked(AnnotationDetection.detectTags).mockImplementation(inOneChunk([
      { exact: 'duty of care', start: 11, end: 23, category: 'Issue' },
    ]));

    const progress = vi.fn();
    await collected((onChunkComplete) => processTagJob(
      content, makeInferenceClient(),
      { resourceId: RID, schema: SCHEMA_1, categories: ['Issue', 'Holding'] },
      textBuild(content), progress, onChunkComplete));

    const withCurrent = extrasFrom(progress).filter((e) => e?.current);
    expect(withCurrent.length).toBeGreaterThan(0);
    expect(withCurrent[0]).toMatchObject({
      current: { kind: 'category', value: 'Issue' },
      processed: 0,
      total: 2,
    });
  });

  it('no producer emits the old flow-specific field names', async () => {
    // The whole point: one vocabulary. A reappearance of any of these is the
    // regression this lane exists to prevent.
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' } as never,
    ]));
    const progress = vi.fn();
    await processReferenceJob(
      'Paris', makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild('Paris'), progress, LOGGER, async () => {},
    );

    const dead = ['processedEntityTypes', 'totalEntityTypes', 'currentEntityType',
                  'processedCategories', 'totalCategories', 'currentCategory'];
    for (const extra of extrasFrom(progress)) {
      for (const field of dead) expect(extra ?? {}).not.toHaveProperty(field);
    }
  });
});

// ── Checkpointed resume (A3) ──────────────────────────────────────────
// A unit either completed — every chunk committed, its checkpoint fired —
// or it contributes nothing.

describe('processReferenceJob — unit commits (A3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('checkpoints each completed unit — including empty ones — and stops at the failing unit', async () => {
    vi.mocked(extractEntities).mockImplementation(async (_c, types, _cl, _i, _l, _sl, _act, _verdicts, _counts, onChunkResults) => {
      const t = String(types[0]);
      if (t === 'Person') {
        const items = [{ exact: 'Greeley', start: 0, end: 7, entityType: 'Person' }];
        await onChunkResults?.(items as never);
        return items as never;
      }
      if (t === 'Date') { await onChunkResults?.([] as never); return [] as never; } // legitimately-empty unit (RED v)
      throw new Error('Location stalled');
    });

    const units: string[] = [];
    const counts: Record<string, number> = {};
    let current = '';
    const onUnitComplete = vi.fn(async (unit: string) => { units.push(unit); });

    await expect(
      processReferenceJob(
        'Greeley went west',
        makeInferenceClient(),
        { resourceId: RID, entityTypes: [entityType('Person'), entityType('Date'), entityType('Location')] },
        textBuild('Greeley went west'),
        vi.fn((_pct, _msg, extra?: { current?: { value?: string } }) => {
          if (extra?.current?.value) current = extra.current.value;
        }),
        LOGGER,
        onUnitComplete,
        undefined,
        async (annotations) => { counts[current] = (counts[current] ?? 0) + annotations.length; },
      ),
    ).rejects.toThrow('Location stalled');

    // Units 1..k checkpointed in order, the failing unit contributed nothing.
    expect(units).toEqual(['Person', 'Date']);
    expect(counts['Person']).toBe(1);
    expect(counts['Location']).toBeUndefined();
  });

  it('a rejected chunk commit fails the run — the unit is not silently kept', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Greeley', start: 0, end: 7, entityType: 'Person' },
    ] as never));
    const onUnitComplete = vi.fn(async () => {});

    await expect(
      processReferenceJob(
        'Greeley went west',
        makeInferenceClient(),
        { resourceId: RID, entityTypes: [entityType('Person')] },
        textBuild('Greeley went west'),
        vi.fn(),
        LOGGER,
        onUnitComplete,
        undefined,
        vi.fn(async () => {
          throw new Error('emit refused');
        }),
      ),
    ).rejects.toThrow('emit refused');
    // And it never checkpointed: control state cannot outrun the effect.
    expect(onUnitComplete).not.toHaveBeenCalled();
  });

  it('returns only the result — the chunk callback owns emission, nothing is returned twice', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Greeley', start: 0, end: 7, entityType: 'Person' },
    ] as never));

    const seen: unknown[][] = [];
    const outcome = await processReferenceJob(
      'Greeley went west',
      makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Person')] },
      textBuild('Greeley went west'),
      vi.fn(),
      LOGGER,
      async () => {},
      undefined,
      vi.fn(async (annotations: unknown[]) => {
        seen.push(annotations);
      }),
    );

    expect(Object.keys(outcome)).toEqual(['result']);
    expect(outcome.result).toEqual({ kind: 'reference-annotation', totalFound: 1, totalEmitted: 1, errors: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
  });
});

// The decisive property is the overlap test: a duplicate spanning two chunks
// must be emitted once, which only a seen-set carried ACROSS chunks can do.
describe('chunk-grain emission — processors', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const content = 'important text and the critical part is here.';
  const at = (w: string) => ({ exact: w, start: content.indexOf(w), end: content.indexOf(w) + w.length });

  it('processHighlightJob commits each chunk as it lands, not one batch at the end', async () => {
    // Two chunks: the mocked loop hands each to the processor in turn.
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(
      async (_c, _cl, _i, _d, _sl, _onActivity, onChunkResults) => {
        await onChunkResults!([at('important')] as never);
        await onChunkResults!([at('critical')] as never);
        return [at('important'), at('critical')] as never;
      },
    );
    const committed: string[][] = [];

    await processHighlightJob(
      content, makeInferenceClient(), { resourceId: RID, density: 5 },
      textBuild(content), vi.fn(),
      async (anns) => { committed.push(anns.map((a: any) => a.target.selector[1].exact)); },
    );

    expect(committed).toEqual([['important'], ['critical']]);
  });

  it('an overlap duplicate spanning two chunks is committed ONCE', async () => {
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(
      async (_c, _cl, _i, _d, _sl, _onActivity, onChunkResults) => {
        await onChunkResults!([at('important')] as never);
        await onChunkResults!([at('important'), at('critical')] as never);
        return [] as never;
      },
    );
    const committed: string[] = [];

    const { result } = await processHighlightJob(
      content, makeInferenceClient(), { resourceId: RID, density: 5 },
      textBuild(content), vi.fn(),
      async (anns) => { committed.push(...anns.map((a: any) => a.target.selector[1].exact)); },
    );

    expect(committed).toEqual(['important', 'critical']);
    // And the reported count matches what was actually committed.
    expect((result as any).highlightsCreated).toBe(2);
  });

  it('processReferenceJob emits per chunk; onUnitComplete is the checkpoint, carrying no annotations', async () => {
    vi.mocked(extractEntities).mockImplementation(
      async (_c, _t, _cl, _i, _l, _sl, _onActivity, _verdicts, _counts, onChunkResults) => {
        await onChunkResults!([{ exact: 'important', entityType: 'Person' }] as never);
        await onChunkResults!([{ exact: 'critical', entityType: 'Person' }] as never);
        return [] as never;
      },
    );
    const committed: string[][] = [];
    const checkpoints: unknown[][] = [];

    await processReferenceJob(
      content, makeInferenceClient(), { resourceId: RID, entityTypes: ['Person'] } as never,
      textBuild(content), vi.fn(), LOGGER,
      (...args: unknown[]) => { checkpoints.push(args); return Promise.resolve(); },
      undefined,
      async (anns: any[]) => { committed.push(anns.map((a) => a.target.selector[1].exact)); },
    );

    expect(committed).toEqual([['important'], ['critical']]);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toEqual(['Person']);
  });
});

// A floor-accepted under-report is RESULT, not archaeology: the unit records
// what remains unknown at its end, and a clean unit records nothing — absence
// is a claim, never a default.
describe('under-report verdicts on the terminal surface', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const content = 'Paris and Berlin and Rome';

  it('a floor-accepted piece surfaces on the unit entry and the result aggregate', async () => {
    vi.mocked(extractEntities).mockImplementation(async (...args: unknown[]) => {
      const onUnderReport = args[7] as (v: unknown) => void;
      const onChunkResults = args[9] as (i: unknown[]) => Promise<void>;
      onUnderReport({ found: 1, counted: 4, pieceChars: 530 });
      await onChunkResults([{ exact: 'Paris', entityType: 'Location' }]);
      return [] as never;
    });
    const progress = vi.fn();

    const outcome = await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild(content), progress, LOGGER, async () => {}, undefined, async () => {},
    );

    const last = progress.mock.calls.at(-1)![2] as { completedItems?: Array<Record<string, unknown>> };
    expect(last.completedItems).toEqual([
      {
        value: 'Location', foundCount: 1, persistedCount: 1,
        underReported: { pieces: 1, found: 1, counted: 4 },
      },
    ]);
    expect(outcome.result.underReportedPieces).toBe(1);
  });

  it('two flagged pieces in one unit fold into one summary', async () => {
    vi.mocked(extractEntities).mockImplementation(async (...args: unknown[]) => {
      const onUnderReport = args[7] as (v: unknown) => void;
      onUnderReport({ found: 1, counted: 4, pieceChars: 530 });
      onUnderReport({ found: 2, counted: 9, pieceChars: 610 });
      await (args[9] as (i: unknown[]) => Promise<void>)([]);
      return [] as never;
    });
    const progress = vi.fn();

    const outcome = await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild(content), progress, LOGGER, async () => {}, undefined, async () => {},
    );

    const last = progress.mock.calls.at(-1)![2] as { completedItems?: Array<Record<string, unknown>> };
    expect(last.completedItems![0]!.underReported).toEqual({ pieces: 2, found: 3, counted: 13 });
    expect(outcome.result.underReportedPieces).toBe(2);
  });

  it('a clean unit carries NO verdict — genuinely absent, not defaulted', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' },
    ] as never));
    const progress = vi.fn();

    const outcome = await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild(content), progress, LOGGER, async () => {}, undefined, async () => {},
    );

    const last = progress.mock.calls.at(-1)![2] as { completedItems?: Array<Record<string, unknown>> };
    expect('underReported' in last.completedItems![0]!).toBe(false);
    expect('underReportedPieces' in outcome.result).toBe(false);
  });

  it('the four motivation paths carry no verdict vocabulary', async () => {
    // No verifier runs there; the vocabulary must not leak into their results.
    vi.mocked(AnnotationDetection.detectHighlights).mockImplementation(inOneChunk([]));
    const { result } = await collected((cb) => processHighlightJob(
      content, makeInferenceClient(), { resourceId: RID, density: 5 },
      textBuild(content), vi.fn(), cb));
    expect('underReportedPieces' in (result as unknown as Record<string, unknown>)).toBe(false);
  });
});

// The denominator (RD5): the count-verifier's expectation, cumulative on the
// progress surface, so the UI can draw "69 of ~290". Absent without a
// verifying provider — no claim, not zero.
describe('entitiesExpected on the progress surface', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const content = 'Paris and Berlin and Rome';

  it('accumulates count-verifier expectations across chunks and units', async () => {
    vi.mocked(extractEntities).mockImplementation(async (...args: unknown[]) => {
      const onCounted = args[8] as (c: number) => void;
      const onChunkResults = args[9] as (i: unknown[]) => Promise<void>;
      onCounted(4);
      await onChunkResults([{ exact: 'Paris', entityType: 'Location' }]);
      onCounted(3);
      await onChunkResults([]);
      return [] as never;
    });
    const progress = vi.fn();

    await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild(content), progress, LOGGER, async () => {}, undefined, async () => {},
    );

    const frames = progress.mock.calls.map((c) => c[2] as Record<string, unknown>);
    const expectedSeen = frames.map((f) => f?.entitiesExpected).filter((v) => v !== undefined);
    expect(expectedSeen.at(-1)).toBe(7);
    // Cumulative, never shrinking.
    for (let i = 1; i < expectedSeen.length; i++) {
      expect(expectedSeen[i] as number).toBeGreaterThanOrEqual(expectedSeen[i - 1] as number);
    }
  });

  it('absent when the provider does not verify — no claim, not zero', async () => {
    vi.mocked(extractEntities).mockImplementation(inOneChunk([
      { exact: 'Paris', entityType: 'Location' },
    ] as never));
    const progress = vi.fn();

    await processReferenceJob(
      content, makeInferenceClient(),
      { resourceId: RID, entityTypes: [entityType('Location')] },
      textBuild(content), progress, LOGGER, async () => {}, undefined, async () => {},
    );

    for (const call of progress.mock.calls) {
      const frame = call[2] as Record<string, unknown> | undefined;
      expect(frame && 'entitiesExpected' in frame ? frame.entitiesExpected : undefined).toBeUndefined();
    }
  });
});
