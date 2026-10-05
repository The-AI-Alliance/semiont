/**
 * browse:kb — the knowledge base describes itself. The Archivist answers from
 * the committed `.semiont/config` and the working tree it holds, and reads
 * both when asked: a `git checkout` restarts nothing and emits nothing, so an
 * answer kept from an earlier ask would name a branch the tree has left.
 *
 * The branch is reported only by a knowledge base that syncs git. One that
 * does not runs no git at all, whether or not its tree is a checkout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { firstValueFrom, race, timer, map, take } from 'rxjs';
import { EventBus, type Logger } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { Browser, type BrowserReads } from '../archivist/browser';
import { createTestProject, type TestProject } from './helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const READS: BrowserReads = {
  views: { get: vi.fn(), getAll: vi.fn(), exists: vi.fn() },
  eventStore: {
    log: { storage: { getAllEvents: vi.fn(), getEventFiles: vi.fn(), getLastEvent: vi.fn() } },
    views: { materializer: { materialize: vi.fn() } },
  },
  content: { retrieve: vi.fn() },
  anchoredText: { read: vi.fn() },
  smeltProgress: { whenSettled: vi.fn() },
};

const DOMAIN = 'example.github.io:arxiv-kb';

describe('browse:kb — the knowledge base describes itself', () => {
  let tp: TestProject;
  let bus: EventBus;
  let browser: Browser;

  const browserFor = async (project: SemiontProject) => {
    browser = new Browser(READS, bus, project, {}, mockLogger);
    await browser.initialize();
  };

  beforeEach(async () => {
    tp = await createTestProject('arxiv-kb');
    bus = new EventBus();
    await browserFor(tp.project);
  });

  /** The same knowledge base, re-read after its committed config declares `[git] sync = true`. */
  const syncGit = async () => {
    await browser.stop();
    await fs.appendFile(join(tp.project.root, '.semiont', 'config'), '[git]\nsync = true\n');
    await browserFor(new SemiontProject(tp.project.root, { anchoredTextDir: tp.project.anchoredTextDir }));
  };

  const checkOut = (branch: string) => {
    git('init');
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-m', 'init');
    git('checkout', '-b', branch);
  };

  afterEach(async () => {
    await browser.stop();
    bus.destroy();
    await tp.teardown();
  });

  const declareDomain = () =>
    fs.appendFile(join(tp.project.root, '.semiont', 'config'), `[site]\ndomain = "${DOMAIN}"\n`);

  const git = (...args: string[]) => execFileSync('git', ['-C', tp.project.root, ...args], { stdio: 'ignore' });

  function ask() {
    const reply = firstValueFrom(
      race(
        bus.frames('browse:kb-result').pipe(map((frame) => ({ kind: 'result' as const, payload: frame.payload, replyTo: frame.correlationId }))),
        bus.frames('browse:kb-failed').pipe(map((frame) => ({ kind: 'failed' as const, payload: frame.payload, replyTo: frame.correlationId }))),
        timer(300).pipe(map((): never => { throw new Error('no browse:kb subscriber answered'); })),
      ).pipe(take(1)),
    );
    bus.emit('browse:kb-requested', {}, { correlationId: 'cid-kb' });
    return reply;
  }

  it('answers the committed name and domain, and no branch outside a git checkout', async () => {
    await declareDomain();

    expect(await ask()).toEqual({
      kind: 'result',
      payload: { response: { name: 'arxiv-kb', domain: DOMAIN } },
      replyTo: 'cid-kb',
    });
  });

  it('answers the branch the tree is on when asked, not when first asked', async () => {
    await declareDomain();
    await syncGit();
    checkOut('feature-xyz');

    expect(await ask()).toMatchObject({ kind: 'result', payload: { response: { gitBranch: 'feature-xyz' } } });

    git('checkout', '-b', 'second-line');

    expect(await ask()).toMatchObject({ kind: 'result', payload: { response: { gitBranch: 'second-line' } } });
  });

  it('a knowledge base that does not sync git answers no branch, even in a git checkout', async () => {
    await declareDomain();
    checkOut('feature-xyz');

    expect(await ask()).toEqual({
      kind: 'result',
      payload: { response: { name: 'arxiv-kb', domain: DOMAIN } },
      replyTo: 'cid-kb',
    });
  });

  it('a knowledge base whose config syncs git over a tree that is not a checkout fails the ask', async () => {
    // The Archivist refuses this at boot. Should a tree stop being a checkout
    // while it runs, the ask errors rather than answering as if no branch were
    // the truth.
    await declareDomain();
    await syncGit();

    const reply = await ask();
    expect(reply).toMatchObject({ kind: 'failed', replyTo: 'cid-kb' });
    expect(reply.payload).toMatchObject({ message: expect.stringMatching(/is not a git checkout/) });
  });

  it('refuses when the committed file declares no domain, rather than answering without one', async () => {
    expect(await ask()).toMatchObject({ kind: 'failed', replyTo: 'cid-kb' });
  });
});
