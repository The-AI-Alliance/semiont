/**
 * Regression: `mark.assist` must not churn the SSE connection.
 *
 * Root cause (see .plans/SEMIONT-BUG-browse-annotations.md, "Link 1"): a
 * headless `mark.assist` called `transport.subscribeToResource(rId)` to
 * receive the resource-scoped `job:complete`/`job:fail`. That mutates the
 * SSE channel set, which can only be changed by tearing down and re-opening
 * the connection — so every assist forced (two) SSE reconnects, and a
 * `browse.*` result emitted during the reconnect gap was dropped.
 *
 * The fix makes the worker also emit `job:complete`/`job:fail` globally
 * (dual-emit), so the dispatching caller receives them via the always-on
 * global bridge — no scoped subscription, no channel-set mutation, no
 * reconnect. `mark.assist` therefore must NOT call `subscribeToResource`,
 * and must still complete on a globally-delivered `job:complete`.
 *
 * No backend: a fake transport stands in for the bus.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Observable, Subject } from 'rxjs';
import { EventBus, resourceId as makeResourceId } from '@semiont/core';
import type { ITransport, ResourceId } from '@semiont/core';
import { MarkNamespace } from '../mark';
import { JobNamespace } from '../job';
import type { MarkAssistEvent } from '../types';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function makeFakeTransport() {
  const subjects = new Map<string, Subject<Record<string, unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) {
      s = new Subject<Record<string, unknown>>();
      subjects.set(channel, s);
    }
    return s;
  };
  const subscribeToResource = vi.fn((_rId: ResourceId) => () => {});

  const transport = {
    baseUrl: 'http://test',
    subscribeToResource,
    emit: async (channel: string, payload: Record<string, unknown>) => {
      // Resolve the job:create round-trip so dispatchAssist gets a jobId.
      if (channel === 'job:create') {
        subjectFor('job:created').next({
          correlationId: payload.correlationId,
          response: { jobId: 'job-1' },
        });
      }
    },
    stream: (channel: string): Observable<Record<string, unknown>> => subjectFor(channel).asObservable(),
    bridgeInto: () => {},
    state$: new Subject(),
    errors$: new Subject(),
    dispose: () => {},
  };

  return { transport: transport as unknown as ITransport, subscribeToResource };
}

describe('mark.assist — no SSE churn (Link 1)', () => {
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
    bus.get('job:complete').next({ resourceId: rId, jobId: 'job-1', jobType: 'reference-annotation' });

    expect(events.some((e) => e.kind === 'complete')).toBe(true);
    expect(completed).toBe(true);
  });
});

describe('job:complete dual-delivery contract (Link 1 / approach A)', () => {
  let bus: EventBus;
  const rId = makeResourceId('res-1');
  const completePayload = { resourceId: rId, jobId: 'job-1', jobType: 'reference-annotation' as const };

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

    // Worker dual-emit: the same completion arrives globally AND scoped, so a
    // client subscribed to both sees two bus deliveries.
    bus.get('job:complete').next(completePayload);
    bus.get('job:complete').next(completePayload);

    expect(completes).toHaveLength(1);
    expect(completeCount).toBe(1);
  });

  it('job.complete$ is a raw passthrough — each delivery is observed (consumers must key on jobId)', () => {
    const { transport } = makeFakeTransport();
    const job = new JobNamespace(transport, bus);

    const seen: string[] = [];
    job.complete$.subscribe((e) => seen.push(e.jobId));

    bus.get('job:complete').next(completePayload);
    bus.get('job:complete').next(completePayload);

    // Documents the contract: the SDK does NOT dedupe the raw stream.
    expect(seen).toEqual(['job-1', 'job-1']);
  });
});
