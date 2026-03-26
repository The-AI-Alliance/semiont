/**
 * Browse Command Tests
 *
 * Tests schema validation and subcommand routing.
 * Mocks loadCachedClient to avoid network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowseOptionsSchema, runBrowse, type BrowseOptions } from '../browse.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockClient, mockLoadCachedClient } = vi.hoisted(() => {
  const mockClient = {
    browseResources: vi.fn(),
    browseResource: vi.fn(),
    browseAnnotations: vi.fn(),
    browseReferences: vi.fn(),
    browseAnnotation: vi.fn(),
    getResourceEvents: vi.fn(),
    getAnnotationHistory: vi.fn(),
    listEntityTypes: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockClient, mockLoadCachedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<BrowseOptions> = {}): BrowseOptions {
  return {
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    args: ['resources'],
    search: undefined,
    entityType: [],
    limit: 50,
    annotations: false,
    references: false,
    bus: undefined,
    ...overrides,
  };
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('BrowseOptionsSchema', () => {
  it('accepts "resources" subcommand', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['resources'] });
    expect(r.success).toBe(true);
  });

  it('rejects unknown subcommand', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['unknown'] });
    expect(r.success).toBe(false);
  });

  it('rejects "resource" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['resource'] });
    expect(r.success).toBe(false);
  });

  it('accepts "resource <id>"', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['resource', 'doc-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects "annotation" without both ids', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['annotation', 'doc-1'] });
    expect(r.success).toBe(false);
  });

  it('accepts "annotation <resourceId> <annotationId>"', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['annotation', 'doc-1', 'ann-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects "references" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['references'] });
    expect(r.success).toBe(false);
  });

  it('rejects "events" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['events'] });
    expect(r.success).toBe(false);
  });

  it('rejects "history" without annotationId', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['history', 'doc-1'] });
    expect(r.success).toBe(false);
  });

  it('accepts "entity-types"', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['entity-types'] });
    expect(r.success).toBe(true);
  });
});

// ── runBrowse tests ───────────────────────────────────────────────────────────

describe('runBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ client: mockClient, token: 'mock-token' });
    mockClient.browseResources.mockResolvedValue({ resources: [], total: 0 });
    mockClient.browseResource.mockResolvedValue({ name: 'Doc 1', '@id': 'doc-1' });
    mockClient.browseAnnotations.mockResolvedValue({ annotations: [] });
    mockClient.browseReferences.mockResolvedValue({ referencedBy: [] });
    mockClient.browseAnnotation.mockResolvedValue({ annotation: {} });
    mockClient.getResourceEvents.mockResolvedValue({ events: [] });
    mockClient.getAnnotationHistory.mockResolvedValue({ events: [] });
    mockClient.listEntityTypes.mockResolvedValue({ entityTypes: [] });
  });

  it('routes "resources" subcommand', async () => {
const result = await runBrowse(makeOptions({ args: ['resources'] }));
    expect(result.command).toBe('browse');
    expect(mockClient.browseResources).toHaveBeenCalledOnce();
  });

  it('routes "resource <id>" subcommand', async () => {
const result = await runBrowse(makeOptions({ args: ['resource', 'doc-1'] }));
    expect(result.command).toBe('browse');
    expect(mockClient.browseResource).toHaveBeenCalledOnce();
  });

  it('includes annotations when --annotations flag set', async () => {
await runBrowse(makeOptions({ args: ['resource', 'doc-1'], annotations: true }));
    expect(mockClient.browseAnnotations).toHaveBeenCalledOnce();
  });

  it('includes references when --references flag set', async () => {
await runBrowse(makeOptions({ args: ['resource', 'doc-1'], references: true }));
    expect(mockClient.browseReferences).toHaveBeenCalledOnce();
  });

  it('routes "annotation" subcommand', async () => {
await runBrowse(makeOptions({ args: ['annotation', 'doc-1', 'ann-1'] }));
    expect(mockClient.browseAnnotation).toHaveBeenCalledOnce();
  });

  it('routes "references" subcommand', async () => {
await runBrowse(makeOptions({ args: ['references', 'doc-1'] }));
    expect(mockClient.browseReferences).toHaveBeenCalledOnce();
  });

  it('routes "events" subcommand', async () => {
await runBrowse(makeOptions({ args: ['events', 'doc-1'] }));
    expect(mockClient.getResourceEvents).toHaveBeenCalledOnce();
  });

  it('routes "history" subcommand', async () => {
await runBrowse(makeOptions({ args: ['history', 'doc-1', 'ann-1'] }));
    expect(mockClient.getAnnotationHistory).toHaveBeenCalledOnce();
  });

  it('routes "entity-types" subcommand', async () => {
await runBrowse(makeOptions({ args: ['entity-types'] }));
    expect(mockClient.listEntityTypes).toHaveBeenCalledOnce();
  });

  it('returns CommandResults with command=browse', async () => {
const result = await runBrowse(makeOptions());
    expect(result.command).toBe('browse');
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
  });
});
