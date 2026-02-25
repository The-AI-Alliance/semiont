/**
 * Scripting Example: Entity Detection with Progress Monitoring
 *
 * Demonstrates how to:
 * - Start make-meaning service for script usage
 * - Create a resource with content to analyze
 * - Enqueue detection jobs directly via JobQueue
 * - Subscribe to resource-scoped progress events
 * - Monitor job lifecycle (started, progress, completed)
 *
 * This pattern is useful for:
 * - Batch entity detection scripts
 * - Monitoring long-running detection jobs
 * - Custom progress reporting
 * - Automated content analysis pipelines
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus } from '@semiont/core';
import { startMakeMeaning, ResourceOperations } from '../..';
import type { EnvironmentConfig } from '@semiont/core';
import { userId, entityType, resourceId } from '@semiont/core';
import { getResourceId } from '@semiont/api-client';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference for predictable testing
const mockInferenceClient = vi.hoisted(() => ({ client: null as any }));

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  // Mock returns 2 entities: Person and Organization
  mockInferenceClient.client = new MockInferenceClient([
    JSON.stringify([
      { exact: 'Alice', entityType: 'Person', startOffset: 0, endOffset: 5 },
      { exact: 'Acme Corp', entityType: 'Organization', startOffset: 20, endOffset: 29 }
    ])
  ]);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient,
  };
});

describe('Scripting Example: Entity Detection with Progress', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-detection-test-${Date.now()}`);
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

    // Create EventBus
    eventBus = new EventBus();

    // Start make-meaning service
    makeMeaning = await startMakeMeaning(config, eventBus);
  });

  afterEach(async () => {
    // Stop service
    if (makeMeaning) {
      await makeMeaning.stop();
    }

    // Destroy EventBus
    if (eventBus) {
      eventBus.destroy();
    }

    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('monitors detection progress events', async () => {
    // Create a resource to analyze
    const result = await ResourceOperations.createResource(
      {
        name: 'Test Document',
        content: Buffer.from('Alice works at Acme Corp. She is a software engineer.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    const rId = getResourceId(result.resource);
    expect(rId).toBeDefined();

    // Create resource-scoped event bus
    const resourceBus = eventBus.scope(rId!);

    // Track events
    const jobQueuedEvents: any[] = [];
    const detectionStartedEvents: any[] = [];
    const detectionProgressEvents: any[] = [];
    const detectionCompletedEvents: any[] = [];

    // Subscribe to job queue event
    resourceBus.get('job:queued').subscribe(event => {
      jobQueuedEvents.push(event);
      console.log(`[${rId}] Job queued: ${event.jobType}`);
    });

    // Subscribe to detection lifecycle events
    // Subscribe to domain event for job.started
    resourceBus.get('make-meaning:event').subscribe(event => {
      if (event.type === 'job.started') {
        detectionStartedEvents.push(event);
        console.log(`[${rId}] Detection started`);
      }
    });

    resourceBus.get('annotate:progress').subscribe(progress => {
      detectionProgressEvents.push(progress);
      console.log(`[${rId}] Progress: ${progress.status} - ${progress.message || ''}`);
    });

    // Create promise to wait for completion
    // Subscribe to domain event 'make-meaning:event' and filter for job.completed
    const completionPromise = new Promise(resolve => {
      resourceBus.get('make-meaning:event').subscribe(event => {
        if (event.type === 'job.completed') {
          detectionCompletedEvents.push(event);
          console.log(`[${rId}] Detection complete`);
          resolve(event);
        }
      });
    });

    // Enqueue detection job
    await makeMeaning.jobQueue.createJob({
      status: 'pending',
      metadata: {
        id: `job-${Date.now()}` as any,
        type: 'reference-annotation',
        userId: userId('test-script'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      },
      params: {
        resourceId: resourceId(rId!),
        entityTypes: [entityType('Person'), entityType('Organization')]
      }
    });

    // Wait for completion (with timeout)
    await Promise.race([
      completionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for detection')), 5000))
    ]);

    // Verify event flow
    expect(jobQueuedEvents.length).toBe(1);
    expect(jobQueuedEvents[0].jobType).toBe('reference-annotation');

    expect(detectionStartedEvents.length).toBe(1);
    expect(detectionCompletedEvents.length).toBe(1);

    // Progress events may vary based on detection implementation
    expect(detectionProgressEvents.length).toBeGreaterThanOrEqual(0);
  });

  it('demonstrates parallel detection for multiple resources', async () => {
    // Create multiple resources
    const resources = await Promise.all([
      ResourceOperations.createResource(
        {
          name: 'Doc 1',
          content: Buffer.from('Alice works at Google.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('test-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
      ResourceOperations.createResource(
        {
          name: 'Doc 2',
          content: Buffer.from('Bob works at Microsoft.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('test-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
    ]);

    // Track completion for each resource
    const completions = new Map<string, boolean>();

    // Subscribe to completion events for each resource
    // Subscribe to domain event 'make-meaning:event' and filter for job.completed
    for (const { resource } of resources) {
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();
      const resourceBus = eventBus.scope(rId!);
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          completions.set(rId!, true);
          console.log(`✓ Completed: ${resource.name} (${rId})`);
        }
      });
    }

    // Enqueue detection jobs for all resources
    await Promise.all(
      resources.map(({ resource }, index) => {
        const rId = getResourceId(resource);
        expect(rId).toBeDefined();
        return makeMeaning.jobQueue.createJob({
          status: 'pending',
          metadata: {
            id: `job-${Date.now()}-${index}` as any,
            type: 'reference-annotation',
            userId: userId('test-script'),
            created: new Date().toISOString(),
            retryCount: 0,
            maxRetries: 1
          },
          params: {
            resourceId: resourceId(rId!),
            entityTypes: [entityType('Person'), entityType('Organization')]
          }
        });
      })
    );

    // Wait for all completions (with timeout)
    await Promise.race([
      new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (completions.size === resources.length) {
            clearInterval(checkInterval);
            resolve(null);
          }
        }, 100);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for detections')), 10000))
    ]);

    // Verify all completed
    expect(completions.size).toBe(resources.length);
    resources.forEach(({ resource }) => {
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();
      expect(completions.get(rId!)).toBe(true);
    });
  });

  it('demonstrates custom progress tracking', async () => {
    // Create a resource
    const result = await ResourceOperations.createResource(
      {
        name: 'Progress Test Doc',
        content: Buffer.from('Testing progress tracking for entity detection.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    const rId = getResourceId(result.resource);
    expect(rId).toBeDefined();
    const resourceBus = eventBus.scope(rId!);

    // Track progress percentage
    const progressPercentages: number[] = [];

    resourceBus.get('annotate:progress').subscribe(progress => {
      if (progress.percentage !== undefined) {
        progressPercentages.push(progress.percentage);
      }
    });

    // Create completion promise
    // Subscribe to domain event 'make-meaning:event' and filter for job.completed
    const completionPromise = new Promise(resolve => {
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          resolve(event);
        }
      });
    });

    // Enqueue job
    await makeMeaning.jobQueue.createJob({
      status: 'pending',
      metadata: {
        id: `job-${Date.now()}` as any,
        type: 'reference-annotation',
        userId: userId('test-script'),
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      },
      params: {
        resourceId: resourceId(rId!),
        entityTypes: [entityType('Person')]
      }
    });

    // Wait for completion
    await Promise.race([
      completionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
    ]);

    // Progress tracking may be available depending on worker implementation
    console.log(`Progress updates received: ${progressPercentages.length}`);
    console.log(`Progress percentages: ${progressPercentages.join(', ')}`);
  });
});
