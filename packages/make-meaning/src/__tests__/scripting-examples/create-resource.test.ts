/**
 * Scripting Example: Basic Resource Creation
 *
 * Demonstrates how to:
 * - Start make-meaning service without HTTP backend
 * - Create EventBus for event monitoring
 * - Create a resource directly using ResourceOperations
 * - Subscribe to resource-scoped events
 *
 * This pattern is useful for:
 * - Batch resource ingestion scripts
 * - Data migration tools
 * - Testing workflows
 * - Automation pipelines
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventBus } from '@semiont/core';
import { startMakeMeaning, ResourceOperations } from '../..';
import type { EnvironmentConfig } from '@semiont/core';
import { userId, resourceId } from '@semiont/core';
import { getResourceId } from '@semiont/api-client';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Scripting Example: Create Resource', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-scripting-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    // Create test configuration (same pattern as service.test.ts)
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

    // Create EventBus (caller controls this)
    eventBus = new EventBus();

    // Start make-meaning service (no HTTP server)
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

  it('creates a resource and monitors events', async () => {
    // Create resource directly using ResourceOperations
    const result = await ResourceOperations.createResource(
      {
        name: 'Test Document',
        content: Buffer.from('Hello, world!'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    // Verify resource was created
    expect(result.resource).toBeDefined();
    expect(result.resource.name).toBe('Test Document');

    // Verify content was stored (retrieve by checksum, not ID)
    // Note: format and language are in representations, not at top level
    const representations = Array.isArray(result.resource.representations)
      ? result.resource.representations
      : [result.resource.representations];

    expect(representations[0]?.mediaType).toBe('text/plain');
    expect(representations[0]?.language).toBe('en');

    expect(representations).toHaveLength(1);
    const checksum = representations[0]?.checksum;
    expect(checksum).toBeDefined();

    const storedRep = await makeMeaning.repStore.retrieve(checksum!, 'text/plain');
    expect(storedRep).toBeDefined();
    expect(storedRep.toString()).toBe('Hello, world!');
  });

  it('subscribes to resource-scoped domain events', async () => {
    // Track events received
    const domainEvents: any[] = [];

    // Create resource first to get its ID
    const result = await ResourceOperations.createResource(
      {
        name: 'Event Test Document',
        content: Buffer.from('Testing event flow'),
        format: 'text/plain',
        language: 'en'
      },
      userId('test-script'),
      makeMeaning.eventStore,
      makeMeaning.repStore,
      config
    );

    // Subscribe to resource-scoped EventBus for domain events
    const rId = getResourceId(result.resource);
    expect(rId).toBeDefined();
    const resourceBus = eventBus.scope(rId!);

    // Subscribe to the generic domain event channel BEFORE creating the update event
    const sub = resourceBus.get('make-meaning:event').subscribe(event => {
      domainEvents.push(event);
    });

    // Now create another event (like archiving the resource)
    await ResourceOperations.updateResource(
      {
        resourceId: resourceId(rId!),
        userId: userId('test-script'),
        currentArchived: false,
        updatedArchived: true,
      },
      makeMeaning.eventStore
    );

    // Give events time to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify we received the archive event
    expect(domainEvents.length).toBeGreaterThan(0);
    const archiveEvent = domainEvents.find(e => e.type === 'resource.archived');
    expect(archiveEvent).toBeDefined();

    sub.unsubscribe();
  });

  it('demonstrates typical script pattern', async () => {
    // Example: Batch resource creation with progress tracking

    const resources = [
      { name: 'Doc 1', content: 'Content 1' },
      { name: 'Doc 2', content: 'Content 2' },
      { name: 'Doc 3', content: 'Content 3' },
    ];

    const created: string[] = [];

    for (const doc of resources) {
      const result = await ResourceOperations.createResource(
        {
          name: doc.name,
          content: Buffer.from(doc.content),
          format: 'text/plain',
          language: 'en'
        },
        userId('batch-script'),
        makeMeaning.eventStore,
        makeMeaning.repStore,
        config
      );

      const id = getResourceId(result.resource);
      expect(id).toBeDefined();
      created.push(id!);
      console.log(`✓ Created: ${result.resource.name} (${id})`);
    }

    // Verify all were created
    expect(created).toHaveLength(3);

    // Verify all were created successfully
    expect(created.every(id => id.length > 0)).toBe(true);
  });
});
