/**
 * Gather, Bind, and Match Command Tests
 *
 * Tests schema validation and command result shapes.
 * Mocks createAuthenticatedClient to avoid network I/O.
 * SSE-based commands use queueMicrotask to simulate EventBus responses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatherOptionsSchema, runGather, type GatherOptions } from '../gather.js';
import { BindOptionsSchema, runBind, type BindOptions } from '../bind.js';
import { MatchOptionsSchema, runMatch, type MatchOptions } from '../match.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockSse, mockLoadCachedClient } = vi.hoisted(() => {
  const mockSse = {
    gatherResource: vi.fn(),
    gatherAnnotation: vi.fn(),
    bindAnnotation: vi.fn(),
    bindSearch: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockSse, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeGatherOptions(overrides: Partial<GatherOptions> = {}): GatherOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: ['resource', 'urn:semiont:resource:doc-1'],
    depth: 2,
    maxResources: 10,
    noContent: false,
    summary: false,
    contextWindow: 1000,
    bus: undefined,
    ...overrides,
  };
}

function makeBindOptions(overrides: Partial<BindOptions> = {}): BindOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: ['urn:semiont:resource:doc-1', 'urn:semiont:annotation:ann-1', 'urn:semiont:resource:target'],
    bus: undefined,
    ...overrides,
  };
}

function makeMatchOptions(overrides: Partial<MatchOptions> = {}): MatchOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: ['urn:semiont:resource:doc-1', 'urn:semiont:annotation:ann-1'],
    contextWindow: 1000,
    userHint: undefined,
    limit: 10,
    noSemantic: false,
    bus: undefined,
    ...overrides,
  };
}

// ── GatherOptionsSchema ───────────────────────────────────────────────────────

describe('GatherOptionsSchema', () => {
  it('accepts "resource <id>"', () => {
    const r = GatherOptionsSchema.safeParse({
      args: ['resource', 'doc-1'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts "annotation <resourceId> <annotationId>"', () => {
    const r = GatherOptionsSchema.safeParse({
      args: ['annotation', 'doc-1', 'ann-1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects args with fewer than 2 elements', () => {
    const r = GatherOptionsSchema.safeParse({
      args: ['resource'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects depth < 1', () => {
    const r = GatherOptionsSchema.safeParse({
      args: ['resource', 'doc-1'],
      depth: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects depth > 3', () => {
    const r = GatherOptionsSchema.safeParse({
      args: ['resource', 'doc-1'],
      depth: 4,
    });
    expect(r.success).toBe(false);
  });
});

// ── runGather tests ───────────────────────────────────────────────────────────

describe('runGather', () => {
  const mockContext = { mainResource: { name: 'Doc 1' }, relatedResources: [], annotations: [], graph: { nodes: [], edges: [] } };
  const mockAnnotationContext = { annotation: {}, sourceResource: {}, sourceContext: { before: '', selected: 'text', after: '' } };

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ client: { sse: mockSse }, token: 'mock-token' });
    mockSse.gatherResource.mockImplementationOnce((_id: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => eventBus.get('gather:finished').next({ context: mockContext }));
    });
    mockSse.gatherAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => eventBus.get('gather:annotation-finished').next({ annotationId: _aid, response: { context: mockAnnotationContext } }));
    });
  });

  it('returns CommandResults with command=gather for resource subcommand', async () => {
const result = await runGather(makeGatherOptions());
    expect(result.command).toBe('gather');
    expect(result.summary.succeeded).toBe(1);
    expect(mockSse.gatherResource).toHaveBeenCalledOnce();
  });

  it('returns CommandResults with command=gather for annotation subcommand', async () => {
const result = await runGather(makeGatherOptions({ args: ['annotation', 'urn:semiont:resource:doc-1', 'urn:semiont:annotation:ann-1'] }));
    expect(result.command).toBe('gather');
    expect(mockSse.gatherAnnotation).toHaveBeenCalledOnce();
  });

  it('throws for unknown subcommand', async () => {
await expect(runGather(makeGatherOptions({ args: ['thing', 'doc-1'] }))).rejects.toThrow('Unknown subcommand');
  });

  it('rejects when gather:failed fires', async () => {
    mockSse.gatherResource.mockReset();
    mockSse.gatherResource.mockImplementationOnce((_id: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => eventBus.get('gather:failed').next({ message: 'Gather timed out' }));
    });
await expect(runGather(makeGatherOptions())).rejects.toThrow('Gather timed out');
  });
});

// ── BindOptionsSchema ─────────────────────────────────────────────────────────

describe('BindOptionsSchema', () => {
  it('accepts exactly 3 args', () => {
    const r = BindOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1', 'target-1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects fewer than 3 args', () => {
    const r = BindOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects more than 3 args', () => {
    const r = BindOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1', 'target-1', 'extra'],
    });
    expect(r.success).toBe(false);
  });
});

// ── runBind tests ─────────────────────────────────────────────────────────────

describe('runBind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ client: { sse: mockSse }, token: 'mock-token' });
    mockSse.bindAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => eventBus.get('bind:finished').next({}));
    });
  });

  it('returns CommandResults with command=bind', async () => {
const result = await runBind(makeBindOptions());
    expect(result.command).toBe('bind');
    expect(result.summary.succeeded).toBe(1);
    expect(mockSse.bindAnnotation).toHaveBeenCalledOnce();
  });

  it('passes a SpecificResource operation to bindAnnotation', async () => {
await runBind(makeBindOptions());
    const [, , req] = mockSse.bindAnnotation.mock.calls[0];
    expect(req.operations[0]).toMatchObject({ op: 'add', item: { type: 'SpecificResource', purpose: 'linking' } });
  });

  it('records targetResourceId in result metadata', async () => {
const result = await runBind(makeBindOptions());
    expect(result.results[0]?.metadata?.targetResourceId).toBe('urn:semiont:resource:target');
  });

  it('rejects when bind:failed fires', async () => {
    mockSse.bindAnnotation.mockReset();
    mockSse.bindAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => eventBus.get('bind:failed').next({ error: 'Target not found' }));
    });
await expect(runBind(makeBindOptions())).rejects.toThrow('Target not found');
  });
});

// ── MatchOptionsSchema ────────────────────────────────────────────────────────

describe('MatchOptionsSchema', () => {
  it('accepts exactly 2 args', () => {
    const r = MatchOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects fewer than 2 args', () => {
    const r = MatchOptionsSchema.safeParse({
      args: ['doc-1'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects more than 2 args', () => {
    const r = MatchOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1', 'extra'],
    });
    expect(r.success).toBe(false);
  });

  it('rejects contextWindow < 100', () => {
    const r = MatchOptionsSchema.safeParse({
      args: ['doc-1', 'ann-1'],
      contextWindow: 50,
    });
    expect(r.success).toBe(false);
  });
});

// ── runMatch tests ────────────────────────────────────────────────────────────

describe('runMatch', () => {
  const mockResults = [{ '@context': 'http://schema.org', '@id': 'http://example.com/r/1', name: 'Candidate', representations: [] }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ client: { sse: mockSse }, token: 'mock-token' });
    // gatherAnnotation resolves with context
    mockSse.gatherAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => {
        eventBus.get('gather:annotation-finished').next({
          annotationId: _aid,
          response: {
            context: {
              annotation: {},
              sourceResource: {},
              sourceContext: { before: '', selected: 'Paris', after: '' },
            },
          },
        });
      });
    });
    // bindSearch resolves with results
    mockSse.bindSearch.mockImplementationOnce((_rid: any, req: any, { eventBus }: any) => {
      queueMicrotask(() => {
        eventBus.get('match:search-results').next({
          referenceId: req.referenceId,
          results: mockResults,
        });
      });
    });
  });

  it('returns CommandResults with command=match', async () => {
const result = await runMatch(makeMatchOptions());
    expect(result.command).toBe('match');
    expect(result.summary.succeeded).toBe(1);
  });

  it('calls gatherAnnotation then bindSearch in sequence', async () => {
await runMatch(makeMatchOptions());
    expect(mockSse.gatherAnnotation).toHaveBeenCalledOnce();
    expect(mockSse.bindSearch).toHaveBeenCalledOnce();
  });

  it('records resultCount in result metadata', async () => {
const result = await runMatch(makeMatchOptions());
    expect(result.results[0]?.metadata?.resultCount).toBe(1);
  });

  it('applies userHint to the gathered context', async () => {
await runMatch(makeMatchOptions({ userHint: 'look for Paris papers' }));
    const [, req] = mockSse.bindSearch.mock.calls[0];
    expect((req.context as any).userHint).toBe('look for Paris papers');
  });

  it('rejects when gather:failed fires', async () => {
    mockSse.gatherAnnotation.mockReset();
    mockSse.gatherAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
      queueMicrotask(() => {
        eventBus.get('gather:failed').next({ annotationId: _aid, message: 'Context unavailable' });
      });
    });
await expect(runMatch(makeMatchOptions())).rejects.toThrow('Context unavailable');
  });
});
