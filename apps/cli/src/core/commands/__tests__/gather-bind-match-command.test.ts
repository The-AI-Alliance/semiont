/**
 * Gather, Bind, and Match Command Tests
 *
 * Tests schema validation and command result shapes.
 * Mocks loadCachedClient to avoid network I/O. The mocked SemiontClient
 * exposes the namespace API (semiont.gather.*, semiont.bind.*, semiont.match.*)
 * the production code consumes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { GatherOptionsSchema, runGather, type GatherOptions } from '../gather.js';
import { BindOptionsSchema, runBind, type BindOptions } from '../bind.js';
import { MatchOptionsSchema, runMatch, type MatchOptions } from '../match.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockGather, mockBind, mockMatch, mockLoadCachedClient } = vi.hoisted(() => {
  const mockGather = {
    resource: vi.fn(),
    annotation: vi.fn(),
  };
  const mockBind = {
    body: vi.fn(),
  };
  const mockMatch = {
    search: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockGather, mockBind, mockMatch, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

const semiontStub = {
  gather: mockGather,
  bind: mockBind,
  match: mockMatch,
};

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
    mockLoadCachedClient.mockReturnValue({ semiont: semiontStub, token: 'mock-token' });
    mockGather.resource.mockResolvedValue(mockContext);
    mockGather.annotation.mockReturnValue(of(mockAnnotationContext));
  });

  it('returns CommandResults with command=gather for resource subcommand', async () => {
    const result = await runGather(makeGatherOptions());
    expect(result.command).toBe('gather');
    expect(result.summary.succeeded).toBe(1);
    expect(mockGather.resource).toHaveBeenCalledOnce();
  });

  it('returns CommandResults with command=gather for annotation subcommand', async () => {
    const result = await runGather(makeGatherOptions({ args: ['annotation', 'urn:semiont:resource:doc-1', 'urn:semiont:annotation:ann-1'] }));
    expect(result.command).toBe('gather');
    expect(mockGather.annotation).toHaveBeenCalledOnce();
  });

  it('throws for unknown subcommand', async () => {
    await expect(runGather(makeGatherOptions({ args: ['thing', 'doc-1'] }))).rejects.toThrow('Unknown subcommand');
  });

  it('rejects when gather:failed fires', async () => {
    mockGather.resource.mockReset();
    mockGather.resource.mockRejectedValueOnce(new Error('Gather timed out'));
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
    mockLoadCachedClient.mockReturnValue({ semiont: semiontStub, token: 'mock-token' });
    mockBind.body.mockResolvedValue(undefined);
  });

  it('returns CommandResults with command=bind', async () => {
    const result = await runBind(makeBindOptions());
    expect(result.command).toBe('bind');
    expect(result.summary.succeeded).toBe(1);
    expect(mockBind.body).toHaveBeenCalledOnce();
  });

  it('passes a SpecificResource operation to bind.body', async () => {
    await runBind(makeBindOptions());
    const [, , ops] = mockBind.body.mock.calls[0];
    expect(ops[0]).toMatchObject({ op: 'add', item: { type: 'SpecificResource', purpose: 'linking' } });
  });

  it('records targetResourceId in result metadata', async () => {
    const result = await runBind(makeBindOptions());
    expect(result.results[0]?.metadata?.targetResourceId).toBe('urn:semiont:resource:target');
  });

  it('rejects when bind.body fails', async () => {
    mockBind.body.mockReset();
    mockBind.body.mockRejectedValueOnce(new Error('Target not found'));
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
    mockLoadCachedClient.mockReturnValue({ semiont: semiontStub, token: 'mock-token' });
    mockGather.annotation.mockReturnValue(of({
      annotation: {},
      sourceResource: {},
      sourceContext: { before: '', selected: 'Paris', after: '' },
    }));
    mockMatch.search.mockReturnValue(of({ response: mockResults }));
  });

  it('returns CommandResults with command=match', async () => {
    const result = await runMatch(makeMatchOptions());
    expect(result.command).toBe('match');
    expect(result.summary.succeeded).toBe(1);
  });

  it('calls gather.annotation then match.search in sequence', async () => {
    await runMatch(makeMatchOptions());
    expect(mockGather.annotation).toHaveBeenCalledOnce();
    expect(mockMatch.search).toHaveBeenCalledOnce();
  });

  it('records resultCount in result metadata', async () => {
    const result = await runMatch(makeMatchOptions());
    expect(result.results[0]?.metadata?.resultCount).toBe(1);
  });

  it('applies userHint to the gathered context', async () => {
    await runMatch(makeMatchOptions({ userHint: 'look for Paris papers' }));
    const [, , ctx] = mockMatch.search.mock.calls[0];
    expect((ctx as any).userHint).toBe('look for Paris papers');
  });

  it('rejects when gather.annotation errors', async () => {
    mockGather.annotation.mockReset();
    mockGather.annotation.mockReturnValueOnce(throwError(() => new Error('Context unavailable')));
    await expect(runMatch(makeMatchOptions())).rejects.toThrow('Context unavailable');
  });
});
