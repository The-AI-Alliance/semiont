/**
 * The staging queue reports what git costs.
 *
 * The write path's guarantee — every git invocation is measured — asserted
 * at the one place git runs.
 *
 * A failing invocation is measured too: git still consumed time and still
 * blocked whatever was waiting on the queue, so it still has a duration worth
 * reporting. It is counted as a staging failure as well, under its reason.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordGitCommand = vi.fn();
const recordGitStagingFailure = vi.fn();
vi.mock('@semiont/observability', () => ({
  recordGitCommand: (...args: unknown[]) => recordGitCommand(...args),
  recordGitStagingFailure: (...args: unknown[]) => recordGitStagingFailure(...args),
}));

import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { gitStaging } from '../git-staging';

describe('staging telemetry', () => {
  let root: string;

  beforeEach(async () => {
    recordGitCommand.mockClear();
    recordGitStagingFailure.mockClear();
    root = await fs.mkdtemp(join(tmpdir(), 'semiont-staging-tel-'));
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  });

  it('measures a successful invocation, labeled by subcommand', async () => {
    await fs.writeFile(join(root, 'a.txt'), 'x');
    const staging = gitStaging(root, { flushMs: 5, maxWaitMs: 50 });
    staging.stage('a.txt');
    await staging.flush();

    expect(recordGitCommand).toHaveBeenCalledTimes(1);
    const [command, ms] = recordGitCommand.mock.calls[0] as [string, number];
    expect(command).toBe('add');
    expect(ms).toBeGreaterThanOrEqual(0);
    await staging.dispose();
  });

  it('measures a FAILING invocation, and counts it as a staging failure by reason', async () => {
    const staging = gitStaging(root, { flushMs: 5, maxWaitMs: 50 });
    staging.stage('does-not-exist.txt'); // pathspec matches nothing: git fails, always

    // The flush resolves: a failed stage is degraded service, reported through
    // the failure counter rather than to the caller.
    await staging.flush();

    expect(recordGitCommand).toHaveBeenCalledTimes(1);
    expect(recordGitCommand).toHaveBeenCalledWith('add', expect.any(Number));
    expect(recordGitStagingFailure).toHaveBeenCalledTimes(1);
    expect(recordGitStagingFailure).toHaveBeenCalledWith('other');
    await staging.dispose();
  });

  it('one measurement per BATCH, not per path — the dedupe is visible here too', async () => {
    for (const n of ['a', 'b', 'c']) await fs.writeFile(join(root, `${n}.txt`), 'x');
    const staging = gitStaging(root, { flushMs: 5, maxWaitMs: 50 });
    for (const n of ['a', 'b', 'c']) staging.stage(`${n}.txt`);
    await staging.flush();

    expect(recordGitCommand).toHaveBeenCalledTimes(1);
    await staging.dispose();
  });
});
