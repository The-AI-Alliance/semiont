/**
 * Annotation Context Tests
 *
 * Tests the AnnotationContext class which assembles annotation context
 * from view storage and content store.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { AnnotationContext } from '../annotation-context';
import { resourceId, userId, type EnvironmentConfig, type Logger } from '@semiont/core';
import { createEventStore, FilesystemViewStorage } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock @semiont/inference
const mockInferenceClient = vi.hoisted(() => ({ client: null as any }));

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['']);

  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient
  };
});

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('AnnotationContext', () => {
  let testDir: string;
  let config: EnvironmentConfig;

  beforeEach(() => {
    mockInferenceClient.client.reset();
  });

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-annotation-context-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

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
      }
    } as EnvironmentConfig;
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // Helper to create a test resource
  async function createTestResource(id: string, content: string): Promise<void> {
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir, mockLogger);
    const eventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);

    const testContent = Buffer.from(content, 'utf-8');
    const { checksum } = await repStore.store(testContent, { mediaType: 'text/plain' });

    await eventStore.appendEvent({
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

    // Wait for view to materialize
    const viewStorage = new FilesystemViewStorage(testDir, testDir);
    let attempts = 0;
    while (attempts < 10) {
      try {
        const view = await viewStorage.get(resourceId(id));
        if (view) break;
      } catch (e) {
        // View not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      attempts++;
    }
  }

  // Helper to create an annotation
  async function createTestAnnotation(
    resId: string,
    annId: string,
    exact: string,
    start: number,
    end: number
  ): Promise<void> {
    const eventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);

    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId(resId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: `http://localhost:4000/annotations/${annId}`,
          type: 'Annotation',
          motivation: 'commenting',
          body: {
            type: 'TextualBody',
            value: 'Test comment',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: `http://localhost:4000/resources/${resId}`,
            selector: [{
              type: 'TextPositionSelector',
              start,
              end
            }, {
              type: 'TextQuoteSelector',
              exact,
              prefix: '',
              suffix: ''
            }]
          }
        }
      }
    });

    // Wait for view to update
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  it('should validate contextWindow range', async () => {
    const testResourceId = `resource-validate-${Date.now()}`;
    await createTestResource(testResourceId, 'Test content');

    // Test too small
    await expect(
      AnnotationContext.buildLLMContext(
        'http://localhost:4000/annotations/test-1' as any,
        resourceId(testResourceId),
        config,
        { contextWindow: 50 },
        mockLogger
      )
    ).rejects.toThrow('contextWindow must be between 100 and 5000');

    // Test too large
    await expect(
      AnnotationContext.buildLLMContext(
        'http://localhost:4000/annotations/test-2' as any,
        resourceId(testResourceId),
        config,
        { contextWindow: 6000 },
        mockLogger
      )
    ).rejects.toThrow('contextWindow must be between 100 and 5000');
  });

  it('should handle valid contextWindow values', async () => {
    const testResourceId = `resource-window-${Date.now()}`;
    const testAnnId = `ann-window-${Date.now()}`;
    await createTestResource(testResourceId, 'Some text for context window testing');
    await createTestAnnotation(testResourceId, testAnnId, 'text', 5, 9);

    // Mock the inference call to avoid actual API requests
    mockInferenceClient.client.setResponses(['Mock summary']);

    // Test minimum valid value
    await expect(
      AnnotationContext.buildLLMContext(
        `http://localhost:4000/annotations/${testAnnId}` as any,
        resourceId(testResourceId),
        config,
        { contextWindow: 100 },
        mockLogger
      )
    ).resolves.toBeDefined();

    // Test maximum valid value
    await expect(
      AnnotationContext.buildLLMContext(
        `http://localhost:4000/annotations/${testAnnId}` as any,
        resourceId(testResourceId),
        config,
        { contextWindow: 5000 },
        mockLogger
      )
    ).resolves.toBeDefined();

    // Test mid-range value
    await expect(
      AnnotationContext.buildLLMContext(
        `http://localhost:4000/annotations/${testAnnId}` as any,
        resourceId(testResourceId),
        config,
        { contextWindow: 1500 },
        mockLogger
      )
    ).resolves.toBeDefined();
  });

  it('should build context with default options', async () => {
    const testResourceId = `resource-default-${Date.now()}`;
    const testAnnId = `ann-default-${Date.now()}`;
    await createTestResource(testResourceId, 'The quick brown fox jumps over the lazy dog');
    await createTestAnnotation(testResourceId, testAnnId, 'fox', 16, 19);

    // Mock inference
    mockInferenceClient.client.setResponses(['A test about a fox']);

    const result = await AnnotationContext.buildLLMContext(
      `http://localhost:4000/annotations/${testAnnId}` as any,
      resourceId(testResourceId),
      config,
      {},
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result).toHaveProperty('annotation');
    expect(result).toHaveProperty('sourceResource');
  });

  it('should respect includeSourceContext option', async () => {
    const testResourceId = `resource-source-${Date.now()}`;
    const testAnnId = `ann-source-${Date.now()}`;
    await createTestResource(testResourceId, 'Testing source context inclusion');
    await createTestAnnotation(testResourceId, testAnnId, 'context', 15, 22);

    // Mock inference
    mockInferenceClient.client.setResponses(['Context summary']);

    const withContext = await AnnotationContext.buildLLMContext(
      `http://localhost:4000/annotations/${testAnnId}` as any,
      resourceId(testResourceId),
      config,
      { includeSourceContext: true },
      mockLogger
    );

    const withoutContext = await AnnotationContext.buildLLMContext(
      `http://localhost:4000/annotations/${testAnnId}` as any,
      resourceId(testResourceId),
      config,
      { includeSourceContext: false },
      mockLogger
    );

    expect(withContext).toBeDefined();
    expect(withoutContext).toBeDefined();
    // Both should have basic structure but context presence may differ
  });

  it('should throw error for non-existent resource', async () => {
    await expect(
      AnnotationContext.buildLLMContext(
        'http://localhost:4000/annotations/nonexistent' as any,
        resourceId('nonexistent-resource'),
        config,
        {},
        mockLogger
      )
    ).rejects.toThrow();
  });

  it('should handle annotations without TextPositionSelector', async () => {
    const testResourceId = `resource-no-position-${Date.now()}`;
    const testAnnId = `ann-no-position-${Date.now()}`;
    await createTestResource(testResourceId, 'Content for testing missing selector');

    const eventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);

    // Create annotation with only TextQuoteSelector
    await eventStore.appendEvent({
      type: 'annotation.added',
      resourceId: resourceId(testResourceId),
      userId: userId('user-1'),
      version: 1,
      payload: {
        annotation: {
          '@context': 'http://www.w3.org/ns/anno.jsonld',
          id: `http://localhost:4000/annotations/${testAnnId}`,
          type: 'Annotation',
          motivation: 'commenting',
          body: {
            type: 'TextualBody',
            value: 'Comment without position',
            format: 'text/plain',
            purpose: 'commenting'
          },
          target: {
            source: `http://localhost:4000/resources/${testResourceId}`,
            selector: {
              type: 'TextQuoteSelector',
              exact: 'testing',
              prefix: 'for ',
              suffix: ' missing'
            }
          }
        }
      }
    });

    await new Promise(resolve => setTimeout(resolve, 100));

    // Mock inference
    mockInferenceClient.client.setResponses(['Summary']);

    const result = await AnnotationContext.buildLLMContext(
      `http://localhost:4000/annotations/${testAnnId}` as any,
      resourceId(testResourceId),
      config,
      {},
      mockLogger
    );

    expect(result).toBeDefined();
    expect(result.annotation).toBeDefined();
  });
});
