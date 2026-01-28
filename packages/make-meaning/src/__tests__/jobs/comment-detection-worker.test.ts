/**
 * Comment Detection Worker Event Emission Tests
 *
 * Tests that CommentDetectionWorker emits proper job progress events to Event Store
 * during comment detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { CommentDetectionWorker } from '../../jobs/comment-detection-worker';
import { JobQueue, type CommentDetectionJob, type RunningJob, type CommentDetectionParams, type CommentDetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig } from '@semiont/core';
import { jobId } from '@semiont/api-client';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference to avoid external API calls
const mockCreate = vi.fn();
vi.mock('@semiont/inference', () => {
  const mockClient = {
    messages: {
      create: mockCreate
    }
  };

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockClient),
    getInferenceModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514')
  };
});

describe('CommentDetectionWorker - Event Emission', () => {
  let worker: CommentDetectionWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-comment-worker-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration
    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          platform: { type: 'posix' },
          port: 4000,
          publicURL: 'http://localhost:4000',
          corsOrigin: 'http://localhost:3000'
        },
        inference: {
          platform: { type: 'external' },
          type: 'anthropic',
          model: 'claude-sonnet-4-20250514',
          maxTokens: 8192,
          endpoint: 'https://api.anthropic.com',
          apiKey: 'test-api-key'
        },
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
      site: {
        siteName: 'Test Site',
        domain: 'localhost:3000',
        adminEmail: 'admin@test.local',
        oauthAllowedDomains: ['test.local']
      },
      _metadata: {
        environment: 'test',
        projectRoot: testDir
      },
    } as EnvironmentConfig;

    // Initialize job queue and event store
    const jobQueue = new JobQueue({ dataDir: testDir });
    await jobQueue.initialize();
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL);
    worker = new CommentDetectionWorker(jobQueue, config, testEventStore);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string = 'Test content for comment detection'): Promise<void> {
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);

    const testContent = Buffer.from(content, 'utf-8');
    const { checksum } = await repStore.store(testContent, { mediaType: 'text/plain' });

    await testEventStore.appendEvent({
      type: 'resource.created',
      resourceId: resourceId(id),
      userId: userId('user-1'),
      version: 1,
      payload: {
        name: `Test Resource ${id}`,
        format: 'text/plain',
        contentChecksum: checksum,
        creationMethod: 'api'
      }
    });
  }

  // Helper to get events for a resource
  async function getResourceEvents(resId: string) {
    const allEvents = await testEventStore.log.getEvents(resourceId(resId));
    return allEvents;
  }

  it('should emit job.started event when comment detection begins', async () => {
    const testResourceId = `resource-comment-started-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify([])
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<CommentDetectionParams, CommentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-comment-1'),
        type: 'comment-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: CommentDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const startedEvents = events.filter(e => e.event.type === 'job.started');
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);

    const startedEvent = startedEvents[0];
    expect(startedEvent).toBeDefined();
    expect(startedEvent!.event).toMatchObject({
      type: 'job.started',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-comment-1',
        jobType: 'comment-detection'
      }
    });
  });

  it('should emit job.progress events during comment detection', async () => {
    const testResourceId = `resource-comment-progress-${Date.now()}`;
    await createTestResource(testResourceId, 'Test content for progress tracking');

    // Mock AI response with comments
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify([
          {
            exact: 'Test content',
            start: 0,
            end: 12,
            comment: 'This is a test comment',
            prefix: '',
            suffix: ' for progress'
          }
        ])
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<CommentDetectionParams, CommentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-comment-2'),
        type: 'comment-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: CommentDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const progressEvent = progressEvents[0];
    expect(progressEvent!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-comment-2',
        percentage: expect.any(Number)
      }
    });
  });

  it('should emit job.completed event when comment detection finishes', async () => {
    const testResourceId = `resource-comment-complete-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify([
          {
            exact: 'Test',
            start: 0,
            end: 4,
            comment: 'A comment',
            prefix: '',
            suffix: ' content'
          }
        ])
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<CommentDetectionParams, CommentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-comment-3'),
        type: 'comment-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: CommentDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const completedEvent = completedEvents[0];
    expect(completedEvent!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-comment-3',
        commentsFound: expect.any(Number)
      }
    });
  });

  it('should emit annotation.created events for detected comments', async () => {
    const testResourceId = `resource-comment-annotations-${Date.now()}`;
    await createTestResource(testResourceId, 'Content for annotation testing');

    // Mock AI response with multiple comments
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: JSON.stringify([
          {
            exact: 'Content',
            start: 0,
            end: 7,
            comment: 'First comment',
            prefix: '',
            suffix: ' for annotation'
          },
          {
            exact: 'annotation',
            start: 12,
            end: 22,
            comment: 'Second comment',
            prefix: 'Content for ',
            suffix: ' testing'
          }
        ])
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<CommentDetectionParams, CommentDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-comment-4'),
        type: 'comment-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: CommentDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');
    expect(annotationEvents.length).toBe(2);

    // Check first annotation
    expect(annotationEvents[0]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        motivation: 'commenting',
        bodyValue: 'First comment'
      }
    });

    // Check second annotation
    expect(annotationEvents[1]!.event).toMatchObject({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        motivation: 'commenting',
        bodyValue: 'Second comment'
      }
    });
  });
});
