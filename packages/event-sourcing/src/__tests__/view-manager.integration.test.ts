/**
 * ViewManager Integration Tests
 *
 * These tests exercise ViewManager against a real FilesystemViewStorage
 * backed by a tmpdir, so the async gap between `get` and `save` is wide
 * enough to reveal concurrency bugs that unit tests with mocked storage
 * can't exhibit.
 *
 * Why this file exists
 * --------------------
 * The unit tests in `view-manager.test.ts` use a mocked ViewStorage whose
 * `get` and `save` resolve synchronously (in the same microtask). That's
 * fast and appropriate for testing the wrapper's logic in isolation, but
 * it collapses the read-modify-write window where disk-level races live.
 *
 * A real FilesystemViewStorage does:
 *   get() → fs.readFile → JSON.parse    (multiple ticks, disk I/O)
 *   save() → fs.mkdir → fs.writeFile    (multiple ticks, disk I/O)
 *
 * The gap between `get` returning and `save` completing is wide enough for
 * concurrent handlers to interleave their reads and writes and clobber
 * each other. These tests simulate the canonical production burst — the
 * reference-detection worker emitting `mark:added` + `job:progress` +
 * `job:completed` for one resource within a few milliseconds — and assert
 * that all events actually land in the final view.
 *
 * Any future refactor that breaks per-resource serialization will fail
 * these tests, even if the unit-level `view-manager.test.ts` still passes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ViewManager } from '../view-manager';
import { FilesystemViewStorage } from '../storage/view-storage';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, type PersistedEvent, type StoredEvent, type ResourceId } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('ViewManager — integration (real FilesystemViewStorage)', () => {
  let testDir: string;
  let project: SemiontProject;
  let viewStorage: FilesystemViewStorage;
  let manager: ViewManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-vm-int-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir);
    viewStorage = new FilesystemViewStorage(project);
    manager = new ViewManager(viewStorage, { basePath: project.stateDir });
  });

  afterEach(async () => {
    await project.destroy();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ── Event factories ────────────────────────────────────────────────────

  function createdEvent(rid: ResourceId): PersistedEvent {
    return {
      id: `event-created-${uuidv4()}`,
      type: 'yield:created',
      timestamp: new Date().toISOString(),
      userId: userId('user1'),
      resourceId: rid,
      version: 1,
      payload: {
        name: 'Test Resource',
        format: 'text/plain',
        contentChecksum: 'cs-init',
        creationMethod: 'api',
      },
    } as PersistedEvent;
  }

  function markAddedEvent(rid: ResourceId, annotationIndex: number): PersistedEvent {
    return {
      id: `event-mark-${annotationIndex}-${uuidv4()}`,
      type: 'mark:added',
      timestamp: new Date().toISOString(),
      userId: userId('user1'),
      resourceId: rid,
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          type: 'Annotation',
          id: `ann-${annotationIndex}`,
          motivation: 'highlighting',
          target: {
            source: String(rid),
            selector: {
              type: 'TextQuoteSelector',
              exact: `chunk ${annotationIndex}`,
            },
          },
          body: [],
          created: new Date().toISOString(),
        },
      },
    } as PersistedEvent;
  }

  function jobProgressEvent(rid: ResourceId, percentage: number): PersistedEvent {
    return {
      id: `event-job-progress-${percentage}-${uuidv4()}`,
      type: 'job:progress',
      timestamp: new Date().toISOString(),
      userId: userId('user1'),
      resourceId: rid,
      version: 1,
      payload: {
        jobId: 'job-test',
        jobType: 'reference-annotation',
        percentage,
      },
    } as PersistedEvent;
  }

  function jobCompletedEvent(rid: ResourceId): PersistedEvent {
    return {
      id: `event-job-completed-${uuidv4()}`,
      type: 'job:completed',
      timestamp: new Date().toISOString(),
      userId: userId('user1'),
      resourceId: rid,
      version: 1,
      payload: {
        jobId: 'job-test',
        jobType: 'reference-annotation',
        result: { totalFound: 1, totalEmitted: 1, errors: 0 },
      },
    } as PersistedEvent;
  }

  // Helper: wrap a PersistedEvent as the StoredEvent shape getAllEvents returns
  function stored(event: PersistedEvent, seq: number): StoredEvent {
    return {
      ...event,
      metadata: { sequenceNumber: seq, streamPosition: seq - 1 },
    } as StoredEvent;
  }

  // ── Concurrency tests ──────────────────────────────────────────────────

  it('10 concurrent mark:added events all land in the view', async () => {
    const rid = resourceId('doc-concurrent');

    // Seed the view with a yield:created so the incremental path is taken
    const created = createdEvent(rid);
    await manager.materializeResource(rid, created, async () => [stored(created, 1)]);

    // Fire 10 concurrent mark:added events
    const marks = Array.from({ length: 10 }, (_, i) => markAddedEvent(rid, i));
    const history: StoredEvent[] = [stored(created, 1)];

    await Promise.all(
      marks.map((m, i) => {
        history.push(stored(m, i + 2));
        // getAllEvents returns the full history at call time — the incremental
        // path won't typically use it, but it's what materializeIncremental
        // needs if it decides to rebuild.
        return manager.materializeResource(rid, m, async () => [...history]);
      }),
    );

    // Read back via storage — every annotation must be present
    const view = await viewStorage.get(rid);
    expect(view).not.toBeNull();
    expect(view!.annotations.annotations.length).toBe(10);

    // All unique annotation ids
    const ids = new Set(view!.annotations.annotations.map((a) => a.id));
    expect(ids.size).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(ids.has(`ann-${i}`)).toBe(true);
    }
  });

  it('simulates the reference-detection worker burst without losing events', async () => {
    // The exact pattern that triggered the bug in production:
    //   mark:added + job:progress + job:completed fired within ~5ms of each
    //   other for the same resource. Pre-fix, the non-annotation events
    //   would clobber the mark:added write and the annotation would disappear.
    const rid = resourceId('doc-burst');

    const created = createdEvent(rid);
    await manager.materializeResource(rid, created, async () => [stored(created, 1)]);

    const mark = markAddedEvent(rid, 0);
    const progress = jobProgressEvent(rid, 100);
    const complete = jobCompletedEvent(rid);

    const history: StoredEvent[] = [
      stored(created, 1),
      stored(mark, 2),
      stored(progress, 3),
      stored(complete, 4),
    ];

    // Fire all three at once — this is the race window
    await Promise.all([
      manager.materializeResource(rid, mark, async () => history),
      manager.materializeResource(rid, progress, async () => history),
      manager.materializeResource(rid, complete, async () => history),
    ]);

    const view = await viewStorage.get(rid);
    expect(view).not.toBeNull();
    expect(view!.annotations.annotations.length).toBe(1);
    expect(view!.annotations.annotations[0]!.id).toBe('ann-0');
  });

  it('concurrent events on different resources do not serialize', async () => {
    const rid1 = resourceId('doc-a');
    const rid2 = resourceId('doc-b');

    const created1 = createdEvent(rid1);
    const created2 = createdEvent(rid2);
    await Promise.all([
      manager.materializeResource(rid1, created1, async () => [stored(created1, 1)]),
      manager.materializeResource(rid2, created2, async () => [stored(created2, 1)]),
    ]);

    // Fire 5 concurrent mark:added events on each resource, interleaved
    const marks1 = Array.from({ length: 5 }, (_, i) => markAddedEvent(rid1, i));
    const marks2 = Array.from({ length: 5 }, (_, i) => markAddedEvent(rid2, i));

    const hist1: StoredEvent[] = [stored(created1, 1)];
    const hist2: StoredEvent[] = [stored(created2, 1)];

    const all: Promise<void>[] = [];
    marks1.forEach((m, i) => {
      hist1.push(stored(m, i + 2));
      all.push(manager.materializeResource(rid1, m, async () => [...hist1]));
    });
    marks2.forEach((m, i) => {
      hist2.push(stored(m, i + 2));
      all.push(manager.materializeResource(rid2, m, async () => [...hist2]));
    });

    await Promise.all(all);

    const view1 = await viewStorage.get(rid1);
    const view2 = await viewStorage.get(rid2);
    expect(view1!.annotations.annotations.length).toBe(5);
    expect(view2!.annotations.annotations.length).toBe(5);
  });

  it('the view file on disk is always valid JSON during concurrent writes', async () => {
    // A weaker version of the race test: even if annotation counts were
    // somehow correct, a corrupted view file (half-written, unparseable)
    // would still break the rebuild path. Fire many concurrent events and
    // assert the file parses cleanly afterwards.
    const rid = resourceId('doc-valid-json');

    const created = createdEvent(rid);
    await manager.materializeResource(rid, created, async () => [stored(created, 1)]);

    const events = Array.from({ length: 20 }, (_, i) => markAddedEvent(rid, i));
    const history: StoredEvent[] = [stored(created, 1)];

    await Promise.all(
      events.map((e, i) => {
        history.push(stored(e, i + 2));
        return manager.materializeResource(rid, e, async () => [...history]);
      }),
    );

    // Read the raw bytes from disk and assert JSON.parse succeeds
    // FilesystemViewStorage places view JSON under {stateDir}/resources/{ab}/{cd}/{id}.json
    // but the safest check is via the public get() API — if that returns a
    // well-formed ResourceView, we know the bytes on disk are a valid encoding.
    const view = await viewStorage.get(rid);
    expect(view).not.toBeNull();
    expect(view!.resource['@id']).toBe(String(rid));
    expect(Array.isArray(view!.annotations.annotations)).toBe(true);
    expect(view!.annotations.annotations.length).toBe(20);
  });
});
