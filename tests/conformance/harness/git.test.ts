/**
 * git run by hand in a knowledge base whose index the Archivist stages into:
 * a command waits out the lock the Archivist holds while it stages, and fails
 * at once for anything else.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitByHand } from './git';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conformance-git-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** The subject of each branch's last commit: none before the first commit. */
const branchTips = (): string[] =>
  execFileSync('git', ['for-each-ref', '--format=%(contents:subject)', 'refs/heads/'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line !== '');

describe('git run by hand', () => {
  it('runs once the lock on the index is gone, and not before', async () => {
    const lock = join(root, '.git', 'index.lock');
    writeFileSync(lock, '');
    let done = false;
    const run = gitByHand(root, 'commit', '--quiet', '--allow-empty', '-m', 'once unlocked').then(() => {
      done = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(branchTips()).toEqual([]);

    rmSync(lock);
    await run;
    expect(branchTips()).toEqual(['once unlocked']);
  });

  it('fails at once, with what git said, for anything but a locked index', async () => {
    await expect(gitByHand(root, 'checkout', '--quiet', 'no-such-branch')).rejects.toThrow(/pathspec 'no-such-branch' did not match/);
  });
});
