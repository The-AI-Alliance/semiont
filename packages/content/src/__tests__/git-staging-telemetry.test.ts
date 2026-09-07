/**
 * The staging queue still reports what git costs.
 *
 * INHERITED from `event-sourcing`'s `git-telemetry.test.ts`, deleted when
 * GIT-OFF-THE-EVENT-LOOP moved staging here: that suite pinned ARCHIVIST-STAYS-UP
 * P7's guarantee — every git invocation is measured — against a per-package
 * wrapper that no longer exists. The guarantee outlives the wrapper, so it is
 * re-asserted at the one place git now runs.
 *
 * A failing invocation is measured too: git still consumed time and still
 * blocked whatever was waiting on the queue, so it still has a duration worth
 * reporting.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordGitCommand = vi.fn();
vi.mock('@semiont/observability', () => ({
  recordGitCommand: (...args: unknown[]) => recordGitCommand(...args),
}));

import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { createStager } from '../git-staging';

describe('staging telemetry', () => {
  let root: string;

  beforeEach(async () => {
    recordGitCommand.mockClear();
    root = await fs.mkdtemp(join(tmpdir(), 'semiont-stager-tel-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  });

  it('measures a successful invocation, labeled by subcommand', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'x');
    const stager = createStager(root, { flushMs: 5, maxWaitMs: 50 });
    stager.add('a.txt');
    await stager.flush();

    expect(recordGitCommand).toHaveBeenCalledTimes(1);
    const [command, ms] = recordGitCommand.mock.calls[0] as [string, number];
    expect(command).toBe('add');
    expect(ms).toBeGreaterThanOrEqual(0);
    await stager.dispose();
  });

  it('measures a FAILING invocation — it consumed time either way', async () => {
    const stager = createStager(root, { flushMs: 5, maxWaitMs: 50 });
    stager.add('does-not-exist.txt');

    await stager.flush().catch(() => {});
    expect(recordGitCommand).toHaveBeenCalledWith('add', expect.any(Number));
    await stager.dispose().catch(() => {});
  });

  it('one measurement per BATCH, not per path — the dedupe is visible here too', async () => {
    for (const n of ['a', 'b', 'c']) await fs.writeFile(join(root, `${n}.txt`), 'x');
    const stager = createStager(root, { flushMs: 5, maxWaitMs: 50 });
    for (const n of ['a', 'b', 'c']) stager.add(`${n}.txt`);
    await stager.flush();

    expect(recordGitCommand).toHaveBeenCalledTimes(1);
    await stager.dispose();
  });
});
