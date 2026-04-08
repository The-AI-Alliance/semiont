/**
 * End-to-End SSE Event Flow Integration Tests
 *
 * Tests the complete flow from worker event emission through Event Store
 * to SSE stream delivery.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SemiontProject } from '@semiont/core/node';
import { resourceId, userId, jobId, EventBus, type Logger } from '@semiont/core';
import type { EventStore } from '@semiont/event-sourcing';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Subscription } from 'rxjs';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

let testDir: string;

describe('SSE Event Flow - End-to-End', () => {
  let eventStore: EventStore;
  const coreEventBus = new EventBus();

  beforeAll(async () => {
    testDir = path.join(tmpdir(), `semiont-test-e2e-${uuidv4()}`);
    await fsPromises.mkdir(testDir, { recursive: true });

    // SEMIONT_ROOT and SEMIONT_ENV are set by the global test setup
    const { createEventStore } = await import('@semiont/event-sourcing');
    const project = new SemiontProject(testDir);
    eventStore = createEventStore(project, coreEventBus, mockLogger);

  });

  afterAll(async () => {
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  it('should flow detection events from worker to SSE subscriber', async () => {
    const rId = resourceId('resource-e2e-1');
    const testJobId = jobId('job-e2e-1');
    const receivedEvents: any[] = [];

    // Simulate SSE endpoint subscribing to typed channels
    const scopedBus = coreEventBus.scope(String(rId));
    const subscriptions: Subscription[] = [];

    subscriptions.push(scopedBus.get('job:started').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: 'job:started', event });
      }
    }));

    subscriptions.push(scopedBus.get('job:progress').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: 'job:progress', event });
      }
    }));

    subscriptions.push(scopedBus.get('job:completed').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: 'job:completed', event });
      }
    }));

    // Simulate worker emitting events
    await eventStore.appendEvent({
      type: 'job:started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        totalSteps: 3
      }
    });

    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        percentage: 33,
        currentStep: 'Person',
        processedSteps: 1,
        totalSteps: 3,
        foundCount: 2,
        message: 'Scanning for Person...'
      }
    });

    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        percentage: 66,
        currentStep: 'Organization',
        processedSteps: 2,
        totalSteps: 3,
        foundCount: 5,
        message: 'Scanning for Organization...'
      }
    });

    await eventStore.appendEvent({
      type: 'job:completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        totalSteps: 3,
        foundCount: 7,
        message: 'Detection complete!'
      }
    });

    // Wait for async notifications
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(receivedEvents).toHaveLength(4);
    expect(receivedEvents[0].type).toBe('job:started');
    expect(receivedEvents[1].type).toBe('job:progress');
    expect(receivedEvents[1].payload.percentage).toBe(33);
    expect(receivedEvents[2].type).toBe('job:progress');
    expect(receivedEvents[2].payload.percentage).toBe(66);
    expect(receivedEvents[3].type).toBe('job:completed');

    subscriptions.forEach(s => s.unsubscribe());
  });

  it('should flow generation events from worker to SSE subscriber', async () => {
    const rId = resourceId('resource-e2e-2');
    const testJobId = jobId('job-e2e-2');
    const receivedEvents: any[] = [];

    const scopedBus = coreEventBus.scope(String(rId));
    const subscriptions: Subscription[] = [];

    subscriptions.push(scopedBus.get('job:started').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: event.type, stage: null, percentage: null });
      }
    }));

    subscriptions.push(scopedBus.get('job:progress').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({
          type: event.type,
          stage: event.payload.currentStep,
          percentage: event.payload.percentage
        });
      }
    }));

    subscriptions.push(scopedBus.get('job:completed').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: event.type, stage: null, percentage: null });
      }
    }));

    // Simulate generation worker emitting events
    await eventStore.appendEvent({
      type: 'job:started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'generation',
        totalSteps: 5
      }
    });

    const stages = [
      { step: 'fetching', percentage: 20 },
      { step: 'generating', percentage: 40 },
      { step: 'creating', percentage: 85 },
      { step: 'linking', percentage: 95 }
    ];

    for (const stage of stages) {
      await eventStore.appendEvent({
        type: 'job:progress',
        resourceId: rId,
        userId: userId('user-1'),
        version: 1,
        payload: {
          jobId: testJobId,
          jobType: 'generation',
          percentage: stage.percentage,
          currentStep: stage.step,
          message: `${stage.step}...`
        }
      });
    }

    await eventStore.appendEvent({
      type: 'job:completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'generation',
        resultResourceId: resourceId('new-resource-id'),
        message: 'Draft resource created!'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(receivedEvents).toHaveLength(6); // 1 started + 4 progress + 1 completed
    expect(receivedEvents[0].type).toBe('job:started');
    expect(receivedEvents[1].stage).toBe('fetching');
    expect(receivedEvents[2].stage).toBe('generating');
    expect(receivedEvents[3].stage).toBe('creating');
    expect(receivedEvents[4].stage).toBe('linking');
    expect(receivedEvents[5].type).toBe('job:completed');

    subscriptions.forEach(s => s.unsubscribe());
  });

  it('should handle job failure events', async () => {
    const rId = resourceId('resource-e2e-3');
    const testJobId = jobId('job-e2e-3');
    const receivedEvents: any[] = [];

    const scopedBus = coreEventBus.scope(String(rId));
    const subscriptions: Subscription[] = [];

    subscriptions.push(scopedBus.get('job:started').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: event.type, error: null });
      }
    }));

    subscriptions.push(scopedBus.get('job:progress').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: event.type, error: null });
      }
    }));

    subscriptions.push(scopedBus.get('job:failed').subscribe((event) => {
      if (event.payload.jobId === testJobId) {
        receivedEvents.push({ type: event.type, error: event.payload.error });
      }
    }));

    // Simulate worker starting job
    await eventStore.appendEvent({
      type: 'job:started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        totalSteps: 3
      }
    });

    // Simulate progress
    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        percentage: 50,
        currentStep: 'Person',
        message: 'Processing...'
      }
    });

    // Simulate failure
    await eventStore.appendEvent({
      type: 'job:failed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        error: 'AI service unavailable',
        details: 'Connection timeout after 30s'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    expect(receivedEvents).toHaveLength(3);
    expect(receivedEvents[0].type).toBe('job:started');
    expect(receivedEvents[1].type).toBe('job:progress');
    expect(receivedEvents[2].type).toBe('job:failed');
    expect(receivedEvents[2].error).toBe('AI service unavailable');

    subscriptions.forEach(s => s.unsubscribe());
  });

  it('should filter events by jobId correctly', async () => {
    const rId = resourceId('resource-e2e-4');
    const jobId1 = jobId('job-e2e-4a');
    const jobId2 = jobId('job-e2e-4b');
    const receivedJob1Events: any[] = [];

    // Subscribe to typed channels for jobId1 only
    const scopedBus = coreEventBus.scope(String(rId));
    const subscriptions: Subscription[] = [];

    subscriptions.push(scopedBus.get('job:progress').subscribe((event) => {
      if (event.payload.jobId === jobId1) {
        receivedJob1Events.push(event);
      }
    }));

    subscriptions.push(scopedBus.get('job:completed').subscribe((event) => {
      if (event.payload.jobId === jobId1) {
        receivedJob1Events.push(event);
      }
    }));

    // Emit events for both jobs
    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId1,
        jobType: 'reference-annotation',
        percentage: 50
      }
    });

    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId2,
        jobType: 'reference-annotation',
        percentage: 50
      }
    });

    await eventStore.appendEvent({
      type: 'job:completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: jobId1,
        jobType: 'reference-annotation'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Should only receive events for jobId1
    expect(receivedJob1Events).toHaveLength(2);
    expect(receivedJob1Events.every(e => e.payload.jobId === jobId1)).toBe(true);

    subscriptions.forEach(s => s.unsubscribe());
  });

  it('should handle multiple concurrent subscribers', async () => {
    const rId = resourceId('resource-e2e-5');
    const testJobId = jobId('job-e2e-5');
    const subscriber1Events: any[] = [];
    const subscriber2Events: any[] = [];
    const subscriber3Events: any[] = [];

    // Create multiple subscribers (simulating multiple SSE clients)
    const scopedBus = coreEventBus.scope(String(rId));
    const subscriptions: Subscription[] = [];

    for (const channel of ['job:started', 'job:completed'] as const) {
      subscriptions.push(scopedBus.get(channel).subscribe((event) => {
        subscriber1Events.push(event);
      }));

      subscriptions.push(scopedBus.get(channel).subscribe((event) => {
        subscriber2Events.push(event);
      }));

      subscriptions.push(scopedBus.get(channel).subscribe((event) => {
        subscriber3Events.push(event);
      }));
    }

    // Emit events
    await eventStore.appendEvent({
      type: 'job:started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        totalSteps: 2
      }
    });

    await eventStore.appendEvent({
      type: 'job:completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation'
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // All subscribers should receive all events
    expect(subscriber1Events).toHaveLength(2);
    expect(subscriber2Events).toHaveLength(2);
    expect(subscriber3Events).toHaveLength(2);

    subscriptions.forEach(s => s.unsubscribe());
  });

  it('should maintain low latency (<50ms from emit to notify)', async () => {
    const rId = resourceId('resource-e2e-6');
    const testJobId = jobId('job-e2e-6');
    let notifyTime: number | null = null;

    const subscription: Subscription = coreEventBus.scope(String(rId)).get('job:progress').subscribe(() => {
      notifyTime = Date.now();
    });

    const emitTime = Date.now();
    await eventStore.appendEvent({
      type: 'job:progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        percentage: 50
      }
    });

    // Wait for notification
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(notifyTime).not.toBeNull();
    const latency = notifyTime! - emitTime;
    expect(latency).toBeLessThan(50);

    subscription.unsubscribe();
  });
});
