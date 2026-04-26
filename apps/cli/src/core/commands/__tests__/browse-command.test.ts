/**
 * Browse Command Tests
 *
 * Tests schema validation and subcommand routing.
 * Mocks loadCachedClient to avoid network I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrowseOptionsSchema, runBrowse, type BrowseOptions } from '../browse.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockBrowse, mockClient, mockLoadCachedClient } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { of: ofRx } = require('rxjs');
  const mockBrowse = {
    resources: vi.fn(() => ofRx([])),
    resource: vi.fn(() => ofRx({ name: 'Doc 1', '@id': 'doc-1' })),
    annotations: vi.fn(() => ofRx([])),
    annotation: vi.fn(() => ofRx({})),
    referencedBy: vi.fn(() => ofRx([])),
    entityTypes: vi.fn(() => ofRx([])),
    resourceEvents: vi.fn(() => Promise.resolve([])),
    annotationHistory: vi.fn(() => Promise.resolve({ events: [] })),
    files: vi.fn(() => Promise.resolve({ path: '', entries: [] })),
  };
  const mockClient = { browse: mockBrowse };
  const mockLoadCachedClient = vi.fn();
  return { mockBrowse, mockClient, mockLoadCachedClient };
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
    sort: undefined,
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

  it('accepts "files" without a path', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['files'] });
    expect(r.success).toBe(true);
  });

  it('accepts "files <path>"', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['files', 'docs'] });
    expect(r.success).toBe(true);
  });

  it('accepts "files" with valid sort values', () => {
    for (const sort of ['name', 'mtime', 'annotationCount']) {
      const r = BrowseOptionsSchema.safeParse({ args: ['files'], sort });
      expect(r.success).toBe(true);
    }
  });

  it('rejects "files" with invalid sort value', () => {
    const r = BrowseOptionsSchema.safeParse({ args: ['files'], sort: 'invalid' });
    expect(r.success).toBe(false);
  });
});

// ── runBrowse tests ───────────────────────────────────────────────────────────

describe('runBrowse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadCachedClient.mockReturnValue({ semiont: mockClient, token: 'mock-token' });
  });

  it('routes "resources" subcommand', async () => {
    const result = await runBrowse(makeOptions({ args: ['resources'] }));
    expect(result.command).toBe('browse');
    expect(mockBrowse.resources).toHaveBeenCalledOnce();
  });

  it('routes "resource <id>" subcommand', async () => {
    const result = await runBrowse(makeOptions({ args: ['resource', 'doc-1'] }));
    expect(result.command).toBe('browse');
    expect(mockBrowse.resource).toHaveBeenCalledOnce();
  });

  it('includes annotations when --annotations flag set', async () => {
    await runBrowse(makeOptions({ args: ['resource', 'doc-1'], annotations: true }));
    expect(mockBrowse.annotations).toHaveBeenCalledOnce();
  });

  it('includes references when --references flag set', async () => {
    await runBrowse(makeOptions({ args: ['resource', 'doc-1'], references: true }));
    expect(mockBrowse.referencedBy).toHaveBeenCalledOnce();
  });

  it('routes "annotation" subcommand', async () => {
    await runBrowse(makeOptions({ args: ['annotation', 'doc-1', 'ann-1'] }));
    expect(mockBrowse.annotation).toHaveBeenCalledOnce();
  });

  it('routes "references" subcommand', async () => {
    await runBrowse(makeOptions({ args: ['references', 'doc-1'] }));
    expect(mockBrowse.referencedBy).toHaveBeenCalledOnce();
  });

  it('routes "events" subcommand', async () => {
    await runBrowse(makeOptions({ args: ['events', 'doc-1'] }));
    expect(mockBrowse.resourceEvents).toHaveBeenCalledOnce();
  });

  it('routes "history" subcommand', async () => {
    await runBrowse(makeOptions({ args: ['history', 'doc-1', 'ann-1'] }));
    expect(mockBrowse.annotationHistory).toHaveBeenCalledOnce();
  });

  it('routes "entity-types" subcommand', async () => {
    await runBrowse(makeOptions({ args: ['entity-types'] }));
    expect(mockBrowse.entityTypes).toHaveBeenCalledOnce();
  });

  it('returns CommandResults with command=browse', async () => {
    const result = await runBrowse(makeOptions());
    expect(result.command).toBe('browse');
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(0);
  });

  // ── files subcommand ───────────────────────────────────────────────────────

  it('routes "files" subcommand without path', async () => {
    await runBrowse(makeOptions({ args: ['files'] }));
    expect(mockBrowse.files).toHaveBeenCalledOnce();
    expect(mockBrowse.files).toHaveBeenCalledWith(undefined, undefined);
  });

  it('routes "files <path>" subcommand with path argument', async () => {
    await runBrowse(makeOptions({ args: ['files', 'docs'] }));
    expect(mockBrowse.files).toHaveBeenCalledWith('docs', undefined);
  });

  it('passes sort option to browse.files', async () => {
    await runBrowse(makeOptions({ args: ['files', 'docs'], sort: 'mtime' }));
    expect(mockBrowse.files).toHaveBeenCalledWith('docs', 'mtime');
  });

  it('passes annotationCount sort to browse.files', async () => {
    await runBrowse(makeOptions({ args: ['files'], sort: 'annotationCount' }));
    expect(mockBrowse.files).toHaveBeenCalledWith(undefined, 'annotationCount');
  });
});
