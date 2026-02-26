/**
 * EventStore → CoreEventBus Channel Routing Integration Test
 *
 * Verifies that EventStore correctly routes domain events from dot notation to colon notation:
 * - Receives events with dot notation (type: 'job.completed')
 * - Publishes to colon notation channels ('job:completed')
 * - Events are resource-scoped
 * - SSE subscribers receive properly formatted events
 *
 * This test would have caught the bug where EventStore wasn't publishing to
 * specific event type channels, only to the generic 'make-meaning:event' channel.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { resourceId, userId, jobId, type Logger, EventBus as CoreEventBus } from '@semiont/core';
import { loadEnvironmentConfig } from '../../utils/config';
import type { EventStore } from '@semiont/event-sourcing';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

let testDir: string;

describe('EventStore Channel Routing Integration', () => {
  let eventStore: EventStore;
  let coreEventBus: CoreEventBus;

  beforeAll(async () => {
    testDir = path.join(tmpdir(), `semiont-test-routing-${Date.now()}`);
    await fsPromises.mkdir(testDir, { recursive: true });

    // Load config
    const projectRoot = process.env.SEMIONT_ROOT;
    if (!projectRoot) throw new Error("SEMIONT_ROOT not set");
    const environment = process.env.SEMIONT_ENV || 'test';
    const config = loadEnvironmentConfig(projectRoot, environment);

    // Create CoreEventBus to pass to EventStore
    coreEventBus = new CoreEventBus();

    // Create EventStore with CoreEventBus to enable domain event publishing
    const { createEventStore } = await import('@semiont/event-sourcing');
    eventStore = createEventStore(
      testDir,
      config.services.backend!.publicURL,
      {
        enableSharding: false,
        maxEventsPerFile: 100,
      },
      coreEventBus, // Pass CoreEventBus to enable channel routing
      mockLogger
    );
  });

  afterAll(async () => {
    coreEventBus.destroy();
    await fsPromises.rm(testDir, { recursive: true, force: true });
  });

  it('should convert dot notation to colon notation and route to specific channel', async () => {
    const rId = resourceId('test-resource-1');
    const testJobId = jobId('job-test-1');
    const receivedEvents: any[] = [];

    // Subscribe to colon-notation channel (like SSE streams do)
    const scopedBus = coreEventBus.scope(rId);
    const subscription = scopedBus.get('job:completed').subscribe((event) => {
      receivedEvents.push(event);
    });

    // Emit event with dot notation (like workers do)
    await eventStore.appendEvent({
      type: 'job.completed', // DOT notation
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        result: { totalFound: 5, totalCreated: 5 }
      }
    });

    // Wait for async event propagation
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Event received on colon-notation channel
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].type).toBe('job.completed');
    expect(receivedEvents[0].payload.jobId).toBe(testJobId);
    expect(receivedEvents[0].payload.result.totalFound).toBe(5);

    subscription.unsubscribe();
  });

  it('should also publish to generic make-meaning:event channel', async () => {
    const rId = resourceId('test-resource-2');
    const testJobId = jobId('job-test-2');
    const genericEvents: any[] = [];

    // Subscribe to generic channel
    const scopedBus = coreEventBus.scope(rId);
    const subscription = scopedBus.get('make-meaning:event').subscribe((event) => {
      genericEvents.push(event);
    });

    // Emit event
    await eventStore.appendEvent({
      type: 'job.started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'reference-annotation',
        totalSteps: 3
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Event received on generic channel
    expect(genericEvents).toHaveLength(1);
    expect(genericEvents[0].type).toBe('job.started');
    expect(genericEvents[0].payload.jobId).toBe(testJobId);

    subscription.unsubscribe();
  });

  it('should publish to both specific and generic channels simultaneously', async () => {
    const rId = resourceId('test-resource-3');
    const testJobId = jobId('job-test-3');
    const specificEvents: any[] = [];
    const genericEvents: any[] = [];

    // Subscribe to both channels
    const scopedBus = coreEventBus.scope(rId);
    const specificSub = scopedBus.get('job:completed').subscribe((event) => {
      specificEvents.push(event);
    });
    const genericSub = scopedBus.get('make-meaning:event').subscribe((event) => {
      genericEvents.push(event);
    });

    // Emit one event
    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'highlight-annotation',
        result: { highlightsFound: 10, highlightsCreated: 10 }
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Both channels received the same event
    expect(specificEvents).toHaveLength(1);
    expect(genericEvents).toHaveLength(1);

    expect(specificEvents[0].type).toBe('job.completed');
    expect(genericEvents[0].type).toBe('job.completed');

    expect(specificEvents[0].payload.jobId).toBe(testJobId);
    expect(genericEvents[0].payload.jobId).toBe(testJobId);

    specificSub.unsubscribe();
    genericSub.unsubscribe();
  });

  it('should isolate events by resource scope', async () => {
    const rId1 = resourceId('resource-a');
    const rId2 = resourceId('resource-b');
    const job1 = jobId('job-r1');
    const job2 = jobId('job-r2');
    const resource1Events: any[] = [];
    const resource2Events: any[] = [];

    // Subscribe to each resource's scoped bus
    const sub1 = coreEventBus.scope(rId1).get('job:completed').subscribe(e => resource1Events.push(e));
    const sub2 = coreEventBus.scope(rId2).get('job:completed').subscribe(e => resource2Events.push(e));

    // Emit to resource 1
    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: rId1,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: job1,
        jobType: 'comment-annotation',
        result: { commentsCreated: 3 }
      }
    });

    // Emit to resource 2
    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: rId2,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: job2,
        jobType: 'assessment-annotation',
        result: { assessmentsCreated: 5 }
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Each resource only received its own events
    expect(resource1Events).toHaveLength(1);
    expect(resource1Events[0].payload.jobId).toBe(job1);
    expect(resource1Events[0].payload.result.commentsCreated).toBe(3);

    expect(resource2Events).toHaveLength(1);
    expect(resource2Events[0].payload.jobId).toBe(job2);
    expect(resource2Events[0].payload.result.assessmentsCreated).toBe(5);

    sub1.unsubscribe();
    sub2.unsubscribe();
  });

  it('should handle multiple event types with dot-to-colon conversion', async () => {
    const rId = resourceId('test-resource-4');
    const testJobId = jobId('job-test-4');
    const startedEvents: any[] = [];
    const progressEvents: any[] = [];
    const completedEvents: any[] = [];
    const failedEvents: any[] = [];

    // Subscribe to all job event types
    const scopedBus = coreEventBus.scope(rId);
    const startedSub = scopedBus.get('job:started').subscribe(e => startedEvents.push(e));
    const progressSub = scopedBus.get('job:progress').subscribe(e => progressEvents.push(e));
    const completedSub = scopedBus.get('job:completed').subscribe(e => completedEvents.push(e));
    const failedSub = scopedBus.get('job:failed').subscribe(e => failedEvents.push(e));

    // Emit multiple event types
    await eventStore.appendEvent({
      type: 'job.started',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: { jobId: testJobId, jobType: 'tag-annotation', totalSteps: 2 }
    });

    await eventStore.appendEvent({
      type: 'job.progress',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: { jobId: testJobId, currentStep: 1, message: 'Processing...' }
    });

    await eventStore.appendEvent({
      type: 'job.completed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: { jobId: testJobId, result: { tagsCreated: 7 } }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Each channel received only its event type
    expect(startedEvents).toHaveLength(1);
    expect(startedEvents[0].type).toBe('job.started');

    expect(progressEvents).toHaveLength(1);
    expect(progressEvents[0].type).toBe('job.progress');

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0].type).toBe('job.completed');

    expect(failedEvents).toHaveLength(0); // No failed events emitted

    startedSub.unsubscribe();
    progressSub.unsubscribe();
    completedSub.unsubscribe();
    failedSub.unsubscribe();
  });

  it('should handle job:failed event routing', async () => {
    const rId = resourceId('test-resource-5');
    const testJobId = jobId('job-test-5');
    const failedEvents: any[] = [];

    // Subscribe to job:failed channel
    const scopedBus = coreEventBus.scope(rId);
    const subscription = scopedBus.get('job:failed').subscribe(e => failedEvents.push(e));

    // Emit job.failed event (dot notation)
    await eventStore.appendEvent({
      type: 'job.failed',
      resourceId: rId,
      userId: userId('user-1'),
      version: 1,
      payload: {
        jobId: testJobId,
        jobType: 'highlight-annotation',
        error: 'AI inference timeout'
      }
    });

    // Wait for async processing
    await new Promise(resolve => setTimeout(resolve, 50));

    // Assert: Failed event received on colon-notation channel
    expect(failedEvents).toHaveLength(1);
    expect(failedEvents[0].type).toBe('job.failed');
    expect(failedEvents[0].payload.error).toBe('AI inference timeout');

    subscription.unsubscribe();
  });
});
