import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '@semiont/core';
import type { EventMap } from '@semiont/core';
import { createJobReplayBridge } from '../sse/job-replay-bridge';

function storedEvent<T extends keyof EventMap>(
  type: T,
  payload: Record<string, unknown>,
  resourceId = 'resource-1',
): EventMap[T] {
  return {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    resourceId,
    userId: 'did:web:test:users:alice',
    version: 1,
    payload,
    metadata: { sequenceNumber: 1, streamId: 'test' },
  } as unknown as EventMap[T];
}

describe('createJobReplayBridge', () => {
  let eventBus: EventBus;
  let bridge: { dispose(): void };

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    bridge = createJobReplayBridge(eventBus);
  });

  afterEach(() => {
    bridge.dispose();
    eventBus.destroy();
    vi.useRealTimers();
  });

  test('emits mark:progress for a still-running annotation job after settle window', () => {
    const received: EventMap['mark:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => received.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-1',
      jobType: 'reference-annotation',
    }));

    expect(received).toHaveLength(0);
    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('started');
    expect(received[0].resourceId).toBe('resource-1');
  });

  test('emits yield:progress for a still-running generation job', () => {
    const received: EventMap['yield:progress'][] = [];
    eventBus.get('yield:progress').subscribe((e) => received.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-gen-1',
      jobType: 'generation',
    }));

    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);
    expect(received[0].status).toBe('generating');
  });

  test('suppresses emission when job completes within settle window (replay batch)', () => {
    const markReceived: EventMap['mark:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => markReceived.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-2',
      jobType: 'highlight-annotation',
    }));
    eventBus.get('job:completed').next(storedEvent('job:completed', {
      jobId: 'job-2',
      jobType: 'highlight-annotation',
    }));

    vi.advanceTimersByTime(200);
    expect(markReceived).toHaveLength(0);
  });

  test('suppresses emission when job fails within settle window', () => {
    const markReceived: EventMap['mark:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => markReceived.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-3',
      jobType: 'tag-annotation',
    }));
    eventBus.get('job:failed').next(storedEvent('job:failed', {
      jobId: 'job-3',
      jobType: 'tag-annotation',
      error: 'LLM timeout',
    }));

    vi.advanceTimersByTime(200);
    expect(markReceived).toHaveLength(0);
  });

  test('captures latest percentage from job:progress before emitting', () => {
    const received: EventMap['mark:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => received.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-4',
      jobType: 'reference-annotation',
    }));
    eventBus.get('job:progress').next(storedEvent('job:progress', {
      jobId: 'job-4',
      jobType: 'reference-annotation',
      percentage: 42,
      message: 'Scanning Person entities',
    }));

    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(1);
    expect(received[0].percentage).toBe(42);
    expect(received[0].message).toBe('Scanning Person entities');
    expect(received[0].status).toBe('in-progress');
  });

  test('handles multiple concurrent jobs independently', () => {
    const markReceived: EventMap['mark:progress'][] = [];
    const yieldReceived: EventMap['yield:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => markReceived.push(e));
    eventBus.get('yield:progress').subscribe((e) => yieldReceived.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-a',
      jobType: 'reference-annotation',
    }, 'resource-a'));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-b',
      jobType: 'generation',
    }, 'resource-b'));

    // Complete job-a (replay of finished job)
    eventBus.get('job:completed').next(storedEvent('job:completed', {
      jobId: 'job-a',
      jobType: 'reference-annotation',
    }, 'resource-a'));

    vi.advanceTimersByTime(200);

    // job-a suppressed (completed), job-b emitted (still running)
    expect(markReceived).toHaveLength(0);
    expect(yieldReceived).toHaveLength(1);
    expect(yieldReceived[0].sourceResourceId).toBe('resource-b');
  });

  test('dispose clears pending timers', () => {
    const received: EventMap['mark:progress'][] = [];
    eventBus.get('mark:progress').subscribe((e) => received.push(e));

    eventBus.get('job:started').next(storedEvent('job:started', {
      jobId: 'job-5',
      jobType: 'highlight-annotation',
    }));

    bridge.dispose();
    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(0);
  });
});
