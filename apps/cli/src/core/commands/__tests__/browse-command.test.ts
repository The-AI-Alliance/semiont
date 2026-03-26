/**
 * Browse Command Tests
 *
 * Tests schema validation and subcommand routing.
 * Mocks createAuthenticatedClient to avoid network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowseOptionsSchema, type BrowseOptions } from '../browse.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

vi.mock('../../api-client-factory.js', () => ({
  createAuthenticatedClient: vi.fn().mockResolvedValue({
    client: mockClient,
    token: 'mock-token',
  }),
}));

vi.mock('../../config-loader.js', () => ({
  findProjectRoot: vi.fn(() => '/test/project/root'),
  loadEnvironmentConfig: vi.fn(() => ({
    services: { backend: { publicURL: 'http://localhost:4000' } },
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOptions(overrides: Partial<BrowseOptions> = {}): BrowseOptions {
  return {
    environment: 'test',
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
    user: undefined,
    password: undefined,
    ...overrides,
  };
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('BrowseOptionsSchema', () => {
  it('accepts "resources" subcommand', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['resources'] });
    expect(r.success).toBe(true);
  });

  it('rejects unknown subcommand', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['foobar'] });
    expect(r.success).toBe(false);
  });

  it('rejects "resource" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['resource'] });
    expect(r.success).toBe(false);
  });

  it('accepts "resource <id>"', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['resource', 'doc-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects "annotation" without both ids', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['annotation', 'doc-1'] });
    expect(r.success).toBe(false);
  });

  it('accepts "annotation <resourceId> <annotationId>"', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['annotation', 'doc-1', 'ann-1'] });
    expect(r.success).toBe(true);
  });

  it('rejects "references" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['references'] });
    expect(r.success).toBe(false);
  });

  it('rejects "events" without resourceId', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['events'] });
    expect(r.success).toBe(false);
  });

  it('rejects "history" without annotationId', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['history', 'doc-1'] });
    expect(r.success).toBe(false);
  });

  it('accepts "entity-types"', () => {
    const r = BrowseOptionsSchema.safeParse({ environment: 'test', args: ['entity-types'] });
    expect(r.success).toBe(true);
  });
});

// ── runBrowse tests ───────────────────────────────────────────────────────────

describe('runBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const { runBrowse } = await import('../browse.js');
    const result = await runBrowse(makeOptions({ args: ['resources'] }));
    expect(result.command).toBe('browse');
    expect(mockClient.browseResources).toHaveBeenCalledOnce();
  });

  it('routes "resource <id>" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    const result = await runBrowse(makeOptions({ args: ['resource', 'doc-1'] }));
    expect(result.command).toBe('browse');
    expect(mockClient.browseResource).toHaveBeenCalledOnce();
  });

  it('includes annotations when --annotations flag set', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['resource', 'doc-1'], annotations: true }));
    expect(mockClient.browseAnnotations).toHaveBeenCalledOnce();
  });

  it('includes references when --references flag set', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['resource', 'doc-1'], references: true }));
    expect(mockClient.browseReferences).toHaveBeenCalledOnce();
  });

  it('routes "annotation" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['annotation', 'doc-1', 'ann-1'] }));
    expect(mockClient.browseAnnotation).toHaveBeenCalledOnce();
  });

  it('routes "references" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['references', 'doc-1'] }));
    expect(mockClient.browseReferences).toHaveBeenCalledOnce();
  });

  it('routes "events" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['events', 'doc-1'] }));
    expect(mockClient.getResourceEvents).toHaveBeenCalledOnce();
  });

  it('routes "history" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['history', 'doc-1', 'ann-1'] }));
    expect(mockClient.getAnnotationHistory).toHaveBeenCalledOnce();
  });

  it('routes "entity-types" subcommand', async () => {
    const { runBrowse } = await import('../browse.js');
    await runBrowse(makeOptions({ args: ['entity-types'] }));
    expect(mockClient.listEntityTypes).toHaveBeenCalledOnce();
  });

  it('returns CommandResults with command=browse', async () => {
    const { runBrowse } = await import('../browse.js');
    const result = await runBrowse(makeOptions());
    expect(result.command).toBe('browse');
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
  });
});
