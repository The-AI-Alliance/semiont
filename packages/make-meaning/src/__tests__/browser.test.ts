/**
 * Browser Actor Tests
 *
 * Tests path validation (traversal guards) and directory listing logic.
 * Filesystem and ViewStorage are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, race, timer, map, take } from 'rxjs';
import { EventBus, resourceId, agentToDid, type Logger } from '@semiont/core';
import { Browser } from '../browser';
import type { MakeMeaningConfig } from '../config';

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

const emptyConfig: MakeMeaningConfig = { services: {} };

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
      emptyConfig,
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
      emptyConfig,
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

    let mockViewGet: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      await browser.stop();
      vi.clearAllMocks();
      mockReferencedBy = vi.fn();
      mockGetResource = vi.fn();
      mockViewGet = vi.fn().mockResolvedValue(null);
      const kb = {
        graph: { getResourceReferencedBy: mockReferencedBy, getResource: mockGetResource },
        views: { get: mockViewGet },
      } as any;
      browser = new Browser(makeViews([]) as any, kb, eventBus, { root: PROJECT_ROOT } as any, emptyConfig, mockLogger);
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

    it('hydrates a graph-lagging citer from the view — never "Untitled Resource" for a known resource', async () => {
      // The read-after-write artifact (graph-read-after-write-coverage.md P1):
      // the edge is woven but the citing resource's node is not yet — the
      // view is the fresher projection and must supply the name.
      const anno = makeAnnotation('anno-lag', DOC_B_URI, String(TARGET_RESOURCE_ID), 'the Titan');
      mockReferencedBy.mockResolvedValue([anno]);
      mockGetResource.mockResolvedValue(null); // graph hasn't woven the citer yet
      mockViewGet.mockImplementation((id: any) =>
        String(id) === DOC_B_URI
          ? Promise.resolve({ resource: { '@id': DOC_B_URI, name: 'Greek Myths' }, annotations: {} })
          : Promise.resolve(null),
      );

      const p = resultPromise();
      fire({ correlationId: 'corr-lag', resourceId: TARGET_RESOURCE_ID });
      const result = await p;

      expect(result.response.referencedBy).toHaveLength(1);
      expect(result.response.referencedBy[0].resourceName).toBe('Greek Myths');
      // L4: degradation is observable, never silent — the breadcrumb is
      // part of the contract, not decoration.
      expect(mockLogger.info).toHaveBeenCalledWith('[graph lag] citer hydrated from view', { resourceId: DOC_B_URI });
    });

    it('a citer neither projection knows still renders the Untitled fallback', async () => {
      const anno = makeAnnotation('anno-ghost', 'doc-ghost', String(TARGET_RESOURCE_ID));
      mockReferencedBy.mockResolvedValue([anno]);
      mockGetResource.mockResolvedValue(null);
      // mockViewGet default: null

      const p = resultPromise();
      fire({ correlationId: 'corr-ghost', resourceId: TARGET_RESOURCE_ID });
      const result = await p;

      expect(result.response.referencedBy[0].resourceName).toBe('Untitled Resource');
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

    it('a throwing citer hydration degrades that entry — the reply still succeeds', async () => {
      // Changed contract (graph-read-after-write-coverage.md P1): one
      // citer's store hiccup must not fail the whole references reply.
      // resourceWithViewGrace absorbs the per-citer read error and falls
      // back to the view (or Untitled when neither projection answers);
      // an EDGE-QUERY failure still fails the request (spec above).
      mockReferencedBy.mockResolvedValue([makeAnnotation('anno-1', DOC_A_URI, String(TARGET_RESOURCE_ID), 'text')]);
      mockGetResource.mockRejectedValue(new Error('Resource lookup failed'));
      mockViewGet.mockImplementation((id: any) =>
        String(id) === DOC_A_URI
          ? Promise.resolve({ resource: { '@id': DOC_A_URI, name: 'Prometheus Bound' }, annotations: {} })
          : Promise.resolve(null),
      );

      const p = resultPromise();
      fire({ correlationId: 'corr-8', resourceId: TARGET_RESOURCE_ID });
      const result = await p;

      expect(result.correlationId).toBe('corr-8');
      expect(result.response.referencedBy).toHaveLength(1);
      expect(result.response.referencedBy[0].resourceName).toBe('Prometheus Bound');
    });
  });

  // ── collaborator directory (COLLABORATOR-DIRECTORY P2) ────────────────────

  describe('agents directory', () => {
    // The KB's canonical identity — the value /api/tokens/agent mints worker
    // DIDs from. The directory must mint the identical DIDs (one value, one
    // owner; .plans/bugs/agent-did-host-skew.md).
    const SITE_DOMAIN = 'kb.example';

    const did = (provider: string, model: string) =>
      agentToDid({ domain: SITE_DOMAIN, provider, model });

    async function withBrowser(
      config: MakeMeaningConfig,
      fn: (bus: EventBus) => Promise<void>,
    ) {
      const bus = new EventBus();
      const b = new Browser(makeViews([]) as any, mockKb, bus, { root: PROJECT_ROOT } as any, config, mockLogger);
      await b.initialize();
      try {
        await fn(bus);
      } finally {
        await b.stop();
        bus.destroy();
      }
    }

    function requestAgents(bus: EventBus) {
      const reply = firstValueFrom(
        race(
          bus.get('browse:agents-result').pipe(map((e) => ({ kind: 'result' as const, e }))),
          bus.get('browse:agents-failed').pipe(map((e) => ({ kind: 'failed' as const, e }))),
          timer(300).pipe(
            map((): never => {
              throw new Error('no browse:agents subscriber answered');
            }),
          ),
        ).pipe(take(1)),
      );
      bus.get('browse:agents-requested').next({ correlationId: 'cid-agents' });
      return reply;
    }

    it('answers the deduplicated software roster: worker-derivation DIDs, resolved capabilities', async () => {
      await withBrowser(
        {
          services: {},
          site: { domain: SITE_DOMAIN },
          workers: {
            default: { type: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'secret-key-do-not-leak' },
            generation: { type: 'anthropic', model: 'claude-sonnet-4-5' },
          },
          // overlaps workers.default — must dedup into one entry
          actors: { matcher: { type: 'anthropic', model: 'claude-haiku-4-5' } },
        },
        async (bus) => {
          const r = await requestAgents(bus);
          if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
          const agents = r.e.response.agents;
          expect(agents).toHaveLength(2);

          const entryFor = (model: string) =>
            agents.find((a) => a.agent['@type'] === 'Software' && a.agent.model === model);

          // workers.default expands to every job type not explicitly assigned
          // elsewhere ('default' is NOT a JobType and must not appear).
          expect(entryFor('claude-haiku-4-5')).toMatchObject({
            agent: {
              '@type': 'Software',
              '@id': did('anthropic', 'claude-haiku-4-5'),
              provider: 'anthropic',
              model: 'claude-haiku-4-5',
            },
            servesJobTypes: [
              'reference-annotation',
              'highlight-annotation',
              'assessment-annotation',
              'comment-annotation',
              'tag-annotation',
            ],
          });
          expect(entryFor('claude-sonnet-4-5')).toMatchObject({
            agent: { '@id': did('anthropic', 'claude-sonnet-4-5') },
            servesJobTypes: ['generation'],
          });

          // credentials never leak into the directory
          expect(JSON.stringify(r.e)).not.toContain('secret-key-do-not-leak');
        },
      );
    });

    it('omits servesJobTypes for an actors-only agent', async () => {
      await withBrowser(
        {
          services: {},
          site: { domain: SITE_DOMAIN },
          actors: { gatherer: { type: 'ollama', model: 'llama3' } },
        },
        async (bus) => {
          const r = await requestAgents(bus);
          if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
          expect(r.e.response.agents).toHaveLength(1);
          const entry = r.e.response.agents[0];
          expect(entry.agent['@id']).toBe(did('ollama', 'llama3'));
          expect(entry).not.toHaveProperty('servesJobTypes');
        },
      );
    });

    it('answers an empty roster when no workers or actors are declared', async () => {
      await withBrowser({ services: {}, site: { domain: SITE_DOMAIN } }, async (bus) => {
        const r = await requestAgents(bus);
        if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
        expect(r.e.response.agents).toEqual([]);
      });
    });

    it('fails naming the missing config key when site.domain is absent', async () => {
      await withBrowser({ services: {} }, async (bus) => {
        const r = await requestAgents(bus);
        if (r.kind !== 'failed') throw new Error('expected failed');
        expect(r.e.correlationId).toBe('cid-agents');
        expect(r.e.message).toContain('site.domain');
      });
    });
  });
});
