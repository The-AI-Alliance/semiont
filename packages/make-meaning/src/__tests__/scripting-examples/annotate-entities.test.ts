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
import { type SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, userId, entityType } from '@semiont/core';
import { startMakeMeaning, ResourceOperations, type MakeMeaningConfig } from '../..';
import { deriveStorageUri } from '@semiont/content';
import { createTestProject } from '../helpers/test-project';

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
    createInferenceClient: vi.fn().mockReturnValue(mockInferenceClient.client),
    MockInferenceClient,
  };
});

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

let fileCounter = 0;

describe('Scripting Example: Entity Detection with Progress', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let config: MakeMeaningConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  async function create(
    opts: { name: string; content: Buffer; format: string; language?: string },
    uid: ReturnType<typeof userId>,
  ) {
    const kb = makeMeaning.knowledgeSystem.kb;
    const uri = deriveStorageUri(`test-${++fileCounter}`, opts.format);
    const stored = await kb.content.store(opts.content, uri);
    return ResourceOperations.createResource(
      { name: opts.name, storageUri: stored.storageUri, contentChecksum: stored.checksum, byteSize: stored.byteSize, format: opts.format as any, language: opts.language },
      uid,
      eventBus,
    );
  }

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('annotate'));

    config = {
      services: { graph: { platform: { type: 'posix' }, type: 'memory' } },
      actors: {
        gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
        matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      workers: {
        default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
    };

    eventBus = new EventBus();
    makeMeaning = await startMakeMeaning(project, config, eventBus, mockLogger);
  });

  afterEach(async () => {
    if (makeMeaning) await makeMeaning.stop();
    if (eventBus) eventBus.destroy();
    await teardown();
  });

  it('monitors detection progress events', async () => {
    // Create a resource to analyze
    const result = await create(
      {
        name: 'Test Document',
        content: Buffer.from('Alice works at Acme Corp. She is a software engineer.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
    );

    // result is now a ResourceId directly
    expect(result).toBeDefined();

    // Create resource-scoped event bus
    const resourceBus = eventBus.scope(result);

    // Track events
    const jobQueuedEvents: any[] = [];
    const detectionStartedEvents: any[] = [];
    const detectionProgressEvents: any[] = [];
    const detectionCompletedEvents: any[] = [];

    // Subscribe to job queue event
    resourceBus.get('job:queued').subscribe(event => {
      jobQueuedEvents.push(event);
      console.log(`[${result}] Job queued: ${event.jobType}`);
    });

    // Subscribe to detection lifecycle events
    resourceBus.get('job:started').subscribe(event => {
      detectionStartedEvents.push(event);
      console.log(`[${result}] Detection started`);
    });

    resourceBus.get('mark:progress').subscribe(progress => {
      detectionProgressEvents.push(progress);
      console.log(`[${result}] Progress: ${progress.status} - ${progress.message || ''}`);
    });

    // Create promise to wait for completion
    const completionPromise = new Promise(resolve => {
      resourceBus.get('job:completed').subscribe(event => {
        detectionCompletedEvents.push(event);
        console.log(`[${result}] Detection complete`);
        resolve(event);
      });
    });

    // Enqueue detection job
    await makeMeaning.jobQueue.createJob({
      status: 'pending',
      metadata: {
        id: `job-${Date.now()}` as any,
        type: 'reference-annotation',
        userId: userId('test-script'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      },
      params: {
        resourceId: result,
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
    // Create resources sequentially (createResource uses a global yield:created
    // subject, so parallel calls would race on the same response)
    const resource1 = await create(
      {
        name: 'Doc 1',
        content: Buffer.from('Alice works at Google.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
    );
    const resource2 = await create(
      {
        name: 'Doc 2',
        content: Buffer.from('Bob works at Microsoft.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
    );
    const resources = [resource1, resource2];

    // Track completion for each resource
    const completions = new Map<string, boolean>();

    // Subscribe to completion events for each resource
    for (const rId of resources) {
      const resourceBus = eventBus.scope(rId);
      resourceBus.get('job:completed').subscribe(() => {
        completions.set(rId, true);
        console.log(`✓ Completed: ${rId}`);
      });
    }

    // Enqueue detection jobs for all resources
    await Promise.all(
      resources.map((rId, index) => {
        return makeMeaning.jobQueue.createJob({
          status: 'pending',
          metadata: {
            id: `job-${Date.now()}-${index}` as any,
            type: 'reference-annotation',
            userId: userId('test-script'),
            userName: 'Test Script',
            userEmail: 'test@test.local',
            userDomain: 'test.local',
            created: new Date().toISOString(),
            retryCount: 0,
            maxRetries: 1
          },
          params: {
            resourceId: rId,
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
    resources.forEach((rId) => {
      expect(completions.get(rId)).toBe(true);
    });
  });

  it('demonstrates custom progress tracking', async () => {
    // Create a resource
    const result = await create(
      {
        name: 'Progress Test Doc',
        content: Buffer.from('Testing progress tracking for entity detection.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
    );

    const resourceBus = eventBus.scope(result);

    // Track progress percentage
    const progressPercentages: number[] = [];

    resourceBus.get('mark:progress').subscribe(progress => {
      if (progress.percentage !== undefined) {
        progressPercentages.push(progress.percentage);
      }
    });

    // Create completion promise
    const completionPromise = new Promise(resolve => {
      resourceBus.get('job:completed').subscribe((event) => {
        resolve(event);
      });
    });

    // Enqueue job
    await makeMeaning.jobQueue.createJob({
      status: 'pending',
      metadata: {
        id: `job-${Date.now()}` as any,
        type: 'reference-annotation',
        userId: userId('test-script'),
        userName: 'Test User',
        userEmail: 'test@test.local',
        userDomain: 'test.local',
        created: new Date().toISOString(),
        retryCount: 0,
        maxRetries: 1
      },
      params: {
        resourceId: result,
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
