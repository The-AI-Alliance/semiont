/**
 * GIT-OFF-THE-EVENT-LOOP — staging stops running on the event loop, and stops
 * running once per change.
 *
 * The index is there for a **human**: the Archivist stages, operators commit
 * and branch by hand. That makes the requirement "current within seconds
 * whenever someone looks", not "current synchronously after every append" —
 * and the gap between those two readings is the whole defect. Today every
 * appended event spawns a blocking `git add` on the same file; a detection job
 * writing 1,400 annotations to one resource spawns 1,400 subprocesses that
 * stage one path.
 *
 * So the queue does two things, and the second matters more than the first:
 * it moves git OFF the loop, and it DEDUPES by path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStager } from '../git-staging';

let root: string;
const staged = (): string[] =>
  execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' })
    .trim().split('\n').filter(Boolean);

const write = async (name: string, body = 'x') => {
  await fs.writeFile(join(root, name), body);
  return name;
};

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'semiont-stager-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('git staging queue', () => {
  it('does not stage synchronously — the caller is not blocked on git', async () => {
    const stager = createStager(root, { flushMs: 50, maxWaitMs: 500 });
    stager.add(await write('a.txt'));

    // The defect stated as a property: enqueueing returns before git has run.
    expect(staged()).toEqual([]);

    await stager.flush();
    expect(staged()).toEqual(['a.txt']);
    await stager.dispose();
  });

  it('DEDUPES by path — 1,400 appends to one file stage it once', async () => {
    const stager = createStager(root, { flushMs: 50, maxWaitMs: 500 });
    await write('events.jsonl');
    for (let i = 0; i < 1400; i++) stager.add('events.jsonl');

    expect(stager.pending()).toBe(1);
    await stager.flush();
    expect(staged()).toEqual(['events.jsonl']);
    await stager.dispose();
  });

  it('batches distinct paths into one invocation', async () => {
    const stager = createStager(root, { flushMs: 50, maxWaitMs: 500 });
    for (const n of ['a.txt', 'b.txt', 'c.txt']) stager.add(await write(n));

    expect(stager.pending()).toBe(3);
    await stager.flush();
    expect(staged().sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    await stager.dispose();
  });

  it('flushes on its own once idle — a human who never calls flush still sees the index', async () => {
    const stager = createStager(root, { flushMs: 20, maxWaitMs: 500 });
    stager.add(await write('idle.txt'));

    await new Promise((r) => setTimeout(r, 120));
    expect(staged()).toEqual(['idle.txt']);
    await stager.dispose();
  });

  it('bounds staleness — a continuous stream cannot defer staging forever', async () => {
    // Pure debounce would let each new add reset the timer and never stage.
    const stager = createStager(root, { flushMs: 1_000, maxWaitMs: 60 });
    stager.add(await write('first.txt'));
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 20));
      stager.add(await write(`n${i}.txt`));
    }

    await new Promise((r) => setTimeout(r, 80));
    expect(staged()).toContain('first.txt');
    await stager.dispose();
  });

  it('order-sensitive commands flush pending adds first, then run alone', async () => {
    const stager = createStager(root, { flushMs: 1_000, maxWaitMs: 5_000 });
    stager.add(await write('from.txt'));

    // `mv` must not overtake the `add` of the file it moves.
    await stager.run(['mv', 'from.txt', 'to.txt']);

    expect(staged()).toEqual(['to.txt']);
    await stager.dispose();
  });

  it('dispose drains — a stopped Archivist leaves nothing unstaged', async () => {
    const stager = createStager(root, { flushMs: 10_000, maxWaitMs: 10_000 });
    stager.add(await write('last.txt'));

    await stager.dispose();
    expect(staged()).toEqual(['last.txt']);
  });
});
