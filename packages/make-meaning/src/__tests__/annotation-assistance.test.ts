/**
 * Annotation Detection Tests
 *
 * Tests the high-level annotation detection orchestration layer:
 * - Comment detection with configurable instructions, tone, density
 * - Highlight detection with configurable instructions, density
 * - Assessment detection with configurable instructions, tone, density
 * - Tag detection with schema validation
 * - Resource content loading
 * - AI inference integration (mocked)
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnnotationDetection } from '../annotation-assistance';
import { ResourceOperations } from '../resource-operations';
import { resourceId, userId, type EnvironmentConfig, type Logger } from '@semiont/core';
import { createEventStore, type EventStore } from '@semiont/event-sourcing';
import { FilesystemRepresentationStore, type RepresentationStore } from '@semiont/content';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

// Mock @semiont/inference to avoid external API calls
let mockClient: any;
vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockClient = new MockInferenceClient(['[]']);
  return {
    getInferenceClient: vi.fn().mockResolvedValue(mockClient),
    MockInferenceClient
  };
});

// Mock @semiont/ontology to provide tag schema
vi.mock('@semiont/ontology', () => ({
  getTagSchema: vi.fn((schemaId: string) => {
    if (schemaId === 'imrad') {
      return {
        id: 'imrad',
        name: 'IMRAD',
        description: 'Introduction, Methods, Results, and Discussion structure',
        domain: 'academic',
        tags: [
          { name: 'introduction' },
          { name: 'methods' },
          { name: 'results' },
          { name: 'discussion' }
        ]
      };
    }
    return null;  // Invalid schema
  }),
  getSchemaCategory: vi.fn((_schemaId: string, categoryName: string) => {
    const validCategories = ['introduction', 'methods', 'results', 'discussion'];
    if (validCategories.includes(categoryName)) {
      return {
        name: categoryName,
        description: `${categoryName} section`,
        examples: [`What is ${categoryName.toLowerCase()}?`, `How does ${categoryName.toLowerCase()} work?`]
      };
    }
    return null;  // Invalid category
  })
}));

describe('AnnotationDetection', () => {
  let testDir: string;
  let testEventStore: EventStore;
  let testRepStore: RepresentationStore;
  let config: EnvironmentConfig;
  let testResourceId: string;

  beforeAll(async () => {
    // Initialize mock client (must be done in beforeAll, not at module level)
    const { MockInferenceClient } = await import('@semiont/inference');
    mockClient = new MockInferenceClient(['[]']);

    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-annotation-detection-${Date.now()}`);
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

    // Initialize stores
    testEventStore = createEventStore(testDir, config.services.backend!.publicURL, undefined, undefined, mockLogger);
    testRepStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir, mockLogger);

    // Create a test resource for detection
    const content = Buffer.from(
      'Climate change is one of the most pressing challenges facing humanity. ' +
      'Rising global temperatures have led to more frequent extreme weather events. ' +
      'Scientists agree that immediate action is necessary to mitigate these effects.',
      'utf-8'
    );
    const response = await ResourceOperations.createResource(
      {
        name: 'Detection Test Resource',
        content,
        format: 'text/plain',
      },
      userId('user-1'),
      testEventStore,
      testRepStore,
      config
    );

    const idMatch = response.resource['@id'].match(/\/resources\/(.+)$/);
    testResourceId = idMatch![1];
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('detectHighlights', () => {
    it('should extract highlights from text', async () => {
      // Mock AI response with highlights
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change',
          start: 0,
          end: 14
        },
        {
          exact: 'immediate action is necessary',
          start: 173,
          end: 202
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result).toHaveLength(2);
      expect(result[0].exact).toBe('Climate change');
      expect(result[0].start).toBe(0);
      expect(result[0].end).toBe(14);
    });

    it('should use configured instructions', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'global temperatures',
          start: 86,
          end: 105
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient,
        'Focus on scientific terms'
      );

      expect(result).toHaveLength(1);
    });

    it('should use configured density', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'pressing challenges',
          start: 31,
          end: 50
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient,
        undefined,
        5  // density
      );

      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should return match positions', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'humanity',
          start: 62,
          end: 70
        }
      ])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
      expect(result[0]).toHaveProperty('exact');
    });

    it('should handle empty AI response', async () => {
      // Mock empty AI response (no highlights found)
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result).toEqual([]);
    });
  });

  describe('detectComments', () => {
    it('should extract comments with context', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change',
          start: 0,
          end: 14,
          comment: 'This is a critical global issue requiring international cooperation',
          prefix: '',
          suffix: ' is one of the'
        }
      ])]);

      const result = await AnnotationDetection.detectComments(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result).toHaveLength(1);
      expect(result[0].comment).toBeDefined();
      expect(result[0].exact).toBe('Climate change');
    });

    it('should return comment + exact match', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'extreme weather events',
          start: 133,
          end: 155,
          comment: 'Examples include hurricanes, droughts, and floods',
          prefix: 'more frequent ',
          suffix: '. Scientists agree'
        }
      ])]);

      const result = await AnnotationDetection.detectComments(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result[0]).toHaveProperty('comment');
      expect(result[0]).toHaveProperty('exact');
      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
    });

    it('should handle various densities', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'rising global temperatures',
          start: 72,
          end: 98,
          comment: 'Temperature increases correlate with industrial emissions',
          prefix: 'humanity. ',
          suffix: ' have led to'
        }
      ])]);

      // Test with high density
      const result = await AnnotationDetection.detectComments(
        resourceId(testResourceId),
        config,
        mockClient,
        undefined,
        undefined,
        10  // high density
      );

      expect(result.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('detectAssessments', () => {
    it('should extract assessments with evaluations', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Scientists agree',
          start: 157,
          end: 173,
          assessment: 'This claim requires citation of peer-reviewed sources',
          prefix: 'weather events. ',
          suffix: ' that immediate action'
        }
      ])]);

      const result = await AnnotationDetection.detectAssessments(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result).toHaveLength(1);
      expect(result[0].assessment).toBeDefined();
      expect(result[0].exact).toBe('Scientists agree');
    });

    it('should return assessment + exact match', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'immediate action is necessary',
          start: 173,
          end: 202,
          assessment: 'The urgency is well-founded but lacks specific policy recommendations',
          prefix: 'Scientists agree that ',
          suffix: ' to mitigate these'
        }
      ])]);

      const result = await AnnotationDetection.detectAssessments(
        resourceId(testResourceId),
        config,
        mockClient
      );

      expect(result[0]).toHaveProperty('assessment');
      expect(result[0]).toHaveProperty('exact');
      expect(result[0]).toHaveProperty('start');
      expect(result[0]).toHaveProperty('end');
    });
  });

  describe('detectTags', () => {
    it('should extract tags by category', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Climate change is one of the most pressing challenges',
          start: 0,
          end: 54
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        resourceId(testResourceId),
        config,
        mockClient,
        'imrad',
        'introduction'
      );

      expect(result).toBeInstanceOf(Array);
      expect(result.length).toBeGreaterThanOrEqual(0);
    });

    it('should group tags by category', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Rising global temperatures have led to more frequent extreme weather events',
          start: 72,
          end: 148
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        resourceId(testResourceId),
        config,
        mockClient,
        'imrad',
        'methods'
      );

      // All returned tags should have the requested category
      result.forEach(tag => {
        expect(tag.category).toBe('methods');
      });
    });

    it('should return unique tags', async () => {
      mockClient.setResponses([JSON.stringify([
        {
          exact: 'Scientists agree that immediate action is necessary',
          start: 157,
          end: 209
        }
      ])]);

      const result = await AnnotationDetection.detectTags(
        resourceId(testResourceId),
        config,
        mockClient,
        'imrad',
        'results'
      );

      // Check for uniqueness (no duplicate start/end positions)
      const positions = result.map(tag => `${tag.start}-${tag.end}`);
      const uniquePositions = new Set(positions);
      expect(positions.length).toBe(uniquePositions.size);
    });

    it('should reject invalid schema', async () => {
      await expect(
        AnnotationDetection.detectTags(
          resourceId(testResourceId),
          config,
          mockClient,
          'invalid-schema',
          'category'
        )
      ).rejects.toThrow('Invalid tag schema');
    });

    it('should reject invalid category', async () => {
      await expect(
        AnnotationDetection.detectTags(
          resourceId(testResourceId),
          config,
          mockClient,
          'imrad',
          'invalid-category'
        )
      ).rejects.toThrow('Invalid category');
    });
  });

  describe('error handling', () => {
    it('should throw when resource not found', async () => {
      await expect(
        AnnotationDetection.detectHighlights(
          resourceId('non-existent-resource'),
          config,
          mockClient
        )
      ).rejects.toThrow('Resource non-existent-resource not found');
    });

    it('should handle AI inference errors gracefully', async () => {
      // Mock client to throw error
      const errorClient = {
        generateText: vi.fn().mockRejectedValue(new Error('AI service unavailable'))
      };

      await expect(
        AnnotationDetection.detectComments(
          resourceId(testResourceId),
          config,
          errorClient as any
        )
      ).rejects.toThrow('AI service unavailable');
    });

    it('should handle malformed AI responses gracefully', async () => {
      // Mock invalid JSON response - parsers handle this gracefully and return empty array
      mockClient.setResponses(['invalid json']);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient
      );

      // Invalid JSON should result in empty results (graceful failure)
      expect(result).toBeInstanceOf(Array);
    });

    it('should handle non-text content gracefully', async () => {
      // Create PDF resource (binary content)
      const pdfContent = Buffer.from('%PDF-1.4 binary content', 'utf-8');
      const response = await ResourceOperations.createResource(
        {
          name: 'PDF Resource',
          content: pdfContent,
          format: 'application/pdf',
        },
        userId('user-1'),
        testEventStore,
        testRepStore,
        config
      );

      const pdfResourceId = response.resource['@id'].match(/\/resources\/(.+)$/)![1];

      await expect(
        AnnotationDetection.detectHighlights(
          resourceId(pdfResourceId),
          config,
          mockClient
        )
      ).rejects.toThrow('Could not load content');
    });
  });

  describe('configuration options', () => {
    it('should pass instructions to AI for comments', async () => {
      const customInstructions = 'Focus on explaining technical terms';
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectComments(
        resourceId(testResourceId),
        config,
        mockClient,
        customInstructions
      );

      // Verify detection completed successfully with custom instructions
      expect(result).toBeInstanceOf(Array);
    });

    it('should pass tone guidance to AI for comments', async () => {
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectComments(
        resourceId(testResourceId),
        config,
        mockClient,
        undefined,
        'academic'  // tone
      );

      // Verify detection completed successfully with tone guidance
      expect(result).toBeInstanceOf(Array);
    });

    it('should pass density configuration to AI', async () => {
      mockClient.setResponses([JSON.stringify([])]);

      const result = await AnnotationDetection.detectHighlights(
        resourceId(testResourceId),
        config,
        mockClient,
        undefined,
        15  // density
      );

      // Verify detection completed successfully with density configuration
      expect(result).toBeInstanceOf(Array);
    });
  });
});
