/**
 * Tag Detection Worker Event Emission Tests
 *
 * Tests that TagDetectionWorker emits proper job progress events to Event Store
 * during structural tag detection processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { TagDetectionWorker } from '../../jobs/tag-detection-worker';
import { JobQueue, type TagDetectionJob, type RunningJob, type TagDetectionParams, type TagDetectionProgress } from '@semiont/jobs';
import { resourceId, userId, type EnvironmentConfig } from '@semiont/core';
import { jobId } from '@semiont/api-client';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference to avoid external API calls
const mockInferenceClient = vi.hoisted(() => {
  return { client: null as any };
});
const mockGenerateText = vi.hoisted(() => vi.fn());

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['[]']); // Empty array response for tags

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    generateText: mockGenerateText,
    MockInferenceClient
  };
});

// Mock @semiont/ontology to provide tag schema
vi.mock('@semiont/ontology', () => ({
  getTagSchema: vi.fn().mockReturnValue({
    id: 'imrad',
    name: 'IMRAD',
    description: 'Introduction, Methods, Results, and Discussion structure',
    domain: 'academic',
    tags: [
      { name: 'Introduction' },
      { name: 'Methods' },
      { name: 'Results' },
      { name: 'Discussion' }
    ]
  }),
  getSchemaCategory: vi.fn((schemaId: string, categoryName: string) => ({
    name: categoryName,
    description: `${categoryName} section`,
    examples: [`What is ${categoryName.toLowerCase()}?`, `How does ${categoryName.toLowerCase()} work?`]
  }))
}));

describe('TagDetectionWorker - Event Emission', () => {
  let worker: TagDetectionWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-tag-worker-${Date.now()}`);
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
    worker = new TagDetectionWorker(jobQueue, config, testEventStore, mockInferenceClient.client);

    // Set default mock response
    mockGenerateText.mockResolvedValue('[]');
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string = 'Introduction paragraph. Methods section. Results follow. Conclusion at end.'): Promise<void> {
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

  it('should emit job.started event when tag detection begins', async () => {
    const testResourceId = `resource-tag-started-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([])]);

    const job: RunningJob<TagDetectionParams, TagDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-tag-1'),
        type: 'tag-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        schemaId: 'imrad',
        categories: ['Introduction', 'Methods', 'Results', 'Discussion']
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        totalCategories: 4,
        processedCategories: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: TagDetectionJob) => Promise<void> }).executeJob(job);

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
        jobId: 'job-tag-1',
        jobType: 'tag-detection'
      }
    });
  });

  it('should emit job.progress events during category scanning', async () => {
    const testResourceId = `resource-tag-progress-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response with tags
    mockInferenceClient.client.setResponses([JSON.stringify([
          {
            exact: 'Introduction paragraph',
            start: 0,
            end: 22,
            prefix: '',
            suffix: '. Methods section'
          }
        ])]);

    const job: RunningJob<TagDetectionParams, TagDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-tag-2'),
        type: 'tag-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        schemaId: 'imrad',
        categories: ['Introduction', 'Methods', 'Results', 'Discussion']
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        totalCategories: 4,
        processedCategories: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: TagDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    const progressEvent = progressEvents[0];
    expect(progressEvent!.event).toMatchObject({
      type: 'job.progress',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-tag-2'
      }
    });
  });

  it('should emit job.completed event when tag detection finishes', async () => {
    const testResourceId = `resource-tag-complete-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI response
    mockInferenceClient.client.setResponses([JSON.stringify([
          {
            exact: 'Methods section',
            start: 24,
            end: 39,
            prefix: 'Introduction paragraph. ',
            suffix: '. Results follow'
          }
        ])]);

    const job: RunningJob<TagDetectionParams, TagDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-tag-3'),
        type: 'tag-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        schemaId: 'imrad',
        categories: ['Introduction', 'Methods', 'Results', 'Discussion']
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        totalCategories: 4,
        processedCategories: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: TagDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const completedEvent = completedEvents[0];
    expect(completedEvent!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-tag-3'
      }
    });
  });

  it('should emit annotation.created events for detected tags', async () => {
    const testResourceId = `resource-tag-annotations-${Date.now()}`;
    await createTestResource(testResourceId);

    // Mock AI responses - one for each category
    mockInferenceClient.client.setResponses([
      // Introduction category
      JSON.stringify([{
        exact: 'Introduction paragraph',
        start: 0,
        end: 22,
        prefix: '',
        suffix: '. Methods section'
      }]),
      // Methods category
      JSON.stringify([{
        exact: 'Methods section',
        start: 24,
        end: 39,
        prefix: 'Introduction paragraph. ',
        suffix: '. Results follow'
      }]),
      // Results category
      JSON.stringify([{
        exact: 'Results follow',
        start: 41,
        end: 55,
        prefix: 'Methods section. ',
        suffix: '. Conclusion at'
      }]),
      // Discussion category
      JSON.stringify([{
        exact: 'Conclusion at end',
        start: 57,
        end: 74,
        prefix: 'Results follow. ',
        suffix: '.'
      }])
    ]);

    const job: RunningJob<TagDetectionParams, TagDetectionProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-tag-4'),
        type: 'tag-detection',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        resourceId: resourceId(testResourceId),
        schemaId: 'imrad',
        categories: ['Introduction', 'Methods', 'Results', 'Discussion']
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'analyzing',
        percentage: 0,
        totalCategories: 4,
        processedCategories: 0,
        message: 'Initializing'
      }
    };

    await (worker as unknown as { executeJob: (job: TagDetectionJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const annotationEvents = events.filter(e => e.event.type === 'annotation.added');
    expect(annotationEvents.length).toBe(4);

    // All annotations should be tagging motivation
    for (const event of annotationEvents) {
      expect(event.event).toMatchObject({
        type: 'annotation.added',
        resourceId: resourceId(testResourceId),
        userId: userId('user-1'),
        payload: {
          annotation: {
            motivation: 'tagging'
          }
        }
      });
    }
  });
});
