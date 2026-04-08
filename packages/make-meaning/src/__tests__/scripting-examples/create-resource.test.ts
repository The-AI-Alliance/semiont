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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger, userId } from '@semiont/core';
import { startMakeMeaning, ResourceOperations, type MakeMeaningConfig } from '../..';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('Scripting Example: Create Resource', () => {
  let testDir: string;
  let project: SemiontProject;
  let config: MakeMeaningConfig;
  let makeMeaning: Awaited<ReturnType<typeof startMakeMeaning>>;
  let eventBus: EventBus;

  beforeEach(async () => {
    testDir = join(tmpdir(), `semiont-scripting-test-${uuidv4()}`);
    await fs.mkdir(testDir, { recursive: true });
    project = new SemiontProject(testDir);

    config = {
      services: {
        graph: {
          platform: { type: 'posix' },
          type: 'memory'
        }
      },
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
      eventBus,
    );

    // Verify resource was created — result is now a ResourceId directly
    expect(result).toBeDefined();

    // Verify via event store
    const events = await makeMeaning.knowledgeSystem.kb.eventStore.log.getEvents(result);
    const createdEvent = events.find(e => e.type === 'yield:created');
    expect(createdEvent).toBeDefined();
    expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.name).toBe('Test Document');
    expect(createdEvent!.type === 'yield:created' && createdEvent!.payload.format).toBe('text/plain');

    // Verify content was stored (retrieve by storageUri from event payload)
    const storageUri = createdEvent!.type === 'yield:created'
      ? createdEvent!.payload.storageUri
      : undefined;
    expect(storageUri).toBeDefined();

    const storedRep = await makeMeaning.knowledgeSystem.kb.content.retrieve(storageUri!);
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
      eventBus,
    );

    // Subscribe to resource-scoped EventBus for domain events
    // result is already a ResourceId
    const resourceBus = eventBus.scope(result);

    // Subscribe to typed domain event channels BEFORE creating the update event
    const subs = (['yield:updated', 'mark:archived', 'mark:unarchived'] as const).map(type =>
      resourceBus.get(type).subscribe(event => { domainEvents.push(event); })
    );

    // Now create another event (like archiving the resource)
    await ResourceOperations.updateResource(
      {
        resourceId: result,
        userId: userId('test-script'),
        currentArchived: false,
        updatedArchived: true,
      },
      eventBus,
    );

    // Give events time to propagate
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verify we received the archive event
    expect(domainEvents.length).toBeGreaterThan(0);
    const archiveEvent = domainEvents.find(e => e.type === 'mark:archived');
    expect(archiveEvent).toBeDefined();

    subs.forEach(s => s.unsubscribe());
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
        eventBus,
      );

      // result is already a ResourceId
      expect(result).toBeDefined();
      created.push(result);
      console.log(`✓ Created: ${doc.name} (${result})`);
    }

    // Verify all were created
    expect(created).toHaveLength(3);

    // Verify all were created successfully
    expect(created.every(id => id.length > 0)).toBe(true);
  });
});
