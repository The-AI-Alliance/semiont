/**
 * Staging runs off the event loop, and once per path rather than once per
 * change.
 *
 * The index is there for a **human**: the Archivist stages, operators commit
 * and branch by hand. That makes the requirement "current within seconds
 * whenever someone looks", not "current synchronously after every append".
 * Staging synchronously would spawn a blocking `git add` on the same file for
 * every appended event: a detection job writing 1,400 annotations to one
 * resource would spawn 1,400 subprocesses that stage one path.
 *
 * So the queue does two things, and the second matters more than the first:
 * it moves git OFF the loop, and it DEDUPES by path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { gitStaging } from '../git-staging';

let root: string;
const staged = (): string[] =>
  execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);

const write = async (name: string, body = 'x') => {
  await fs.writeFile(join(root, name), body);
  return name;
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'semiont-staging-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('git staging queue', () => {
  it('does not stage synchronously — the caller is not blocked on git', async () => {
    const staging = gitStaging(root, { flushMs: 50, maxWaitMs: 500 });
    staging.stage(await write('a.txt'));

    // Enqueueing returns before git has run.
    expect(staged()).toEqual([]);

    await staging.flush();
    expect(staged()).toEqual(['a.txt']);
    await staging.dispose();
  });

  it('DEDUPES by path — 1,400 appends to one file stage it once', async () => {
    const staging = gitStaging(root, { flushMs: 50, maxWaitMs: 500 });
    await write('events.jsonl');
    for (let i = 0; i < 1400; i++) staging.stage('events.jsonl');

    expect(staging.pending()).toBe(1);
    await staging.flush();
    expect(staged()).toEqual(['events.jsonl']);
    await staging.dispose();
  });

  it('batches distinct paths into one invocation', async () => {
    const staging = gitStaging(root, { flushMs: 50, maxWaitMs: 500 });
    for (const n of ['a.txt', 'b.txt', 'c.txt']) staging.stage(await write(n));

    expect(staging.pending()).toBe(3);
    await staging.flush();
    expect(staged().sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    await staging.dispose();
  });

  it('flushes on its own once idle — a human who never calls flush still sees the index', async () => {
    const staging = gitStaging(root, { flushMs: 20, maxWaitMs: 500 });
    staging.stage(await write('idle.txt'));

    await new Promise((r) => setTimeout(r, 120));
    expect(staged()).toEqual(['idle.txt']);
    await staging.dispose();
  });

  it('bounds staleness — a continuous stream cannot defer staging forever', async () => {
    // Pure debounce would let each new add reset the timer and never stage.
    const staging = gitStaging(root, { flushMs: 1_000, maxWaitMs: 60 });
    staging.stage(await write('first.txt'));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 20));
      staging.stage(await write(`n${i}.txt`));
    }

    await new Promise((r) => setTimeout(r, 80));
    expect(staged()).toContain('first.txt');
    await staging.dispose();
  });

  it('order-sensitive commands flush pending adds first, then run alone', async () => {
    const staging = gitStaging(root, { flushMs: 1_000, maxWaitMs: 5_000 });
    staging.stage(await write('from.txt'));

    // `mv` must not overtake the `add` of the file it moves.
    await staging.move('from.txt', 'to.txt');

    expect(staged()).toEqual(['to.txt']);
    await staging.dispose();
  });

  it('dispose drains — a stopped Archivist leaves nothing unstaged', async () => {
    const staging = gitStaging(root, { flushMs: 10_000, maxWaitMs: 10_000 });
    staging.stage(await write('last.txt'));

    await staging.dispose();
    expect(staged()).toEqual(['last.txt']);
  });
});

/**
 * A lost `index.lock` race must not be fatal, must not lose work, and must not
 * happen to ourselves.
 *
 * Two stagers on one repo (content + event log) would race for the lock, and
 * a `git add` rejection on the debounced timer path has no handler: Node
 * kills the process, and every request in flight dies with it and reads to
 * its caller as a hang.
 */
describe('index.lock contention', () => {
  const lockPath = () => join(root, '.git', 'index.lock');

  it('a `git add` that loses the index.lock race is not an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      await fs.writeFile(lockPath(), '');
      const staging = gitStaging(root, { flushMs: 10, maxWaitMs: 20 });
      staging.stage(await write('doomed.txt'));
      // Long enough for the debounce to fire and git to fail.
      await new Promise((r) => setTimeout(r, 400));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      await fs.rm(lockPath(), { force: true });
    }
  });

  it('a batch that lost the race is retried, not dropped', async () => {
    await fs.writeFile(lockPath(), '');
    const staging = gitStaging(root, { flushMs: 10, maxWaitMs: 20 });
    staging.stage(await write('survivor.txt'));
    // First attempt fails against the held lock.
    await new Promise((r) => setTimeout(r, 120));
    // The external holder (a person, or another tool) finishes.
    await fs.rm(lockPath(), { force: true });
    await staging.flush();
    // `drain()` clears `queued` BEFORE running git, so a merely-caught
    // rejection would drop this path forever and leave the index stale.
    expect(staged()).toContain('survivor.txt');
  });

  it('a PERMANENT staging failure degrades — it never rejects, so it can never be fatal', async () => {
    const staging = gitStaging(root, { flushMs: 5, maxWaitMs: 20 });
    staging.stage('never-existed.txt'); // pathspec matches nothing: git fails, always
    // Staging the index is a convenience; the event log is the record. A
    // failure here is degraded service, and MUST NOT reach a caller as a
    // rejection — one missing `.catch` anywhere would be fatal.
    await expect(staging.flush()).resolves.toBeUndefined();
    await expect(staging.dispose()).resolves.toBeUndefined();
  });

  it('one repo gets ONE staging — callers cannot race each other', () => {
    // The content store and the event log each ask for one; two instances
    // would each serialize internally and neither against the other.
    expect(gitStaging(root)).toBe(gitStaging(root));
  });
});
