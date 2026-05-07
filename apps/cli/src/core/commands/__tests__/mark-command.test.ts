/**
 * Mark Command Tests
 *
 * Tests schema validation (manual/delegate modes) and command result shape.
 * Mocks loadCachedClient to avoid network I/O. The mocked SemiontClient
 * exposes the namespace API (semiont.mark.annotation, semiont.mark.assist).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { MarkOptionsSchema, runMark, type MarkOptions } from '../mark.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockMark, mockLoadCachedClient } = vi.hoisted(() => {
  const mockMark = {
    annotation: vi.fn(),
    assist: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockMark, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

const semiontStub = { mark: mockMark };

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
    mockMark.annotation.mockResolvedValue({ annotationId: 'urn:semiont:annotation:new-1' });
    mockLoadCachedClient.mockReturnValue({ semiont: semiontStub, token: 'mock-token' });
  });

  it('returns CommandResults with command=mark for manual mode', async () => {
    const result = await runMark(makeManualOptions());
    expect(result.command).toBe('mark');
    expect(result.summary.succeeded).toBe(1);
    expect(result.results[0]?.entity).toBe('urn:semiont:resource:doc-1');
    expect(result.results[0]?.metadata?.annotationId).toBe('urn:semiont:annotation:new-1');
  });

  it('calls mark.annotation with motivation in manual mode', async () => {
    await runMark(makeManualOptions({ motivation: 'commenting', bodyText: 'nice' }));
    expect(mockMark.annotation).toHaveBeenCalledWith(
      expect.objectContaining({ motivation: 'commenting' }),
    );
  });

  it('builds TextQuoteSelector from --quote', async () => {
    await runMark(makeManualOptions({ quote: 'important phrase' }));
    const [req] = mockMark.annotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'TextQuoteSelector', exact: 'important phrase' });
  });

  it('builds TextPositionSelector from --start/--end', async () => {
    await runMark(makeManualOptions({ quote: undefined, start: 10, end: 25 }));
    const [req] = mockMark.annotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'TextPositionSelector', start: 10, end: 25 });
  });

  it('builds SvgSelector from --svg', async () => {
    await runMark(makeManualOptions({ quote: undefined, svg: '<circle r="5"/>' }));
    const [req] = mockMark.annotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'SvgSelector', value: '<circle r="5"/>' });
  });

  it('builds FragmentSelector from --fragment', async () => {
    await runMark(makeManualOptions({ quote: undefined, fragment: 't=10,20' }));
    const [req] = mockMark.annotation.mock.calls[0];
    expect(req.target.selector).toMatchObject({ type: 'FragmentSelector', value: 't=10,20' });
  });

  it('throws when multiple selector types are combined', async () => {
    await expect(
      runMark(makeManualOptions({ quote: 'text', svg: '<circle/>' }))
    ).rejects.toThrow();
  });

  it('includes TextualBody when --body-text provided', async () => {
    await runMark(makeManualOptions({ bodyText: 'my comment' }));
    const [req] = mockMark.annotation.mock.calls[0];
    expect(JSON.stringify(req.body)).toContain('my comment');
  });

  it('includes SpecificResource body when --link provided', async () => {
    await runMark(makeManualOptions({ link: ['urn:semiont:resource:other'] }));
    const [req] = mockMark.annotation.mock.calls[0];
    const body = Array.isArray(req.body) ? req.body : [req.body];
    expect(body.some((b: any) => b.type === 'SpecificResource')).toBe(true);
  });

  describe('delegate mode', () => {
    it('calls mark.assist with highlighting motivation', async () => {
      mockMark.assist.mockReturnValueOnce(of({
        kind: 'complete',
        data: {
          jobId: 'j1',
          resourceId: 'res-1',
          jobType: 'highlight-annotation',
          result: { highlightsFound: 3, highlightsCreated: 3 },
        },
      }));

      const result = await runMark(makeDelegateOptions({ motivation: 'highlighting' }));
      expect(mockMark.assist).toHaveBeenCalledOnce();
      expect(mockMark.assist.mock.calls[0][1]).toBe('highlighting');
      expect(result.command).toBe('mark');
      expect(result.results[0]?.metadata?.motivation).toBe('highlighting');
    });

    it('calls mark.assist with linking motivation', async () => {
      mockMark.assist.mockReturnValueOnce(of({
        kind: 'complete',
        data: {
          jobId: 'j1',
          resourceId: 'res-1',
          jobType: 'reference-annotation',
          result: { totalFound: 5, totalEmitted: 5, errors: 0 },
        },
      }));

      const result = await runMark(makeDelegateOptions({ motivation: 'linking', entityType: ['Person'] }));
      expect(mockMark.assist).toHaveBeenCalledOnce();
      expect(mockMark.assist.mock.calls[0][1]).toBe('linking');
      expect(result.results[0]?.metadata?.motivation).toBe('linking');
    });

    it('rejects when mark.assist errors', async () => {
      mockMark.assist.mockReturnValueOnce(throwError(() => new Error('AI service down')));
      await expect(runMark(makeDelegateOptions({ motivation: 'highlighting' }))).rejects.toThrow('AI service down');
    });
  });
});
