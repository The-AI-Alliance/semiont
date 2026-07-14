/**
 * Yield Command Tests
 *
 * Tests schema validation and both upload + delegate modes.
 * Mocks loadCachedClient and fs to avoid I/O. The mocked SemiontClient
 * exposes the namespace API (semiont.yield.*, semiont.gather.annotation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { YieldOptionsSchema, runYield, type YieldOptions } from '../yield.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const { mockYield, mockGather, mockLoadCachedClient } = vi.hoisted(() => {
  const mockYield = {
    resource: vi.fn(),
    fromAnnotation: vi.fn(),
    fromResource: vi.fn(),
  };
  const mockGather = {
    annotation: vi.fn(),
    resource: vi.fn(),
  };
  const mockLoadCachedClient = vi.fn();
  return { mockYield, mockGather, mockLoadCachedClient };
});

vi.mock('../../client-factory.js', () => ({
  resolveBusUrl: vi.fn(() => 'http://localhost:4000'),
  loadCachedClient: mockLoadCachedClient,
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

const semiontStub = {
  yield: mockYield,
  gather: mockGather,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUploadOptions(overrides: Partial<YieldOptions> = {}): YieldOptions {
  return {
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

// Resource-anchored delegate: --resource + --storage-uri, no --annotation.
function makeResourceDelegateOptions(overrides: Partial<YieldOptions> = {}): YieldOptions {
  return makeDelegateOptions({
    annotation: undefined,
    storageUri: 'file://generated/derived.md',
    ...overrides,
  });
}

// ── Schema tests ──────────────────────────────────────────────────────────────

describe('YieldOptionsSchema', () => {
  it('accepts upload mode with one file', () => {
    const r = YieldOptionsSchema.safeParse({
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
      upload: ['a.md', 'b.md'],
      name: 'My Name',
    });
    expect(r.success).toBe(false);
  });

  it('rejects delegate without --resource', () => {
    const r = YieldOptionsSchema.safeParse({
      delegate: true,
      annotation: 'ann-1',
      storageUri: 'file://out.md',
    });
    expect(r.success).toBe(false);
  });

  it('accepts delegate without --annotation (resource-anchored mode)', () => {
    const r = YieldOptionsSchema.safeParse({
      delegate: true,
      resource: 'doc-1',
      storageUri: 'file://out.md',
    });
    expect(r.success).toBe(true);
  });

  it('rejects delegate without --storage-uri', () => {
    const r = YieldOptionsSchema.safeParse({
      delegate: true,
      resource: 'doc-1',
      annotation: 'ann-1',
    });
    expect(r.success).toBe(false);
  });

  it('rejects temperature > 1', () => {
    const r = YieldOptionsSchema.safeParse({
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
    mockYield.resource.mockResolvedValue({ resourceId: 'urn:semiont:resource:new-1' });
    mockLoadCachedClient.mockReturnValue({ semiont: semiontStub, token: 'mock-token' });
  });

  describe('upload mode', () => {
    it('returns CommandResults with command=yield', async () => {
      const result = await runYield(makeUploadOptions());
      expect(result.command).toBe('yield');
      expect(result.summary.succeeded).toBe(1);
    });

    it('calls yield.resource for each file', async () => {
      await runYield(makeUploadOptions({ upload: ['/test/project/root/a.md', '/test/project/root/b.md'] }));
      expect(mockYield.resource).toHaveBeenCalledTimes(2);
    });

    it('uses provided --name for single file', async () => {
      await runYield(makeUploadOptions({ name: 'My Overview' }));
      const [req] = mockYield.resource.mock.calls[0];
      expect(req.name).toBe('My Overview');
    });

    it('uses basename as name when --name not provided', async () => {
      await runYield(makeUploadOptions({ upload: ['/test/project/root/docs/overview.md'] }));
      const [req] = mockYield.resource.mock.calls[0];
      expect(req.name).toBe('overview');
    });

    it('records resourceId in result metadata', async () => {
      const result = await runYield(makeUploadOptions());
      expect(result.results[0]?.metadata?.resourceId).toBe('urn:semiont:resource:new-1');
    });

    it('counts failed for missing file', async () => {
      const { promises: fs } = await import('fs');
      vi.mocked(fs.readFile).mockRejectedValueOnce(new Error('ENOENT'));
      const result = await runYield(makeUploadOptions());
      expect(result.summary.failed).toBe(1);
      expect(result.summary.succeeded).toBe(0);
    });

    // Format detection goes through core's registry (mediaTypeForExtension) —
    // these cases pin the alias equivalence the old local guessFormat map had,
    // and the octet-stream fallback for unknown extensions.
    describe('format detection', () => {
      it.each([
        ['/test/project/root/docs/a.md', 'text/markdown'],
        ['/test/project/root/docs/a.markdown', 'text/markdown'],
        ['/test/project/root/docs/a.htm', 'text/html'],
        ['/test/project/root/docs/a.jpeg', 'image/jpeg'],
      ])('detects %s as %s', async (filePath, expectedFormat) => {
        await runYield(makeUploadOptions({ upload: [filePath] }));
        const [req] = mockYield.resource.mock.calls[0];
        expect(req.format).toBe(expectedFormat);
      });

      it('falls back to application/octet-stream for unknown extensions', async () => {
        await runYield(makeUploadOptions({ upload: ['/test/project/root/data.xyz'] }));
        const [req] = mockYield.resource.mock.calls[0];
        expect(req.format).toBe('application/octet-stream');
      });
    });
  });

  describe('delegate mode', () => {
    beforeEach(() => {
      mockGather.annotation.mockReturnValue(of({
        annotation: {},
        sourceResource: {},
        sourceContext: { before: '', selected: 'text', after: '' },
      }));
      mockYield.fromAnnotation.mockReturnValue(of({
        kind: 'complete',
        data: {
          jobId: 'j1',
          resourceId: 'res-1',
          jobType: 'generation',
          result: { resourceId: 'urn:semiont:resource:generated-1', resourceName: 'Generated' },
        },
      }));
    });

    it('returns CommandResults with command=yield', async () => {
      const result = await runYield(makeDelegateOptions());
      expect(result.command).toBe('yield');
      expect(result.summary.succeeded).toBe(1);
    });

    it('calls gather.annotation then yield.fromAnnotation', async () => {
      await runYield(makeDelegateOptions());
      expect(mockGather.annotation).toHaveBeenCalledOnce();
      expect(mockYield.fromAnnotation).toHaveBeenCalledOnce();
    });

    it('records storageUri in result metadata', async () => {
      const result = await runYield(makeDelegateOptions());
      expect(result.results[0]?.metadata?.storageUri).toBe('file://generated/output.md');
    });

    it('rejects when yield.fromAnnotation errors', async () => {
      mockYield.fromAnnotation.mockReset();
      mockYield.fromAnnotation.mockReturnValueOnce(throwError(() => new Error('Generation failed')));
      await expect(runYield(makeDelegateOptions())).rejects.toThrow('Generation failed');
    });

    it('passes outputMediaType through to yield.fromAnnotation', async () => {
      await runYield(makeDelegateOptions({ outputMediaType: 'text/html' }));
      const [, , opts] = mockYield.fromAnnotation.mock.calls[0];
      expect(opts.outputMediaType).toBe('text/html');
    });

    it('rejects an unknown outputMediaType (membership guard)', async () => {
      await expect(runYield(makeDelegateOptions({ outputMediaType: 'text/markdwn' })))
        .rejects.toThrow(/text\/markdwn/);
    });

    it('passes task/structure through to yield.fromAnnotation (open-string task, canonical chat)', async () => {
      await runYield(makeDelegateOptions({ task: 'translate to French', structure: 'chat' }));
      const [, , opts] = mockYield.fromAnnotation.mock.calls[0];
      expect(opts.task).toBe('translate to French');
      expect(opts.structure).toBe('chat');
    });
  });

  describe('delegate mode — resource-anchored', () => {
    beforeEach(() => {
      // gather.resource is a Promise (resource-focus), unlike gather.annotation (Observable)
      mockGather.resource.mockResolvedValue({
        focus: { kind: 'resource', resource: {} },
        graph: { nodes: [], edges: [] },
        metadata: {},
      });
      mockYield.fromResource.mockReturnValue(of({
        kind: 'complete',
        data: {
          jobId: 'j2',
          resourceId: 'res-2',
          jobType: 'generation',
          result: { resourceId: 'urn:semiont:resource:derived-1', resourceName: 'Derived' },
        },
      }));
    });

    it('calls gather.resource then yield.fromResource (no annotation)', async () => {
      await runYield(makeResourceDelegateOptions());
      expect(mockGather.resource).toHaveBeenCalledOnce();
      expect(mockYield.fromResource).toHaveBeenCalledOnce();
      expect(mockGather.annotation).not.toHaveBeenCalled();
      expect(mockYield.fromAnnotation).not.toHaveBeenCalled();
    });

    it('grounds the gather (includeContent + includeSummary)', async () => {
      await runYield(makeResourceDelegateOptions());
      const [, opts] = mockGather.resource.mock.calls[0];
      expect(opts).toMatchObject({ includeContent: true, includeSummary: true });
    });

    it('records the derived resourceId in result metadata', async () => {
      const result = await runYield(makeResourceDelegateOptions());
      expect(result.results[0]?.metadata?.resourceId).toBe('urn:semiont:resource:derived-1');
    });

    it('passes outputMediaType through to yield.fromResource', async () => {
      await runYield(makeResourceDelegateOptions({ outputMediaType: 'text/plain' }));
      const [, opts] = mockYield.fromResource.mock.calls[0];
      expect(opts.outputMediaType).toBe('text/plain');
    });

    it('rejects when yield.fromResource errors', async () => {
      mockYield.fromResource.mockReset();
      mockYield.fromResource.mockReturnValueOnce(throwError(() => new Error('Derive failed')));
      await expect(runYield(makeResourceDelegateOptions())).rejects.toThrow('Derive failed');
    });

    it('passes task/structure through to yield.fromResource (the Q&A recipe)', async () => {
      await runYield(makeResourceDelegateOptions({ task: 'answer', structure: 'prose' }));
      const [, opts] = mockYield.fromResource.mock.calls[0];
      expect(opts.task).toBe('answer');
      expect(opts.structure).toBe('prose');
    });

    it('leaves task/structure undefined when the flags are unset (D2: no CLI defaults)', async () => {
      await runYield(makeResourceDelegateOptions());
      const [, opts] = mockYield.fromResource.mock.calls[0];
      expect(opts.task).toBeUndefined();
      expect(opts.structure).toBeUndefined();
    });
  });
});
