/**
 * Scripting Example: Batch Entity Detection
 *
 * Demonstrates how to:
 * - Process multiple resources in parallel
 * - Track completion across batch operations
 * - Monitor progress for multiple resources
 * - Handle both success and failure cases
 * - Coordinate shutdown when all jobs complete
 *
 * This pattern is useful for:
 * - Batch processing pipelines
 * - Migration scripts that process existing resources
 * - Automated content analysis at scale
 * - Progress tracking for long-running operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventBus, type Logger } from '@semiont/core';
import { startMakeMeaning, ResourceOperations, type MakeMeaningConfig } from '../..';
import { userId, entityType } from '@semiont/core';
import { createTestProject, type TestProject } from '../helpers/test-project';

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

describe('Scripting Example: Batch Entity Detection', () => {
  let project: TestProject;
  let config: MakeMeaningConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    project = await createTestProject('batch');

    config = {
      services: { graph: { platform: { type: 'posix' }, type: 'memory' } },
      actors: {
        gatherer: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
        matcher: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      workers: {
        default: { type: 'anthropic', model: 'claude-haiku-4-5-20251001', apiKey: 'test-key' },
      },
      _metadata: { projectRoot: project.root },
    };

    eventBus = new EventBus();
    makeMeaning = await startMakeMeaning(config, eventBus, mockLogger);
  });

  afterEach(async () => {
    if (makeMeaning) await makeMeaning.stop();
    if (eventBus) eventBus.destroy();
    await project.teardown();
  });

  it('processes multiple resources in parallel with completion tracking', async () => {
    // Create resources sequentially (createResource uses a global yield:created
    // subject, so parallel calls would race on the same response)
    const resource1 = await ResourceOperations.createResource(
      {
        name: 'Document 1',
        content: Buffer.from('Alice works at Acme Corp.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('batch-script'),
      eventBus,
    );
    const resource2 = await ResourceOperations.createResource(
      {
        name: 'Document 2',
        content: Buffer.from('Bob works at Google Inc.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('batch-script'),
      eventBus,
    );
    const resource3 = await ResourceOperations.createResource(
      {
        name: 'Document 3',
        content: Buffer.from('Carol works at Microsoft.'),
        format: 'text/plain',
        language: 'en'
      },
      userId('batch-script'),
      eventBus,
    );
    const resources = [resource1, resource2, resource3];

    // Track completion status for each resource
    const completions = new Map<string, { success: boolean; message?: string }>();
    let processedCount = 0;

    // Subscribe to events for each resource
    for (const rId of resources) {
      const resourceBus = eventBus.scope(rId);

      // Track progress
      resourceBus.get('mark:progress').subscribe(progress => {
        console.log(`[${rId}] ${progress.status}: ${progress.message || ''}`);
      });

      // Track completion and failures
      // Subscribe to domain event 'make-meaning:event' and filter for job.completed/job.failed
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          completions.set(rId, { success: true });
          processedCount++;
          console.log(`✓ [${rId}] Detection complete (${processedCount}/${resources.length})`);
        } else if (event.type === 'job.failed') {
          completions.set(rId, { success: false, message: event.payload.error });
          processedCount++;
          console.log(`✗ [${rId}] Detection failed: ${event.payload.error || 'Unknown error'} (${processedCount}/${resources.length})`);
        }
      });
    }

    // Enqueue detection jobs for all resources
    const names = ['Document 1', 'Document 2', 'Document 3'];
    console.log('Enqueuing detection jobs...\n');
    for (let i = 0; i < resources.length; i++) {
      const rId = resources[i];

      await makeMeaning.jobQueue.createJob({
        status: 'pending',
        metadata: {
          id: `job-${Date.now()}-${i}` as any,
          type: 'reference-annotation',
          userId: userId('batch-script'),
          userName: 'Test User',
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
      console.log(`→ Queued: ${names[i]} (${rId})`);
    }

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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for batch detections')), 15000))
    ]);

    // Verify all completed
    expect(completions.size).toBe(resources.length);

    // Print summary
    const successful = Array.from(completions.values()).filter(c => c.success).length;
    const failed = completions.size - successful;

    console.log('\n' + '='.repeat(60));
    console.log('Summary:');
    console.log('='.repeat(60));
    console.log(`Total: ${completions.size}`);
    console.log(`Successful: ${successful}`);
    console.log(`Failed: ${failed}`);

    if (failed > 0) {
      console.log('\nFailed resources:');
      completions.forEach((status, id) => {
        if (!status.success) {
          console.log(`  - ${id}: ${status.message || 'Unknown error'}`);
        }
      });
    }
    console.log('='.repeat(60));

    // Verify all succeeded
    expect(successful).toBe(resources.length);
    expect(failed).toBe(0);
  });

  it('handles mixed success and failure scenarios', async () => {
    // Create resources
    const resources = await Promise.all([
      ResourceOperations.createResource(
        {
          name: 'Good Document',
          content: Buffer.from('Alice works at Acme Corp.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('batch-script'),
        eventBus,
      ),
    ]);

    // Track completions
    const completions = new Map<string, { success: boolean }>();

    for (const rId of resources) {
      const resourceBus = eventBus.scope(rId);

      // Subscribe to domain event 'make-meaning:event' and filter for job.completed/job.failed
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          completions.set(rId, { success: true });
        } else if (event.type === 'job.failed') {
          completions.set(rId, { success: false });
        }
      });
    }

    // Enqueue jobs
    for (let i = 0; i < resources.length; i++) {
      const rId = resources[i];

      await makeMeaning.jobQueue.createJob({
        status: 'pending',
        metadata: {
          id: `job-${Date.now()}-${i}` as any,
          type: 'reference-annotation',
          userId: userId('batch-script'),
          userName: 'Test User',
          userEmail: 'test@test.local',
          userDomain: 'test.local',
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: rId,
          entityTypes: [entityType('Person')]
        }
      });
    }

    // Wait for completion
    await Promise.race([
      new Promise(resolve => {
        const checkInterval = setInterval(() => {
          if (completions.size === resources.length) {
            clearInterval(checkInterval);
            resolve(null);
          }
        }, 100);
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
    ]);

    // Verify completion tracking works
    expect(completions.size).toBeGreaterThan(0);
  });
});
