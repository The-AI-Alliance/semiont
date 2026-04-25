/**
 * Mark Command Tests
 *
 * Tests schema validation (manual/delegate modes) and command result shape.
 * Mocks createAuthenticatedClient to avoid network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarkOptionsSchema, runMark, type MarkOptions } from '../mark.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockMarkAnnotation, mockSse, mockLoadCachedClient } = vi.hoisted(() => {
  const mockMarkAnnotation = vi.fn();
  const mockSse = {
    markHighlights: vi.fn(),
    markAssessments: vi.fn(),
    markComments: vi.fn(),
    markReferences: vi.fn(),
    markTags: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockMarkAnnotation, mockSse, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManualOptions(overrides: Partial<MarkOptions> = {}): MarkOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    resourceIdArr: ['urn:semiont:resource:doc-1'],
    motivation: 'highlighting',
    delegate: false,
    quote: 'some text',
    prefix: undefined,
    suffix: undefined,
    start: undefined,
    end: undefined,
    svg: undefined,
    fragment: undefined,
    fragmentConformsTo: undefined,
    fetchContent: false,
    bodyText: undefined,
    bodyFormat: undefined,
    bodyLanguage: undefined,
    bodyPurpose: undefined,
    link: undefined,
    instructions: undefined,
    density: undefined,
    tone: undefined,
    entityType: [],
    includeDescriptive: false,
    schemaId: undefined,
    category: [],
    bus: undefined,
    ...overrides,
  };
}

function makeDelegateOptions(overrides: Partial<MarkOptions> = {}): MarkOptions {
  return makeManualOptions({
    delegate: true,
    quote: undefined,
    ...overrides,
  });
}

// ── Schema validation ─────────────────────────────────────────────────────────

describe('MarkOptionsSchema', () => {
  it('accepts valid manual highlighting', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'highlighting',
      delegate: false,
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing motivation', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects invalid motivation', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'bookmarking',
    });
    expect(r.success).toBe(false);
  });

  it('rejects --quote with --delegate', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'highlighting',
      delegate: true,
      quote: 'some text',
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate --motivation linking without --entity-type', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'linking',
      delegate: true,
    });
    expect(r.success).toBe(false);
  });

  it('accepts delegate --motivation linking with --entity-type', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'linking',
      delegate: true,
      entityType: ['Person'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects delegate --motivation tagging without --schema-id', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'tagging',
      delegate: true,
      category: ['Biology'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate --motivation tagging without --category', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'tagging',
      delegate: true,
      schemaId: 'science',
    });
    expect(r.success).toBe(false);
  });

  it('accepts delegate --motivation tagging with schema-id and category', () => {
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'tagging',
      delegate: true,
      schemaId: 'science',
      category: ['Biology'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects multiple selector flags', () => {
    // quote + svg is not a schema error — it's caught in runMark; schema passes
    // but start + svg is also runtime-only. Schema only validates the zod rules.
    // Selector mutual-exclusivity is in runMark, not schema — this is expected.
    const r = MarkOptionsSchema.safeParse({
      resourceIdArr: ['doc-1'],
      motivation: 'highlighting',
      quote: 'text',
      svg: '<circle/>',
    });
    expect(r.success).toBe(true); // schema allows it; runtime rejects it
  });
});

// ── runMark tests ─────────────────────────────────────────────────────────────

describe('runMark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMarkAnnotation.mockResolvedValue({ annotationId: 'urn:semiont:annotation:new-1' });
    mockLoadCachedClient.mockReturnValue({
      semiont: { mark: { annotation: mockMarkAnnotation }, sse: mockSse },
      token: 'mock-token',
    });
    // SSE mocks do NOT resolve — delegate tests fire-and-forget then manually emit events
  });

  it('returns CommandResults with command=mark for manual mode', async () => {
const result = await runMark(makeManualOptions());
    expect(result.command).toBe('mark');
    expect(result.summary.succeeded).toBe(1);
    expect(result.results[0]?.entity).toBe('urn:semiont:resource:doc-1');
    expect(result.results[0]?.metadata?.annotationId).toBe('urn:semiont:annotation:new-1');
  });

  it('calls markAnnotation with motivation in manual mode', async () => {
await runMark(makeManualOptions({ motivation: 'commenting', bodyText: 'nice' }));
    expect(mockMarkAnnotation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ motivation: 'commenting' }),
    );
  });

  it('builds TextQuoteSelector from --quote', async () => {
await runMark(makeManualOptions({ quote: 'important phrase' }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'TextQuoteSelector', exact: 'important phrase' });
  });

  it('builds TextPositionSelector from --start/--end', async () => {
await runMark(makeManualOptions({ quote: undefined, start: 10, end: 25 }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'TextPositionSelector', start: 10, end: 25 });
  });

  it('builds SvgSelector from --svg', async () => {
await runMark(makeManualOptions({ quote: undefined, svg: '<circle r="5"/>' }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'SvgSelector', value: '<circle r="5"/>' });
  });

  it('builds FragmentSelector from --fragment', async () => {
await runMark(makeManualOptions({ quote: undefined, fragment: 't=10,20' }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'FragmentSelector', value: 't=10,20' });
  });

  it('throws when multiple selector types are combined', async () => {
await expect(
      runMark(makeManualOptions({ quote: 'text', svg: '<circle/>' }))
    ).rejects.toThrow();
  });

  it('includes TextualBody when --body-text provided', async () => {
await runMark(makeManualOptions({ bodyText: 'my comment' }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    expect(JSON.stringify(req.body)).toContain('my comment');
  });

  it('includes SpecificResource body when --link provided', async () => {
await runMark(makeManualOptions({ link: ['urn:semiont:resource:other'] }));
    const [, req] = mockMarkAnnotation.mock.calls[0];
    const body = Array.isArray(req.body) ? req.body : [req.body];
    expect(body.some((b: any) => b.type === 'SpecificResource')).toBe(true);
  });

  describe('delegate mode', () => {
    it('calls markHighlights for highlighting motivation', async () => {
      // Intercept markHighlights and emit the finish event on the eventBus
      mockSse.markHighlights.mockImplementationOnce((_id: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => {
          eventBus.get('job:complete').next({
            jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'highlight-annotation',
            result: { highlightsFound: 3, highlightsCreated: 3 },
          });
        });
      });

    const result = await runMark(makeDelegateOptions({ motivation: 'highlighting' }));
      expect(mockSse.markHighlights).toHaveBeenCalledOnce();
      expect(result.command).toBe('mark');
      expect(result.results[0]?.metadata?.motivation).toBe('highlighting');
    });

    it('calls markReferences for linking motivation', async () => {
      mockSse.markReferences.mockImplementationOnce((_id: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => {
          eventBus.get('job:complete').next({
            jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'reference-annotation',
            result: { totalFound: 5, totalEmitted: 5, errors: 0 },
          });
        });
      });

    const result = await runMark(makeDelegateOptions({ motivation: 'linking', entityType: ['Person'] }));
      expect(mockSse.markReferences).toHaveBeenCalledOnce();
      expect(result.results[0]?.metadata?.motivation).toBe('linking');
    });

    it('rejects when job:fail fires', async () => {
      mockSse.markHighlights.mockImplementationOnce((_id: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => {
          eventBus.get('job:fail').next({
            jobId: 'j1', resourceId: 'res-1', _userId: 'u', jobType: 'highlight-annotation',
            error: 'AI service down',
          });
        });
      });

    await expect(runMark(makeDelegateOptions({ motivation: 'highlighting' }))).rejects.toThrow('AI service down');
    });
  });
});
