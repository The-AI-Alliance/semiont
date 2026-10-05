/**
 * `mark.assist` must not churn the SSE connection.
 *
 * The worker emits `job:report-progress`, `job:complete` and `job:fail` to
 * every client, so the dispatching caller receives them via the always-on
 * global bridge and follows its job by `jobId`. A resource's scope carries
 * none of the three.
 *
 * A headless `mark.assist` that called `transport.subscribeToResource(rId)`
 * anyway would change the SSE channel set, which the HTTP transport applies
 * by handing the stream over to a second connection opened beside the live
 * one — so every assist would cost two handoffs, one when the scope is
 * joined and one when it is left, and gain nothing.
 * `mark.assist` therefore must NOT call `subscribeToResource`, and must
 * complete on a globally-delivered `job:complete`.
 *
 * No gateway: a fake transport stands in for the bus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus, resourceId as makeResourceId, jobId } from '@semiont/core';
import type { ResourceId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { JobNamespace } from '../job';
import type { MarkAssistEvent } from '../types';
import { inMemoryTransport } from '../../__tests__/helpers/in-memory-transport';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeFakeTransport() {
  // One typed bus: the transport streams from it and this fixture pushes
  // into it, so a reply is checked against the channel's declared payload.
  const transportBus = new EventBus();
  const subscribeToResource = vi.fn((_rId: ResourceId) => () => {});

  const transport = inMemoryTransport({
    bus: transportBus,
    subscribeToResource,
    onEmit: (channel, _payload, envelope) => {
      // Resolve the job:create round-trip so dispatchAssist gets a jobId.
      if (channel === 'job:create') {
        transportBus.emit('job:created', {
          response: { jobId: jobId('job-1') },
        }, { correlationId: envelope?.correlationId });
      }
    },
  });

  return { transport, subscribeToResource };
}

describe('mark.assist — no SSE churn', () => {
  let bus: EventBus;
  const rId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  it('does not subscribe to the resource scope (which would churn the SSE)', () => {
    const { transport, subscribeToResource } = makeFakeTransport();
    const mark = new MarkNamespace(transport, bus);

    const sub = mark
      .assist(rId, 'linking', { entityTypes: ['Person'] })
      .subscribe({ next: () => {}, error: () => {} });

    expect(subscribeToResource).not.toHaveBeenCalled();
    sub.unsubscribe();
  });

  it('completes on a globally-delivered job:complete (no scoped subscription needed)', async () => {
    const { transport } = makeFakeTransport();
    const mark = new MarkNamespace(transport, bus);

    const events: MarkAssistEvent[] = [];
    let completed = false;
    mark.assist(rId, 'linking', { entityTypes: ['Person'] }).subscribe({
      next: (e) => events.push(e),
      complete: () => {
        completed = true;
      },
      error: () => {},
    });

    // Let dispatchAssist resolve (job:create → job:created) and set activeJobId.
    await flush();

    // Completion arrives on the global bus (as it would via the global bridge).
    bus.emit('job:complete', { resourceId: rId, jobId: jobId('job-1'), jobType: 'reference-annotation' });

    expect(events.some((e) => e.kind === 'complete')).toBe(true);
    expect(completed).toBe(true);
  });
});

describe('mark.assist — frames that arrive before the job has its id', () => {
  let bus: EventBus;
  const rId = makeResourceId('res-1');

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  it('are held, and this job\'s delivered in order once the reply to job:create has settled', async () => {
    const { transport } = makeFakeTransport();
    const mark = new MarkNamespace(transport, bus);

    const kinds: string[] = [];
    let completed = false;
    mark.assist(rId, 'linking', { entityTypes: ['Person'] }).subscribe({
      next: (e) => kinds.push(e.kind),
      complete: () => {
        completed = true;
      },
      error: () => {},
    });

    // The job's first frames are read from the stream alongside the reply
    // that names it: the follower does not know the id yet.
    bus.emit('job:report-progress', { resourceId: rId, jobId: jobId('job-1'), jobType: 'reference-annotation', percentage: 10, progress: { percentage: 10 } });
    bus.emit('job:complete', { resourceId: rId, jobId: jobId('job-2'), jobType: 'reference-annotation' });
    bus.emit('job:complete', { resourceId: rId, jobId: jobId('job-1'), jobType: 'reference-annotation' });
    expect(kinds).toEqual([]);

    await flush();

    // Another job's end is not this one's; this one's frames are, in order.
    expect(kinds).toEqual(['progress', 'complete']);
    expect(completed).toBe(true);
  });
});

describe('job:complete delivered twice', () => {
  let bus: EventBus;
  const rId = makeResourceId('res-1');
  const completePayload = { resourceId: rId, jobId: jobId('job-1'), jobType: 'reference-annotation' as const };

  beforeEach(() => {
    bus = new EventBus();
  });

  afterEach(() => {
    bus.destroy();
  });

  it('mark.assist collapses a doubled job:complete into a single completion', async () => {
    const { transport } = makeFakeTransport();
    const mark = new MarkNamespace(transport, bus);

    const completes: MarkAssistEvent[] = [];
    let completeCount = 0;
    mark.assist(rId, 'linking', { entityTypes: ['Person'] }).subscribe({
      next: (e) => {
        if (e.kind === 'complete') completes.push(e);
      },
      complete: () => {
        completeCount++;
      },
      error: () => {},
    });
    await flush();

    // The same completion, delivered twice on the bus.
    bus.emit('job:complete', completePayload);
    bus.emit('job:complete', completePayload);

    expect(completes).toHaveLength(1);
    expect(completeCount).toBe(1);
  });

  it('job.complete$ is a raw passthrough — each delivery is observed (consumers must key on jobId)', () => {
    const { transport } = makeFakeTransport();
    const job = new JobNamespace(transport, bus);

    const seen: string[] = [];
    job.complete$.subscribe((e) => seen.push(e.jobId));

    bus.emit('job:complete', completePayload);
    bus.emit('job:complete', completePayload);

    // Documents the contract: the SDK does NOT dedupe the raw stream.
    expect(seen).toEqual(['job-1', 'job-1']);
  });
});
