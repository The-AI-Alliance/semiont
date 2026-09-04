/**
 * ARCHIVIST-STAYS-UP P7 — the append path reports what it spends.
 *
 * `appendEvent` is the Archivist's core operation and the one thing only it
 * can do, and until this it emitted no span and no metric. Reads were covered
 * (`recordHandlerDuration` via `withActorSpan`) and the bus was covered; the
 * WRITE path was dark, which is why "reads serialize behind the detection
 * job's annotation writes" is a symptom recorded in
 * `bugs/absent-archivist-wedges-browse.md` with no mechanism attached.
 *
 * Four stages, timed separately, because the useful question is not "was the
 * append slow" but WHICH PART was slow — persisting the record, materializing
 * the view whose size grows with annotation count, enriching, or publishing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordAppendStage = vi.fn();
vi.mock('@semiont/observability', () => ({
  recordAppendStage: (...args: unknown[]) => recordAppendStage(...args),
  recordGitCommand: vi.fn(),
}));

import { EventBus, resourceId as makeResourceId, userId } from '@semiont/core';
import { SemiontProject } from '@semiont/core/node';
import { EventStore } from '../event-store';
import { FilesystemViewStorage } from '../storage/view-storage';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('append telemetry', () => {
  let testDir: string;
  let project: SemiontProject;
  let bus: EventBus;
  let store: EventStore;

  beforeEach(async () => {
    recordAppendStage.mockClear();
    testDir = join(tmpdir(), `semiont-append-tel-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir, { anchoredTextDir: `${testDir}/anchored-text` });
    bus = new EventBus();
    store = new EventStore(project, testDir, new FilesystemViewStorage(project), bus);
  });

  afterEach(async () => {
    bus.destroy();
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('times every stage of a resource append', async () => {
    await store.appendEvent({
      type: 'yield:created',
      resourceId: makeResourceId('res-telemetry'),
      userId: userId('did:web:example:users:alice'),
      version: 1,
      payload: { name: 'N', format: 'text/plain', contentChecksum: 'h' },
    } as never);

    const stages = recordAppendStage.mock.calls.map((c) => c[0]);
    expect(stages).toContain('persist');
    expect(stages).toContain('materialize');
    expect(stages).toContain('publish');

    // Every call carries a non-negative duration — a stage that reports no
    // number is the same as a stage that reports nothing.
    for (const call of recordAppendStage.mock.calls) {
      expect(typeof call[1]).toBe('number');
      expect(call[1] as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('times a system append too — `__system__` is not a special case', async () => {
    await store.appendEvent({
      type: 'frame:entity-type-added',
      userId: userId('did:web:example:users:alice'),
      version: 1,
      payload: { entityType: 'Person' },
    } as never);

    expect(recordAppendStage.mock.calls.map((c) => c[0])).toContain('persist');
  });
});
