/**
 * Browser Actor Tests
 *
 * Tests path validation (traversal guards) and directory listing logic.
 * Filesystem and ViewStorage are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { firstValueFrom, race, timer, map, take } from 'rxjs';
import { EventBus, resourceId, agentToDid, type Logger } from '@semiont/core';
import { Browser } from '../archivist/browser';
import type { Roster } from '../archivist/agent-roster';
import { NO_AGENTS } from './helpers/test-project';


// ── fs mock ───────────────────────────────────────────────────────────────────

vi.mock('fs', () => {
  const stat = vi.fn();
  const readdir = vi.fn();
  return {
    promises: { stat, readdir },
    type: undefined,        // Dirent type import — not a value
  };
});

vi.mock('../archivist/resource-graph', () => ({ assembleResourceGraph: vi.fn() }));

import { promises as fsMock } from 'fs';
import { assembleResourceGraph } from '../archivist/resource-graph';
const mockAssemble = assembleResourceGraph as ReturnType<typeof vi.fn>;
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
          representations: [{ mediaType: 'text/plain', storageUri: v.storageUri }],
          entityTypes:     v.entityTypes ?? [],
          wasAttributedTo: { '@id': 'did:user:test' },
        },
        annotations: { annotations: [] },
      })),
    ),
  };
}

const defaultStat = { size: 1024, mtime: new Date('2026-01-01T00:00:00Z') };

const mockKb = { views: {} } as any;


// ── tests ─────────────────────────────────────────────────────────────────────

describe('Browser actor', () => {
  let eventBus: EventBus;
  let browser: Browser;

  beforeEach(async () => {
    vi.clearAllMocks();
    eventBus = new EventBus();

    browser = new Browser(
      { ...mockKb, views: makeViews([]) },
      eventBus,
      { root: PROJECT_ROOT } as any,
      NO_AGENTS,
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
        const failed$ = eventBus.frames('browse:directory-failed');
        const resultPromise = new Promise<any>((resolve) => failed$.subscribe(resolve));

        eventBus.emit('browse:directory-requested', { path, }, { correlationId: 'cid-1' });

        const frame = await resultPromise;
        expect(frame.correlationId).toBe('cid-1');
        expect(frame.payload.message).toBe('path escapes project root');
      });
    }

    it('allows project root (empty string)', async () => {
      mockReaddir.mockResolvedValue([]);
      const result$ = eventBus.frames('browse:directory-result');
      const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

      eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-2' });

      const frame = await resultPromise;
      expect(frame.correlationId).toBe('cid-2');
      expect(frame.payload.response.entries).toEqual([]);
    });

    it('allows a valid subdirectory', async () => {
      mockReaddir.mockResolvedValue([]);
      const result$ = eventBus.on('browse:directory-result');
      const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

      eventBus.emit('browse:directory-requested', { path: 'docs' }, { correlationId: 'cid-3' });

      const event = await resultPromise;
      expect(event.response.path).toBe('docs');
    });
  });

  // ── missing directory ──────────────────────────────────────────────────────

  it('emits browse:directory-failed when directory does not exist', async () => {
    const err: any = new Error('ENOENT: no such file');
    err.code = 'ENOENT';
    mockReaddir.mockRejectedValue(err);

    const failed$ = eventBus.on('browse:directory-failed');
    const resultPromise = new Promise<any>((resolve) => failed$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: 'missing' }, { correlationId: 'cid-4' });

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

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-5' });

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

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-6' });

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
      { ...mockKb, views: makeViews([{ storageUri: fileUri, resourceId: 'res:abc', entityTypes: ['Article'] }]) },
      eventBus,
      { root: PROJECT_ROOT } as any,
      NO_AGENTS,
      mockLogger,
    );
    await browser.initialize();

    mockReaddir.mockResolvedValue([makeDirent('intro.md', false)]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-7' });

    const { response } = await resultPromise;
    const entry = response.entries[0];
    expect(entry.tracked).toBe(true);
    expect(entry.resourceId).toBe('res:abc');
    expect(entry.entityTypes).toEqual(['Article']);
  });

  it('marks a file as untracked when not in KB', async () => {
    mockReaddir.mockResolvedValue([makeDirent('scratch.md', false)]);
    mockStat.mockResolvedValue(defaultStat);

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-8' });

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

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '' }, { correlationId: 'cid-9' });

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

    const result$ = eventBus.on('browse:directory-result');
    const resultPromise = new Promise<any>((resolve) => result$.subscribe(resolve));

    eventBus.emit('browse:directory-requested', { path: '', sort: 'mtime' }, { correlationId: 'cid-10' });

    const { response } = await resultPromise;
    expect(response.entries[0].name).toBe('new.txt');
  });

  // ── collaborator directory ────────────────────────────────────────────────

  describe('agents directory', () => {
    // The KB's canonical identity — the value /api/tokens/agent mints worker
    // DIDs from. The directory must mint the identical DIDs (one value, one
    // owner).
    const SITE_DOMAIN = 'kb.example';

    const did = (provider: string, model: string) =>
      agentToDid({ domain: SITE_DOMAIN, provider, model });

    // `domain` is what the KB's committed .semiont/config declares — the
    // project's `siteDomain()`, the one source the roster mints from.
    async function withBrowser(
      domain: string | undefined,
      config: Roster,
      fn: (bus: EventBus) => Promise<void>,
    ) {
      const bus = new EventBus();
      const b = new Browser(mockKb, bus, { root: PROJECT_ROOT, siteDomain: () => domain } as any, config, mockLogger);
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
          bus.frames('browse:agents-result').pipe(map((frame) => ({ kind: 'result' as const, e: frame.payload, replyTo: frame.correlationId }))),
          bus.frames('browse:agents-failed').pipe(map((frame) => ({ kind: 'failed' as const, e: frame.payload, replyTo: frame.correlationId }))),
          timer(300).pipe(
            map((): never => {
              throw new Error('no browse:agents subscriber answered');
            }),
          ),
        ).pipe(take(1)),
      );
      bus.emit('browse:agents-requested', {}, { correlationId: 'cid-agents' });
      return reply;
    }

    it('answers the deduplicated software roster: worker-derivation DIDs, each agent with every job type it serves', async () => {
      const haiku = { provider: 'anthropic', model: 'claude-haiku-4-5' } as const;
      await withBrowser(
        SITE_DOMAIN,
        {
          workers: {
            'reference-annotation': haiku,
            'highlight-annotation': haiku,
            'assessment-annotation': haiku,
            'comment-annotation': haiku,
            'tag-annotation': haiku,
            generation: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
          },
          // the same agent as the annotation workers — one entry, not two
          actors: { matcher: haiku },
        },
        async (bus) => {
          const r = await requestAgents(bus);
          if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
          const agents = r.e.response.agents;
          expect(agents).toHaveLength(2);

          const entryFor = (model: string) =>
            agents.find((a) => a.agent['@type'] === 'Software' && a.agent.model === model);

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
        },
      );
    });

    it('omits servesJobTypes for an actors-only agent', async () => {
      await withBrowser(
        SITE_DOMAIN,
        { workers: {}, actors: { gatherer: { provider: 'ollama', model: 'llama3' } } },
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

    it('carries no limits: the services holding the inference credentials report those', async () => {
      await withBrowser(
        SITE_DOMAIN,
        { workers: { generation: { provider: 'anthropic', model: 'claude-haiku-4-5' } }, actors: {} },
        async (bus) => {
          const r = await requestAgents(bus);
          if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
          expect(r.e.response.agents).toHaveLength(1);
          expect(r.e.response.agents[0]).not.toHaveProperty('limits');
        },
      );
    });

    it('answers an empty roster when no role is served', async () => {
      await withBrowser(SITE_DOMAIN, NO_AGENTS, async (bus) => {
        const r = await requestAgents(bus);
        if (r.kind !== 'result') throw new Error(`expected result, got failed: ${r.e.message}`);
        expect(r.e.response.agents).toEqual([]);
      });
    });

    it('fails naming the missing [site] domain when the committed config declares none', async () => {
      await withBrowser(undefined, NO_AGENTS, async (bus) => {
        const r = await requestAgents(bus);
        if (r.kind !== 'failed') throw new Error('expected failed');
        expect(r.replyTo).toBe('cid-agents');
        expect(r.e.message).toContain('[site] domain');
      });
    });
  });
  // ── the resource read, and what its absence is allowed to claim ────────────

  describe('browse:resource-requested', () => {
    function failure() {
      return new Promise<any>((resolve) => eventBus.frames('browse:resource-failed').subscribe(resolve));
    }

    it("codes a missing resource 'not-found' — the verdict a tab can be deleted on", async () => {
      // `assembleResourceGraph` materializes from the EVENT STORE, so null is
      // the system of record saying this KB has no such resource — not a view
      // lagging. That is what earns a code:
      // the SDK's tab validator removes on this and only this.
      mockAssemble.mockResolvedValue(null);
      const failed = failure();

      eventBus.emit('browse:resource-requested', { resourceId: resourceId('res-gone') }, { correlationId: 'cid-missing' });

      const frame = await failed;
      expect(frame.correlationId).toBe('cid-missing');
      expect(frame.payload.code).toBe('not-found');
    });

    it('leaves a thrown failure code-less — an exception is not evidence of absence', async () => {
      // The generic catch must never carry the code: a bug in assembly would
      // otherwise read as "this resource does not exist" and delete the tab.
      mockAssemble.mockRejectedValue(new Error('graph exploded'));
      const failed = failure();

      eventBus.emit('browse:resource-requested', { resourceId: resourceId('res-here') }, { correlationId: 'cid-boom' });

      const frame = await failed;
      expect(frame.payload.message).toBe('graph exploded');
      expect(frame.payload.code).toBeUndefined();
    });
  });
});
