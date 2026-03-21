/**
 * Entity Detection Charset Tests
 *
 * Tests that entity detection correctly handles different charsets
 * to prevent annotation offset bugs.
 *
 * Now that detectReferences takes content as a string (charset handling
 * is done by ContentFetcher upstream), these tests verify that offset
 * calculation works correctly for strings containing multibyte and
 * extended Latin characters.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ReferenceAnnotationWorker, type DetectedAnnotation } from '../../../workers/reference-annotation-worker';
import { JobQueue, type ContentFetcher } from '@semiont/jobs';
import { SemiontProject } from '@semiont/core/node';
import { EventBus, type Logger } from '@semiont/core';

import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';


// Mock inference to avoid actual API calls
const mockInferenceClient = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: null as any };
});

vi.mock('@semiont/inference', async () => {
  const { MockInferenceClient } = await import('@semiont/inference');
  mockInferenceClient.client = new MockInferenceClient(['Mock AI response']);

  return {
    generateText: vi.fn().mockResolvedValue('Mock AI response'),
    getInferenceClient: vi.fn().mockResolvedValue(mockInferenceClient.client),
    MockInferenceClient
  };
});

// Mock the AI entity extractor to find known entity strings in text
vi.mock('../../../workers/detection/entity-extractor', () => ({
  extractEntities: vi.fn(async (text: string, entityTypes: string[]) => {
    // Simple mock: find entity type names in the text
    const entities: Array<{ exact: string; entityType: string; startOffset: number; endOffset: number }> = [];

    for (const entityType of entityTypes) {
      // Look for the entity type name in the text (case-sensitive)
      let index = text.indexOf(entityType);
      while (index !== -1) {
        entities.push({
          exact: entityType,
          entityType: entityType,
          startOffset: index,
          endOffset: index + entityType.length,
        });
        index = text.indexOf(entityType, index + 1);
      }
    }

    return entities;
  })
}));

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

const mockContentFetcher: ContentFetcher = async () => {
  const { Readable } = await import('stream');
  return Readable.from([Buffer.from('test content')]);
};

describe('Entity Detection - Charset Handling', () => {
  let testDir: string;
  let worker: ReferenceAnnotationWorker;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-charset-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const jobQueue = new JobQueue(new SemiontProject(testDir), mockLogger, new EventBus());
    await jobQueue.initialize();
    worker = new ReferenceAnnotationWorker(jobQueue, mockInferenceClient.client, new EventBus(), mockContentFetcher, mockLogger);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /**
   * Test: Entity detection with UTF-8 content containing multibyte characters
   */
  it('should correctly detect entities in UTF-8 text with multibyte characters', async () => {
    const text = 'The Person works in Location with 世界 background';

    const results = await worker.detectReferences(text, ['Person', 'Location']);

    expect(results).toHaveLength(2);

    const personAnnotation = results.find((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Person'));
    expect(personAnnotation).toBeDefined();
    expect(personAnnotation!.annotation.selector.exact).toBe('Person');
    expect(text.substring(
      personAnnotation!.annotation.selector.start,
      personAnnotation!.annotation.selector.end
    )).toBe('Person');

    const locationAnnotation = results.find((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Location'));
    expect(locationAnnotation).toBeDefined();
    expect(locationAnnotation!.annotation.selector.exact).toBe('Location');
    expect(text.substring(
      locationAnnotation!.annotation.selector.start,
      locationAnnotation!.annotation.selector.end
    )).toBe('Location');
  });

  /**
   * Test: Entity detection with extended Latin characters
   *
   * Since detectReferences now takes a string, charset handling is upstream.
   * This tests that offsets are correct when the string contains accented characters.
   */
  it('should correctly detect entities in text with extended Latin characters', async () => {
    const text = 'The café serves résumé to Person in París Location';

    const results = await worker.detectReferences(text, ['Person', 'Location']);

    expect(results).toHaveLength(2);

    const personAnnotation = results.find((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Person'));
    expect(personAnnotation).toBeDefined();
    expect(personAnnotation!.annotation.selector.exact).toBe('Person');
    const personText = text.substring(
      personAnnotation!.annotation.selector.start,
      personAnnotation!.annotation.selector.end
    );
    expect(personText).toBe('Person');

    const locationAnnotation = results.find((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Location'));
    expect(locationAnnotation).toBeDefined();
    expect(locationAnnotation!.annotation.selector.exact).toBe('Location');
    const locationText = text.substring(
      locationAnnotation!.annotation.selector.start,
      locationAnnotation!.annotation.selector.end
    );
    expect(locationText).toBe('Location');
  });

  /**
   * Test: Entity detection with smart quotes and dashes
   */
  it('should correctly detect entities in text with special punctuation', async () => {
    const text = 'The Person said \u201cLocation\u201d with \u2013dashes\u2013';

    const results = await worker.detectReferences(text, ['Person', 'Location']);

    expect(results).toHaveLength(2);

    for (const result of results) {
      const extractedText = text.substring(
        result.annotation.selector.start,
        result.annotation.selector.end
      );
      expect(extractedText).toBe(result.annotation.selector.exact);
    }
  });

  /**
   * Test: Mixed content with complex entity positions
   *
   * Entities appear at various positions relative to extended characters.
   */
  it('should maintain correct offsets for entities at different positions in accented text', async () => {
    const text = 'Person López works at Café de París Location serving résumé to another Person';

    const results = await worker.detectReferences(text, ['Person', 'Location']);

    // Should find 2 Person entities and 1 Location entity
    expect(results).toHaveLength(3);

    const personResults = results.filter((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Person'));
    expect(personResults).toHaveLength(2);

    const locationResults = results.filter((r: DetectedAnnotation) => r.annotation.entityTypes.includes('Location'));
    expect(locationResults).toHaveLength(1);

    // Verify all offsets point to correct text
    for (const result of results) {
      const extractedText = text.substring(
        result.annotation.selector.start,
        result.annotation.selector.end
      );
      expect(extractedText).toBe(result.annotation.selector.exact);
      expect(extractedText).toMatch(/^(Person|Location)$/);
    }
  });

  /**
   * Test: Entity detection with special characters like café
   */
  it('should detect entities containing accented characters', async () => {
    // Mock entity extractor to find "café"
    const { extractEntities } = await import('../../../workers/detection/entity-extractor');
    (extractEntities as ReturnType<typeof vi.fn>).mockImplementationOnce(async (text: string) => {
      const index = text.indexOf('café');
      if (index === -1) return [];
      return [{
        exact: 'café',
        entityType: 'Place',
        startOffset: index,
        endOffset: index + 4,
      }];
    });

    const text = 'café is a nice place';
    const results = await worker.detectReferences(text, ['Place']);

    expect(results).toHaveLength(1);
    expect(results[0]?.annotation.selector.exact).toBe('café');
    expect(results[0]?.annotation.selector.start).toBe(0);
    expect(results[0]?.annotation.selector.end).toBe(4);

    const extractedEntity = text.substring(
      results[0]?.annotation.selector.start ?? 0,
      results[0]?.annotation.selector.end ?? 0
    );
    expect(extractedEntity).toBe('café');
  });

  /**
   * Test: Plain ASCII text (baseline)
   */
  it('should correctly detect entities in plain ASCII text', async () => {
    const text = 'Person works in Location';

    const results = await worker.detectReferences(text, ['Person', 'Location']);

    expect(results).toHaveLength(2);
    for (const result of results) {
      const extractedText = text.substring(
        result.annotation.selector.start,
        result.annotation.selector.end
      );
      expect(extractedText).toBe(result.annotation.selector.exact);
    }
  });
});
