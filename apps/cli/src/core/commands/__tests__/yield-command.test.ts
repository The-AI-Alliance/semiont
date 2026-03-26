/**
 * Yield Command Tests
 *
 * Tests schema validation and both upload + delegate modes.
 * Mocks createAuthenticatedClient and fs to avoid I/O.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YieldOptionsSchema, type YieldOptions } from '../yield.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockYieldResource, mockSse, mockCreateAuthenticatedClient } = vi.hoisted(() => {
  const mockYieldResource = vi.fn();
  const mockSse = {
    gatherAnnotation: vi.fn(),
    yieldResource: vi.fn(),
  };
  const mockCreateAuthenticatedClient = vi.fn();
  return { mockYieldResource, mockSse, mockCreateAuthenticatedClient };
});

vi.mock('../../api-client-factory.js', () => ({
  createAuthenticatedClient: mockCreateAuthenticatedClient,
}));

vi.mock('../../config-loader.js', () => ({
  findProjectRoot: vi.fn(() => '/test/project/root'),
  loadEnvironmentConfig: vi.fn(() => ({
    services: { backend: { publicURL: 'http://localhost:4000' } },
  })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: vi.fn().mockResolvedValue(Buffer.from('file content')),
    },
  };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUploadOptions(overrides: Partial<YieldOptions> = {}): YieldOptions {
  return {
    environment: 'test',
    verbose: false,
    dryRun: false,
    quiet: true,
    output: 'json',
    forceDiscovery: false,
    preflight: false,
    upload: ['/test/project/root/docs/overview.md'],
    delegate: false,
    name: undefined,
    resource: undefined,
    annotation: undefined,
    storageUri: undefined,
    title: undefined,
    prompt: undefined,
    language: undefined,
    temperature: undefined,
    maxTokens: undefined,
    contextWindow: 1000,
    bus: undefined,
    user: undefined,
    password: undefined,
    ...overrides,
  };
}

function makeDelegateOptions(overrides: Partial<YieldOptions> = {}): YieldOptions {
  return makeUploadOptions({
    upload: [],
    delegate: true,
    resource: 'urn:semiont:resource:doc-1',
    annotation: 'urn:semiont:annotation:ann-1',
    storageUri: 'file://generated/output.md',
    ...overrides,
  });
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('YieldOptionsSchema', () => {
  it('accepts upload mode with one file', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      upload: ['docs/overview.md'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects when neither upload nor delegate is given', () => {
    const r = YieldOptionsSchema.safeParse({ environment: 'test' });
    expect(r.success).toBe(false);
  });

  it('rejects when both upload and delegate are given', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      upload: ['docs/a.md'],
      delegate: true,
      resource: 'doc-1',
      annotation: 'ann-1',
      storageUri: 'file://out.md',
    });
    expect(r.success).toBe(false);
  });

  it('rejects --name with multiple upload files', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      upload: ['a.md', 'b.md'],
      name: 'My Name',
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate without --resource', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      delegate: true,
      annotation: 'ann-1',
      storageUri: 'file://out.md',
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate without --annotation', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      delegate: true,
      resource: 'doc-1',
      storageUri: 'file://out.md',
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate without --storage-uri', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      delegate: true,
      resource: 'doc-1',
      annotation: 'ann-1',
    });
    expect(r.success).toBe(false);
  });

  it('rejects temperature > 1', () => {
    const r = YieldOptionsSchema.safeParse({
      environment: 'test',
      delegate: true,
      resource: 'doc-1',
      annotation: 'ann-1',
      storageUri: 'file://out.md',
      temperature: 1.5,
    });
    expect(r.success).toBe(false);
  });
});

// ── runYield tests ────────────────────────────────────────────────────────────

describe('runYield', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockYieldResource.mockResolvedValue({ resourceId: 'urn:semiont:resource:new-1' });
    mockCreateAuthenticatedClient.mockResolvedValue({
      client: { yieldResource: mockYieldResource, sse: mockSse },
      token: 'mock-token',
    });
  });

  describe('upload mode', () => {
    it('returns CommandResults with command=yield', async () => {
      const { runYield } = await import('../yield.js');
      const result = await runYield(makeUploadOptions());
      expect(result.command).toBe('yield');
      expect(result.summary.succeeded).toBe(1);
    });

    it('calls client.yieldResource for each file', async () => {
      const { runYield } = await import('../yield.js');
      await runYield(makeUploadOptions({ upload: ['/test/project/root/a.md', '/test/project/root/b.md'] }));
      expect(mockYieldResource).toHaveBeenCalledTimes(2);
    });

    it('uses provided --name for single file', async () => {
      const { runYield } = await import('../yield.js');
      await runYield(makeUploadOptions({ name: 'My Overview' }));
      const [req] = mockYieldResource.mock.calls[0];
      expect(req.name).toBe('My Overview');
    });

    it('uses basename as name when --name not provided', async () => {
      const { runYield } = await import('../yield.js');
      await runYield(makeUploadOptions({ upload: ['/test/project/root/docs/overview.md'] }));
      const [req] = mockYieldResource.mock.calls[0];
      expect(req.name).toBe('overview');
    });

    it('records resourceId in result metadata', async () => {
      const { runYield } = await import('../yield.js');
      const result = await runYield(makeUploadOptions());
      expect(result.results[0]?.metadata?.resourceId).toBe('urn:semiont:resource:new-1');
    });

    it('counts failed for missing file', async () => {
      const { promises: fs } = await import('fs');
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
      const { runYield } = await import('../yield.js');
      const result = await runYield(makeUploadOptions());
      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });
  });

  describe('delegate mode', () => {
    beforeEach(() => {
      mockSse.gatherAnnotation.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => {
          eventBus.get('gather:annotation-finished').next({
            annotationId: _aid,
            response: {
              context: {
                annotation: {},
                sourceResource: {},
                sourceContext: { before: '', selected: 'text', after: '' },
              },
            },
          });
        });
      });
      mockSse.yieldResource.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => {
          eventBus.get('yield:finished').next({ resourceId: 'urn:semiont:resource:generated-1', resourceName: 'Generated' });
        });
      });
    });

    it('returns CommandResults with command=yield', async () => {
      const { runYield } = await import('../yield.js');
      const result = await runYield(makeDelegateOptions());
      expect(result.command).toBe('yield');
      expect(result.summary.succeeded).toBe(1);
    });

    it('calls gatherAnnotation then yieldResource', async () => {
      const { runYield } = await import('../yield.js');
      await runYield(makeDelegateOptions());
      expect(mockSse.gatherAnnotation).toHaveBeenCalledOnce();
      expect(mockSse.yieldResource).toHaveBeenCalledOnce();
    });

    it('records storageUri in result metadata', async () => {
      const { runYield } = await import('../yield.js');
      const result = await runYield(makeDelegateOptions());
      expect(result.results[0]?.metadata?.storageUri).toBe('file://generated/output.md');
    });

    it('rejects when yield:failed fires', async () => {
      mockSse.yieldResource.mockReset();
      mockSse.yieldResource.mockImplementationOnce((_rid: any, _aid: any, _req: any, { eventBus }: any) => {
        queueMicrotask(() => eventBus.get('yield:failed').next({ error: new Error('Generation failed') }));
      });
      const { runYield } = await import('../yield.js');
      await expect(runYield(makeDelegateOptions())).rejects.toThrow('Generation failed');
    });
  });
});
