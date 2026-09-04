/**
 * ARCHIVIST-STAYS-UP P7 — the synchronous git calls on the append path report
 * what they cost.
 *
 * When `gitSync` is on, every appended event runs `git add` through
 * `execFileSync`, which blocks the event loop. That duration is not latency ON
 * the append — it is time this process can serve nothing else, and the
 * Archivist is the sole subscriber to every `browse:*` channel while it is
 * blocked. Measuring it is the whole point of the wrapper, so these tests pin
 * that every call site is measured, including one that throws: a git failure
 * still consumed the loop, so it still has a duration worth reporting.
 *
 * Why this file exists separately: `gitSync` is FALSE in every other suite,
 * because it is read from `[git] sync = true` in `.semiont/config` and the
 * temp-dir projects those suites build have no such file. The wrapper was
 * therefore unexecuted by the whole package until this file enabled it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordGitCommand = vi.fn();
const execFileSyncMock = vi.fn();

vi.mock('@semiont/observability', () => ({
  recordGitCommand: (...args: unknown[]) => recordGitCommand(...args),
  recordAppendStage: vi.fn(),
}));

// Mocked so the suite needs no real repository and can drive the failure
// path. The wrapper is what is under test here, not git.
vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { EventStorage } from '../../storage/event-storage';
import { resourceId, userId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

/** `.semiont/config` must exist before the project is constructed — gitSync is read there. */
async function makeProject(testDir: string, gitSync: boolean): Promise<SemiontProject> {
  await fs.mkdir(join(testDir, '.semiont'), { recursive: true });
  await fs.writeFile(
    join(testDir, '.semiont', 'config'),
    `[git]\nsync = ${gitSync}\n`,
    'utf-8',
  );
  return new SemiontProject(testDir, { anchoredTextDir: join(testDir, 'anchored-text') });
}

function appendOne(storage: EventStorage, rid: string) {
  return storage.appendEvent(
    {
      type: 'yield:created',
      resourceId: resourceId(rid),
      userId: userId('did:web:example:users:alice'),
      version: 1,
      payload: { name: 'N', format: 'text/plain', contentChecksum: 'h' },
    } as never,
    resourceId(rid),
  );
}

describe('git telemetry', () => {
  let testDir: string;

  beforeEach(async () => {
    recordGitCommand.mockClear();
    execFileSyncMock.mockReset();
    testDir = join(tmpdir(), `semiont-git-tel-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('with gitSync on', () => {
    it('measures both staging calls a first append makes', async () => {
      const project = await makeProject(testDir, true);
      expect(project.gitSync).toBe(true);
      const storage = new EventStorage(project, { numShards: 256 });

      await appendOne(storage, 'doc-git-1');

      // Two distinct call sites: the event-stream directory (created by
      // initializeResourceStream) and the JSONL file (written by writeEvent).
      expect(recordGitCommand).toHaveBeenCalledTimes(2);
      expect(recordGitCommand.mock.calls.every((c) => c[0] === 'add')).toBe(true);

      const stagedPaths = execFileSyncMock.mock.calls.map((c) => (c[1] as string[])[1]);
      const docPath = storage.getResourcePath(resourceId('doc-git-1'));
      expect(stagedPaths).toContain(docPath);
      expect(stagedPaths).toContain(join(docPath, 'events-000001.jsonl'));
    });

    it('reports a non-negative duration for every call', async () => {
      const project = await makeProject(testDir, true);
      const storage = new EventStorage(project, { numShards: 256 });

      await appendOne(storage, 'doc-git-2');

      for (const call of recordGitCommand.mock.calls) {
        expect(typeof call[1]).toBe('number');
        expect(call[1] as number).toBeGreaterThanOrEqual(0);
      }
    });

    it('measures a FAILING git call too — the loop was blocked either way', async () => {
      const project = await makeProject(testDir, true);
      const storage = new EventStorage(project, { numShards: 256 });
      execFileSyncMock.mockImplementation(() => {
        throw new Error('fatal: not a git repository');
      });

      // The failure propagates — this test pins the measurement, not a swallow.
      await expect(appendOne(storage, 'doc-git-3')).rejects.toThrow(/not a git repository/);

      expect(recordGitCommand).toHaveBeenCalledTimes(1);
      expect(recordGitCommand.mock.calls[0]![0]).toBe('add');
      expect(typeof recordGitCommand.mock.calls[0]![1]).toBe('number');
    });
  });

  describe('with gitSync off', () => {
    it('runs no git command and records nothing', async () => {
      const project = await makeProject(testDir, false);
      expect(project.gitSync).toBe(false);
      const storage = new EventStorage(project, { numShards: 256 });

      await appendOne(storage, 'doc-git-4');

      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(recordGitCommand).not.toHaveBeenCalled();
    });
  });
});
