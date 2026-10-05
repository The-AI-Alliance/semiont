/**
 * What `Staging` promises, held against both drivers.
 *
 * Staging is the Archivist's job of recording the tree's changes where a
 * person can commit them. `GitStaging` does it with git; `NoStaging` is a
 * project that does not sync git, which still moves and removes its files.
 * One suite, both drivers: what a store may rely on is what both keep.
 *
 * A knowledge base need not be a git repository: that is `NoStaging`, which
 * runs no git. What is refused is the contradiction — a config that says
 * `[git] sync = true` over a tree git cannot stage into. The git driver will
 * not start there. Should a tree stop being a checkout while it runs, it pays
 * for no check: a move or a remove, which tell git themselves, do their work
 * and report the failure; a stage is queued, so its caller has long since
 * succeeded, and the failed batch is logged as a degradation for the operator.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from '@semiont/core';
import { stagingFor, noStaging, type Staging } from '../staging';
import { gitStaging } from '../git-staging';

interface Driver {
  name: string;
  /** Whether what this driver stages reaches a git index. */
  indexed: boolean;
  open(root: string): Staging;
}

const DRIVERS: Driver[] = [
  {
    name: 'GitStaging',
    indexed: true,
    open(root) {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      return gitStaging(root, { flushMs: 20, maxWaitMs: 100 });
    },
  },
  { name: 'NoStaging', indexed: false, open: () => noStaging },
];

describe.each(DRIVERS)('Staging contract — $name', ({ indexed, open }) => {
  let root: string;
  let staging: Staging;

  const at = (name: string) => join(root, name);
  const write = async (name: string, body = 'x') => {
    await fs.writeFile(at(name), body);
    return at(name);
  };
  const index = (): string[] =>
    execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' }).trim().split('\n').filter(Boolean);

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'semiont-staging-'));
    staging = open(root);
  });
  afterEach(async () => {
    await staging.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is ready', async () => {
    await expect(staging.ready()).resolves.toBeUndefined();
  });

  it('stage returns at once, and a flush leaves the path where a person can commit it', async () => {
    staging.stage(await write('a.txt'));
    await staging.flush();

    if (indexed) expect(index()).toEqual(['a.txt']);
    expect(await fs.readFile(at('a.txt'), 'utf-8')).toBe('x');
  });

  it('move renames the file, and the index follows', async () => {
    staging.stage(await write('from.txt', 'moved'));

    await staging.move(at('from.txt'), at('to.txt'));

    expect(existsSync(at('from.txt'))).toBe(false);
    expect(await fs.readFile(at('to.txt'), 'utf-8')).toBe('moved');
    if (indexed) expect(index()).toEqual(['to.txt']);
  });

  it('remove takes the file off disk, and out of the index', async () => {
    staging.stage(await write('gone.txt'));

    await staging.remove(at('gone.txt'), { keepFile: false });

    expect(existsSync(at('gone.txt'))).toBe(false);
    if (indexed) expect(index()).toEqual([]);
  });

  it('remove with keepFile leaves the file on disk, out of the index', async () => {
    staging.stage(await write('kept.txt', 'still here'));

    await staging.remove(at('kept.txt'), { keepFile: true });

    expect(await fs.readFile(at('kept.txt'), 'utf-8')).toBe('still here');
    if (indexed) expect(index()).toEqual([]);
  });

  // The file operation is the store's critical path: it happens or it throws,
  // whatever version control thinks of the file. Only the staging is
  // best-effort. Asking git to do the file operation breaks this — `git rm`
  // refuses a file that is staged but not yet committed, `git mv` an untracked
  // one — and a driver that swallows staging errors then reports success for a
  // file it never touched.
  it('remove deletes a file no one has committed yet', async () => {
    staging.stage(await write('uncommitted.txt'));
    await staging.flush();

    await staging.remove(at('uncommitted.txt'), { keepFile: false });

    expect(existsSync(at('uncommitted.txt'))).toBe(false);
    if (indexed) expect(index()).toEqual([]);
  });

  it('move and remove work on a file that was never staged', async () => {
    await write('unstaged.txt', 'never staged');

    await staging.move(at('unstaged.txt'), at('unstaged-moved.txt'));
    expect(existsSync(at('unstaged.txt'))).toBe(false);
    expect(await fs.readFile(at('unstaged-moved.txt'), 'utf-8')).toBe('never staged');

    await staging.remove(at('unstaged-moved.txt'), { keepFile: false });
    expect(existsSync(at('unstaged-moved.txt'))).toBe(false);
  });

  it('move of a file that is not there rejects — the rename is not best-effort', async () => {
    await expect(staging.move(at('missing.txt'), at('anywhere.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a failed move leaves the driver usable', async () => {
    await staging.move(at('missing.txt'), at('anywhere.txt')).catch(() => undefined);

    staging.stage(await write('after.txt'));
    await expect(staging.flush()).resolves.toBeUndefined();
    if (indexed) expect(index()).toEqual(['after.txt']);
  });

  it('removing a file that is already absent is not an error', async () => {
    await expect(staging.remove(at('never-was.txt'), { keepFile: false })).resolves.toBeUndefined();
  });

  it('flush and dispose resolve with nothing pending', async () => {
    await expect(staging.flush()).resolves.toBeUndefined();
    await expect(staging.dispose()).resolves.toBeUndefined();
  });

  it('dispose drains what was staged', async () => {
    staging.stage(await write('last.txt'));

    await staging.dispose();

    if (indexed) expect(index()).toEqual(['last.txt']);
  });

  it('staging on its own timer never raises — a failure to stage is degraded, never fatal', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      staging.stage(await write('timed.txt'));
      await new Promise((r) => setTimeout(r, 200));
      await expect(staging.flush()).resolves.toBeUndefined();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  if (indexed) {
    it('currentBranch names the branch the tree is on, read at every ask', async () => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
      git('config', 'user.email', 'test@test.com');
      git('config', 'user.name', 'Test');
      git('commit', '--allow-empty', '-m', 'init');
      git('checkout', '-b', 'first-line');
      expect(await staging.currentBranch()).toBe('first-line');

      git('checkout', '-b', 'second-line');
      expect(await staging.currentBranch()).toBe('second-line');
    });
  } else {
    it('currentBranch is none', async () => {
      expect(await staging.currentBranch()).toBeUndefined();
    });
  }

  if (!indexed) {
    it('never touches version control', async () => {
      staging.stage(await write('a.txt'));
      await staging.move(at('a.txt'), at('b.txt'));
      await staging.remove(at('b.txt'), { keepFile: false });
      await staging.flush();

      expect(existsSync(at('.git'))).toBe(false);
    });
  }
});

describe('GitStaging over a tree it cannot stage into', () => {
  let root: string;
  let staging: Staging;
  const at = (name: string) => join(root, name);
  const NOT_A_CHECKOUT = /\[git\] sync = true.*is not a git checkout/s;
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn(() => logger) };

  beforeEach(async () => {
    vi.mocked(logger.error).mockClear();
    root = await fs.mkdtemp(join(tmpdir(), 'semiont-staging-refused-'));
    staging = gitStaging(root, { flushMs: 20, maxWaitMs: 100, logger });
  });
  afterEach(async () => {
    await staging.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('will not start: ready rejects, naming the tree and the two ways out', async () => {
    const refusal = await staging.ready().then(() => undefined, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toMatch(NOT_A_CHECKOUT);
    expect(message).toContain(root);
    expect(message).toContain('git init');
    expect(message).toContain('sync = false');
  });

  // While running, the driver does not go looking for trouble — a check before
  // each operation would cost a subprocess.
  it('a tree that stops being a checkout while running: a move and a remove do their work, and error', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await staging.ready();
    await fs.writeFile(at('a.txt'), 'kept');
    await fs.rm(at('.git'), { recursive: true, force: true });

    await expect(staging.move(at('a.txt'), at('b.txt'))).rejects.toThrow(NOT_A_CHECKOUT);
    expect(await fs.readFile(at('b.txt'), 'utf-8')).toBe('kept');

    await expect(staging.currentBranch()).rejects.toThrow(NOT_A_CHECKOUT);

    await expect(staging.remove(at('b.txt'), { keepFile: false })).rejects.toThrow(NOT_A_CHECKOUT);
    expect(existsSync(at('b.txt'))).toBe(false);

    await expect(staging.flush()).resolves.toBeUndefined();
    await expect(staging.dispose()).resolves.toBeUndefined();
  });

  it('a queued stage that cannot be staged is a logged degradation — its caller already succeeded', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await staging.ready();
    await fs.rm(at('.git'), { recursive: true, force: true });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await fs.writeFile(at('a.txt'), 'x');
      expect(() => staging.stage(at('a.txt'))).not.toThrow();

      await vi.waitFor(() => expect(logger.error).toHaveBeenCalled(), { timeout: 5_000 });
      const [message, context] = vi.mocked(logger.error).mock.calls[0]!;
      expect(message).toMatch(/degraded/i);
      expect(context).toMatchObject({ root, paths: 1 });
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('keeps trying, and stages again once the checkout is back — no restart', async () => {
    await staging.ready().catch(() => undefined);

    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    await fs.writeFile(at('a.txt'), 'x');
    staging.stage(at('a.txt'));
    await staging.flush();

    expect(execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' }).trim()).toBe('a.txt');
  });

  it('will not start where git cannot be run at all', async () => {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    const path = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(staging.ready()).rejects.toThrow(/\[git\] sync = true/);
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('stagingFor — which driver a project gets', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'semiont-staging-for-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  });
  afterEach(async () => {
    await stagingFor({ root, gitSync: true }).dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('a project that syncs git stages into its index', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'x');
    const staging = stagingFor({ root, gitSync: true });

    staging.stage(join(root, 'a.txt'));
    await staging.flush();

    expect(execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' }).trim()).toBe('a.txt');
  });

  it('a project that does not sync git gets NoStaging, in a git checkout or not', () => {
    expect(stagingFor({ root, gitSync: false })).toBe(noStaging);
  });

  it('a project that does not sync git reports no branch, even in a git checkout — it runs no git', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('config', 'user.email', 'test@test.com');
    git('config', 'user.name', 'Test');
    git('commit', '--allow-empty', '-m', 'init');
    git('checkout', '-b', 'feature-xyz');

    expect(await stagingFor({ root, gitSync: false }).currentBranch()).toBeUndefined();
    expect(await stagingFor({ root, gitSync: true }).currentBranch()).toBe('feature-xyz');
  });

  it('one repository gets ONE driver — the content store and the event log cannot race for the index', () => {
    expect(stagingFor({ root, gitSync: true })).toBe(stagingFor({ root, gitSync: true }));
  });
});
