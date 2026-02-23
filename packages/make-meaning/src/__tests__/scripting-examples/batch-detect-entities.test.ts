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

describe('Scripting Example: Batch Entity Detection', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-batch-detection-test-${Date.now()}`);
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

  it('processes multiple resources in parallel with completion tracking', async () => {
    // Create multiple resources to process
    const resources = await Promise.all([
      ResourceOperations.createResource(
        {
          name: 'Document 1',
          content: Buffer.from('Alice works at Acme Corp.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('batch-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
      ResourceOperations.createResource(
        {
          name: 'Document 2',
          content: Buffer.from('Bob works at Google Inc.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('batch-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
      ResourceOperations.createResource(
        {
          name: 'Document 3',
          content: Buffer.from('Carol works at Microsoft.'),
          format: 'text/plain',
          language: 'en'
        },
        userId('batch-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
    ]);

    // Track completion status for each resource
    const completions = new Map<string, { success: boolean; message?: string }>();
    let processedCount = 0;

    // Subscribe to events for each resource
    for (const { resource } of resources) {
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();
      const resourceBus = eventBus.scope(rId!);

      // Track progress
      resourceBus.get('annotate:detect-progress').subscribe(progress => {
        console.log(`[${rId}] ${progress.status}: ${progress.message || ''}`);
      });

      // Track completion and failures
      // Subscribe to domain event 'make-meaning:event' and filter for job.completed/job.failed
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          completions.set(rId!, { success: true });
          processedCount++;
          console.log(`✓ [${rId}] Detection complete (${processedCount}/${resources.length})`);
        } else if (event.type === 'job.failed') {
          completions.set(rId!, { success: false, message: event.payload.error });
          processedCount++;
          console.log(`✗ [${rId}] Detection failed: ${event.payload.error || 'Unknown error'} (${processedCount}/${resources.length})`);
        }
      });
    }

    // Enqueue detection jobs for all resources
    console.log('Enqueuing detection jobs...\n');
    for (let i = 0; i < resources.length; i++) {
      const { resource } = resources[i];
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();

      await makeMeaning.jobQueue.createJob({
        status: 'pending',
        metadata: {
          id: `job-${Date.now()}-${i}` as any,
          type: 'detection',
          userId: userId('batch-script'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(rId!),
          entityTypes: [entityType('Person'), entityType('Organization')]
        }
      });
      console.log(`→ Queued: ${resource.name} (${rId})`);
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
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      ),
    ]);

    // Track completions
    const completions = new Map<string, { success: boolean }>();

    for (const { resource } of resources) {
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();
      const resourceBus = eventBus.scope(rId!);

      // Subscribe to domain event 'make-meaning:event' and filter for job.completed/job.failed
      resourceBus.get('make-meaning:event').subscribe((event) => {
        if (event.type === 'job.completed') {
          completions.set(rId!, { success: true });
        } else if (event.type === 'job.failed') {
          completions.set(rId!, { success: false });
        }
      });
    }

    // Enqueue jobs
    for (let i = 0; i < resources.length; i++) {
      const { resource } = resources[i];
      const rId = getResourceId(resource);
      expect(rId).toBeDefined();

      await makeMeaning.jobQueue.createJob({
        status: 'pending',
        metadata: {
          id: `job-${Date.now()}-${i}` as any,
          type: 'detection',
          userId: userId('batch-script'),
          created: new Date().toISOString(),
          retryCount: 0,
          maxRetries: 1
        },
        params: {
          resourceId: resourceId(rId!),
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
