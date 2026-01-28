/**
 * Generation Worker Event Emission Tests
 *
 * Tests that GenerationWorker emits proper job progress events to Event Store
 * during resource generation processing.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { GenerationWorker } from '../../jobs/generation-worker';
import { JobQueue, type GenerationJob, type RunningJob, type GenerationParams, type GenerationProgress } from '@semiont/jobs';
import { resourceId, userId, annotationId, type EnvironmentConfig } from '@semiont/core';
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

describe('GenerationWorker - Event Emission', () => {
  let worker: GenerationWorker;
  let testDir: string;
  let testEventStore: EventStore;
  let config: EnvironmentConfig;

  beforeAll(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-generation-worker-${Date.now()}`);
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
    worker = new GenerationWorker(jobQueue, config, testEventStore);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource with content
  async function createTestResource(id: string, content: string = 'Test source resource for generation'): Promise<void> {
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

  // Helper to create a reference annotation
  async function createReferenceAnnotation(sourceId: string, targetTopic: string): Promise<string> {
    const refId = `ref-${Date.now()}`;

    await testEventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId(sourceId),
      annotationId: annotationId(refId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: refId,
          type: 'Annotation',
          motivation: 'linking',
          body: {
            type: 'SpecificResource',
            source: targetTopic,
            purpose: 'linking'
          },
          target: {
            source: `http://localhost:4000/resources/${sourceId}`,
            selector: {
              type: 'TextQuoteSelector',
              exact: 'Test',
              prefix: '',
              suffix: ''
            }
          }
        }
      }
    });

    return refId;
  }

  // Helper to get events for a resource
  async function getResourceEvents(resId: string) {
    const allEvents = await testEventStore.log.getEvents(resourceId(resId));
    return allEvents;
  }

  it('should emit job.started event when generation begins', async () => {
    const testResourceId = `resource-gen-started-${Date.now()}`;
    await createTestResource(testResourceId);
    const refId = await createReferenceAnnotation(testResourceId, 'Test Topic');

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: 'Generated content about Test Topic'
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-1'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId(refId),
        sourceResourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'fetching',
        percentage: 0,
        message: 'Starting generation'
      }
    };

    await (worker as unknown as { executeJob: (job: GenerationJob) => Promise<void> }).executeJob(job);

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
        jobId: 'job-gen-1',
        jobType: 'generation'
      }
    });
  });

  it('should emit job.progress events through generation stages', async () => {
    const testResourceId = `resource-gen-progress-${Date.now()}`;
    await createTestResource(testResourceId);
    const refId = await createReferenceAnnotation(testResourceId, 'Progress Topic');

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: 'Generated content for progress tracking'
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-2'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId(refId),
        sourceResourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'fetching',
        percentage: 0,
        message: 'Starting generation'
      }
    };

    await (worker as unknown as { executeJob: (job: GenerationJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const progressEvents = events.filter(e => e.event.type === 'job.progress');
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);

    // Verify stages appear in progress events
    const stages = progressEvents.map((e: any) => e.event.payload?.stage || '');
    expect(stages.some(s => s.includes('Fetching') || s.includes('Generating'))).toBe(true);
  });

  it('should emit job.completed event when generation finishes', async () => {
    const testResourceId = `resource-gen-complete-${Date.now()}`;
    await createTestResource(testResourceId);
    const refId = await createReferenceAnnotation(testResourceId, 'Complete Topic');

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: 'Generated content for completion test'
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-3'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId(refId),
        sourceResourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'fetching',
        percentage: 0,
        message: 'Starting generation'
      }
    };

    await (worker as unknown as { executeJob: (job: GenerationJob) => Promise<void> }).executeJob(job);

    const events = await getResourceEvents(testResourceId);
    const completedEvents = events.filter(e => e.event.type === 'job.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    const completedEvent = completedEvents[0];
    expect(completedEvent!.event).toMatchObject({
      type: 'job.completed',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      payload: {
        jobId: 'job-gen-3'
      }
    });
  });

  it('should emit resource.created event for generated resource', async () => {
    const testResourceId = `resource-gen-create-${Date.now()}`;
    await createTestResource(testResourceId);
    const refId = await createReferenceAnnotation(testResourceId, 'New Resource Topic');

    // Mock AI response
    mockCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: 'This is the content of a newly generated resource'
      }],
      stop_reason: 'end_turn'
    });

    const job: RunningJob<GenerationParams, GenerationProgress> = {
      status: 'running',
      metadata: {
        id: jobId('job-gen-4'),
        type: 'generation',
        userId: userId('user-1'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 3
      },
      params: {
        referenceId: annotationId(refId),
        sourceResourceId: resourceId(testResourceId)
      },
      startedAt: new Date().toISOString(),
      progress: {
        stage: 'fetching',
        percentage: 0,
        message: 'Starting generation'
      }
    };

    await (worker as unknown as { executeJob: (job: GenerationJob) => Promise<void> }).executeJob(job);

    // Check for resource.created events - should include the generated resource
    const allEvents = await testEventStore.log.getEvents(resourceId(testResourceId));
    const resourceCreatedEvents = allEvents.filter((e: any) =>
      e.event.type === 'resource.created' &&
      e.event.payload?.creationMethod === 'generation'
    );

    expect(resourceCreatedEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the generated resource was created with proper metadata
    const generatedEvent = resourceCreatedEvents[0];
    expect(generatedEvent.event.payload).toMatchObject({
      creationMethod: 'generation',
      format: 'text/plain'
    });
  });
});
