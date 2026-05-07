/**
 * Browser Actor Tests
 *
 * Tests path validation (traversal guards) and directory listing logic.
 * Filesystem and ViewStorage are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, resourceId, type Logger } from '@semiont/core';
import { Browser } from '../browser';

// ── fs mock ───────────────────────────────────────────────────────────────────

vi.mock('fs', () => {
  const stat = vi.fn();
  const readdir = vi.fn();
  return {
    promises: { stat, readdir },
    type: undefined,        // Dirent type import — not a value
  };
});

import { promises as fsMock } from 'fs';
const mockStat   = fsMock.stat   as ReturnType<typeof vi.fn>;
const mockReaddir = fsMock.readdir as ReturnType<typeof vi.fn>;

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDirent(name: string, isDir: boolean) {
  return {
    name,
    isDirectory: () => isDir,
    isFile:      () => !isDir,
  };
}

const PROJECT_ROOT = '/home/user/myproject';

const mockLogger: Logger = {
  debug: vi.fn(),
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  child: vi.fn(function() { return mockLogger; }),
};

function makeViews(views: Array<{ storageUri: string; resourceId: string; entityTypes?: string[] }>) {
  return {
    getAll: vi.fn().mockResolvedValue(
      views.map((v) => ({
        resource: {
          '@id':           v.resourceId,
          storageUri:      v.storageUri,
          entityTypes:     v.entityTypes ?? [],
          wasAttributedTo: { '@id': 'did:user:test' },
        },
        annotations: { annotations: [] },
      })),
    ),
  };
}

const defaultStat = { size: 1024, mtime: new Date('2026-01-01T00:00:00Z') };

const mockKb = { graph: {}, views: {} } as any;

// ── tests ─────────────────────────────────────────────────────────────────────

describe('Browser actor', () => {
  let eventBus: EventBus;
  let browser: Browser;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();

    browser = new Browser(
      makeViews([]) as any,
      mockKb,
      eventBus,
      { root: PROJECT_ROOT } as any,
      mockLogger,
    );
    await browser.initialize();
  });

  afterEach(async () => {
    await browser.stop();
    eventBus.destroy();
  });

  // ── path traversal guard ───────────────────────────────────────────────────

  describe('path traversal guard', () => {
    const CASES = [
      { label: 'parent traversal (../)',       path: '../other' },
      { label: 'deep traversal (../../etc)',   path: '../../etc' },
      { label: 'absolute path (/etc/passwd)',  path: '/etc/passwd' },
      { label: 'mixed traversal (a/../../../b)', path: 'a/../../../b' },
    ];

    for (const { label, path } of CASES) {
      it(`rejects ${label}`, async () => {
        const failed$ = eventBus.get('browse:directory-failed');
        const resultPromise = new Promise<any>((resolve) => failed$.subscribe(resolve));

        eventBus.get('browse:directory-requested').next({
          correlationId: 'cid-1',
          path,
        });

        const event = await resultPromise;
        expect(event.correlationId).toBe('cid-1');
        expect(event.message).toBe('path escapes project root');
      });
    }

    it('allows project root (empty string)', async () => {
      mockReaddir.mockResolvedValue([]);
      const result$ = eventBus.get('browse:directory-result');
      const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

      eventBus.get('browse:directory-requested').next({ correlationId: 'cid-2', path: '' });

      const event = await resultPromise;
      expect(event.correlationId).toBe('cid-2');
      expect(event.response.entries).toEqual([]);
    });

    it('allows a valid subdirectory', async () => {
      mockReaddir.mockResolvedValue([]);
      const result$ = eventBus.get('browse:directory-result');
      const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

      eventBus.get('browse:directory-requested').next({ correlationId: 'cid-3', path: 'docs' });

      const event = await resultPromise;
      expect(event.response.path).toBe('docs');
    });
  });

  // ── missing directory ──────────────────────────────────────────────────────

  it('emits browse:directory-failed when directory does not exist', async () => {
    const err: any = new Error('ENOENT: no such file');
    err.code = 'ENOENT';
    mockReaddir.mockRejectedValue(err);

    const failed$ = eventBus.get('browse:directory-failed');
    const resultPromise = new Promise<any>((resolve) => failed$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-4', path: 'missing' });

    const event = await resultPromise;
    expect(event.message).toBe('path not found');
  });

  // ── directory listing ──────────────────────────────────────────────────────

  it('returns file and dir entries', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('README.md', false),
      makeDirent('docs', true),
    ]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-5', path: '' });

    const { response } = await resultPromise;
    expect(response.entries).toHaveLength(2);
    expect(response.entries.find((e: any) => e.name === 'README.md').type).toBe('file');
    expect(response.entries.find((e: any) => e.name === 'docs').type).toBe('dir');
  });

  it('excludes dotfiles and .semiont', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('.hidden', false),
      makeDirent('.semiont', true),
      makeDirent('visible.txt', false),
    ]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-6', path: '' });

    const { response } = await resultPromise;
    expect(response.entries).toHaveLength(1);
    expect(response.entries[0].name).toBe('visible.txt');
  });

  // ── KB metadata merge ──────────────────────────────────────────────────────

  it('marks a file as tracked when it has a KB resource', async () => {
    // Stop the default empty-views browser so it doesn't race with this one
    await browser.stop();

    const fileUri = `file://${PROJECT_ROOT}/intro.md`;
    browser = new Browser(
      makeViews([{ storageUri: fileUri, resourceId: 'res:abc', entityTypes: ['Article'] }]) as any,
      mockKb,
      eventBus,
      { root: PROJECT_ROOT } as any,
      mockLogger,
    );
    await browser.initialize();

    mockReaddir.mockResolvedValue([makeDirent('intro.md', false)]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-7', path: '' });

    const { response } = await resultPromise;
    const entry = response.entries[0];
    expect(entry.tracked).toBe(true);
    expect(entry.resourceId).toBe('res:abc');
    expect(entry.entityTypes).toEqual(['Article']);
  });

  it('marks a file as untracked when not in KB', async () => {
    mockReaddir.mockResolvedValue([makeDirent('scratch.md', false)]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-8', path: '' });

    const { response } = await resultPromise;
    expect(response.entries[0].tracked).toBe(false);
    expect(response.entries[0].resourceId).toBeUndefined();
  });

  // ── sorting ────────────────────────────────────────────────────────────────

  it('sorts by name by default', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('zebra.txt', false),
      makeDirent('apple.txt', false),
      makeDirent('mango.txt', false),
    ]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-9', path: '' });

    const { response } = await resultPromise;
    const names = response.entries.map((e: any) => e.name);
    expect(names).toEqual(['apple.txt', 'mango.txt', 'zebra.txt']);
  });

  it('sorts by mtime descending when sort=mtime', async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('old.txt',   false),
      makeDirent('new.txt',   false),
    ]);
    mockStat
      .mockResolvedValueOnce({ size: 100, mtime: new Date('2025-01-01') })
      .mockResolvedValueOnce({ size: 100, mtime: new Date('2026-01-01') });

    const result$ = eventBus.get('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.get('browse:directory-requested').next({ correlationId: 'cid-10', path: '', sort: 'mtime' });

    const { response } = await resultPromise;
    expect(response.entries[0].name).toBe('new.txt');
  });

  // ── referenced-by handling ─────────────────────────────────────────────────

  describe('referenced-by handling', () => {
    const DOC_A_URI = 'doc-a';
    const DOC_B_URI = 'doc-b';
    const TARGET_RESOURCE_ID = resourceId('target-res');

    let mockReferencedBy: ReturnType<typeof vi.fn>;
    let mockGetResource: ReturnType<typeof vi.fn>;

    function makeAnnotation(id: string, targetSource: string, bodySource: string, exact = 'selected text') {
      return {
        id,
        '@context': 'http://www.w3.org/ns/anno.jsonld',
        type: 'Annotation',
        motivation: 'linking',
        target: { source: targetSource, selector: [{ type: 'TextQuoteSelector', exact }] },
        body: { source: bodySource },
      };
    }

    function resultPromise() {
      return new Promise<any>((resolve) => (eventBus as any).get('browse:referenced-by-result').subscribe(resolve));
    }

    function failedPromise() {
      return new Promise<any>((resolve) => (eventBus as any).get('browse:referenced-by-failed').subscribe(resolve));
    }

    function fire(payload: object) {
      (eventBus as any).get('browse:referenced-by-requested').next(payload);
    }

    beforeEach(async () => {
      await browser.stop();
      vi.clearAllMocks();
      mockReferencedBy = vi.fn();
      mockGetResource = vi.fn();
      const kb = { graph: { getResourceReferencedBy: mockReferencedBy, getResource: mockGetResource } } as any;
      browser = new Browser(makeViews([]) as any, kb, eventBus, { root: PROJECT_ROOT } as any, mockLogger);
      await browser.initialize();
    });

    it('emits referenced-by-result with resource names and selectors', async () => {
      const anno1 = makeAnnotation('anno-1', DOC_A_URI, String(TARGET_RESOURCE_ID), 'Prometheus');
      const anno2 = makeAnnotation('anno-2', DOC_B_URI, String(TARGET_RESOURCE_ID), 'the Titan');
      mockReferencedBy.mockResolvedValue([anno1, anno2]);
      mockGetResource.mockImplementation((id: any) => {
        if (id === resourceId('doc-a')) return Promise.resolve({ '@id': DOC_A_URI, name: 'Prometheus Bound' });
        if (id === resourceId('doc-b')) return Promise.resolve({ '@id': DOC_B_URI, name: 'Greek Myths' });
        return Promise.resolve(null);
      });

      const p = resultPromise();
      fire({ correlationId: 'corr-1', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.correlationId).toBe('corr-1');
      expect(result.response.referencedBy).toHaveLength(2);
      expect(result.response.referencedBy[0]).toEqual({ id: 'anno-1', resourceName: 'Prometheus Bound', target: { source: DOC_A_URI, selector: { exact: 'Prometheus' } } });
      expect(result.response.referencedBy[1]).toEqual({ id: 'anno-2', resourceName: 'Greek Myths', target: { source: DOC_B_URI, selector: { exact: 'the Titan' } } });
      expect(mockReferencedBy).toHaveBeenCalledWith(TARGET_RESOURCE_ID, undefined);
    });

    it('passes motivation filter to graph query', async () => {
      mockReferencedBy.mockResolvedValue([]);
      const p = resultPromise();
      fire({ correlationId: 'corr-2', resourceId: TARGET_RESOURCE_ID, motivation: 'linking' });
      await p;
      expect(mockReferencedBy).toHaveBeenCalledWith(TARGET_RESOURCE_ID, 'linking');
    });

    it('handles empty referenced-by results', async () => {
      mockReferencedBy.mockResolvedValue([]);
      const p = resultPromise();
      fire({ correlationId: 'corr-3', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.response.referencedBy).toEqual([]);
      expect(mockGetResource).not.toHaveBeenCalled();
    });

    it('deduplicates source resource lookups', async () => {
      const anno1 = makeAnnotation('anno-1', DOC_A_URI, String(TARGET_RESOURCE_ID), 'first mention');
      const anno2 = makeAnnotation('anno-2', DOC_A_URI, String(TARGET_RESOURCE_ID), 'second mention');
      mockReferencedBy.mockResolvedValue([anno1, anno2]);
      mockGetResource.mockResolvedValue({ '@id': DOC_A_URI, name: 'Prometheus Bound' });
      const p = resultPromise();
      fire({ correlationId: 'corr-4', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.response.referencedBy).toHaveLength(2);
      expect(mockGetResource).toHaveBeenCalledTimes(1);
    });

    it('uses "Untitled Resource" when source resource is missing', async () => {
      mockReferencedBy.mockResolvedValue([makeAnnotation('anno-1', DOC_A_URI, String(TARGET_RESOURCE_ID), 'orphan ref')]);
      mockGetResource.mockResolvedValue(null);
      const p = resultPromise();
      fire({ correlationId: 'corr-5', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.response.referencedBy[0].resourceName).toBe('Untitled Resource');
    });

    it('handles annotations with string target (no selector)', async () => {
      mockReferencedBy.mockResolvedValue([{
        id: 'anno-1', '@context': 'http://www.w3.org/ns/anno.jsonld', type: 'Annotation',
        motivation: 'linking', target: DOC_A_URI, body: { source: String(TARGET_RESOURCE_ID) },
      }]);
      mockGetResource.mockResolvedValue({ '@id': DOC_A_URI, name: 'Prometheus Bound' });
      const p = resultPromise();
      fire({ correlationId: 'corr-6', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.response.referencedBy[0].resourceName).toBe('Prometheus Bound');
      expect(result.response.referencedBy[0].target.source).toBe(DOC_A_URI);
      expect(result.response.referencedBy[0].target.selector.exact).toBe('');
    });

    it('emits referenced-by-failed on graph error', async () => {
      mockReferencedBy.mockRejectedValue(new Error('Graph unavailable'));
      const p = failedPromise();
      fire({ correlationId: 'corr-7', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.correlationId).toBe('corr-7');
      expect(result.message).toBe('Graph unavailable');
    });

    it('emits referenced-by-failed when getResource throws', async () => {
      mockReferencedBy.mockResolvedValue([makeAnnotation('anno-1', DOC_A_URI, String(TARGET_RESOURCE_ID), 'text')]);
      mockGetResource.mockRejectedValue(new Error('Resource lookup failed'));
      const p = failedPromise();
      fire({ correlationId: 'corr-8', resourceId: TARGET_RESOURCE_ID });
      const result = await p;
      expect(result.correlationId).toBe('corr-8');
      expect(result.message).toBe('Resource lookup failed');
    });
  });
});
