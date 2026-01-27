/**
 * Entity Detection Charset Integration Tests
 *
 * Tests that entity detection correctly handles different charsets
 * to prevent annotation offset bugs.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { ReferenceDetectionWorker } from '@semiont/make-meaning';
import { JobQueue } from '@semiont/jobs';
import { FilesystemRepresentationStore } from '@semiont/content';
import type { components } from '@semiont/api-client';
import type { EnvironmentConfig } from '@semiont/core';
import { createEventStore } from '@semiont/event-sourcing';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

type ResourceDescriptor = components['schemas']['ResourceDescriptor'];

// Mock the AI entity extractor to just find known entity strings
vi.mock('@semiont/inference', () => ({
  extractEntities: vi.fn(async (text: string, entityTypes: string[]) => {
    // Simple mock: find entity type names in the text
    const entities: any[] = [];

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
  }),
}));

describe('Entity Detection - Charset Handling', () => {
  let testDir: string;
  let config: EnvironmentConfig;
  let worker: ReferenceDetectionWorker;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-test-charset-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    config = {
      services: {
        filesystem: {
          platform: { type: 'posix' },
          path: testDir
        },
        backend: {
          publicURL: 'http://localhost:4000'
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

    const jobQueue = new JobQueue({ dataDir: config.services.filesystem!.path });
    await jobQueue.initialize();
    const eventStore = createEventStore(config.services.filesystem!.path, config.services.backend!.publicURL);
    worker = new ReferenceDetectionWorker(jobQueue, config, eventStore);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  /**
   * REGRESSION TEST: Entity detection with UTF-8 content
   */
  it('should correctly detect entities in UTF-8 text with multibyte characters', async () => {
    // Create UTF-8 content with Chinese characters
    const text = 'The Person works in Location with 世界 background';
    const mediaType = 'text/plain; charset=utf-8';
    const buffer = Buffer.from(text, 'utf8');

    // Store representation
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(buffer, { mediaType });
    const checksum = stored.checksum;

    // Create resource descriptor
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-utf8',
      '@type': 'ResourceDescriptor',
      name: 'UTF-8 Test',
      representations: [{
        rel: 'original',
        mediaType,
        checksum,
      }],
    };

    // Detect entities
    const results = await worker.detectReferences(resource, ['Person', 'Location']);

    // Verify entity offsets match original text
    expect(results).toHaveLength(2);

    const personAnnotation = results.find(r => r.annotation.entityTypes.includes('Person'));
    expect(personAnnotation).toBeDefined();
    expect(personAnnotation!.annotation.selector.exact).toBe('Person');
    expect(text.substring(
      personAnnotation!.annotation.selector.start,
      personAnnotation!.annotation.selector.end
    )).toBe('Person');

    const locationAnnotation = results.find(r => r.annotation.entityTypes.includes('Location'));
    expect(locationAnnotation).toBeDefined();
    expect(locationAnnotation!.annotation.selector.exact).toBe('Location');
    expect(text.substring(
      locationAnnotation!.annotation.selector.start,
      locationAnnotation!.annotation.selector.end
    )).toBe('Location');
  });

  /**
   * REGRESSION TEST: Entity detection with ISO-8859-1 (Latin-1) content
   *
   * This is the critical test that would have caught the original bug:
   * - If entity detection uses UTF-8 but content is ISO-8859-1
   * - Characters like é are 1 byte in ISO-8859-1 but 2 bytes in UTF-8
   * - Offsets will be wrong and annotations will highlight wrong text
   */
  it('should correctly detect entities in ISO-8859-1 text with extended Latin characters', async () => {
    // Create ISO-8859-1 content with extended Latin characters
    const text = 'The café serves résumé to Person in París Location';
    const mediaType = 'text/plain; charset=iso-8859-1';
    const buffer = Buffer.from(text, 'latin1');

    // Store representation
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(buffer, { mediaType });
    const checksum = stored.checksum;

    // Create resource descriptor
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-latin1',
      '@type': 'ResourceDescriptor',
      name: 'Latin-1 Test',
      representations: [{
        rel: 'original',
        mediaType,
        checksum,
      }],
    };

    // Detect entities
    const results = await worker.detectReferences(resource, ['Person', 'Location']);

    // Verify entity offsets match original text
    expect(results).toHaveLength(2);

    const personAnnotation = results.find(r => r.annotation.entityTypes.includes('Person'));
    expect(personAnnotation).toBeDefined();
    expect(personAnnotation!.annotation.selector.exact).toBe('Person');

    // Critical: verify offset points to correct position in ISO-8859-1 string
    const personText = text.substring(
      personAnnotation!.annotation.selector.start,
      personAnnotation!.annotation.selector.end
    );
    expect(personText).toBe('Person');

    const locationAnnotation = results.find(r => r.annotation.entityTypes.includes('Location'));
    expect(locationAnnotation).toBeDefined();
    expect(locationAnnotation!.annotation.selector.exact).toBe('Location');

    // Critical: verify offset after extended Latin characters (café, résumé, París)
    const locationText = text.substring(
      locationAnnotation!.annotation.selector.start,
      locationAnnotation!.annotation.selector.end
    );
    expect(locationText).toBe('Location');
  });

  /**
   * REGRESSION TEST: Entity detection with Windows-1252 content
   */
  it('should correctly detect entities in Windows-1252 text', async () => {
    // Windows-1252 includes smart quotes and other characters
    const text = 'The Person said "Location" with –dashes–';
    const mediaType = 'text/plain; charset=windows-1252';
    const buffer = Buffer.from(text, 'latin1'); // Windows-1252 is a superset of Latin-1

    // Store representation
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(buffer, { mediaType });
    const checksum = stored.checksum;

    // Create resource descriptor
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-win1252',
      '@type': 'ResourceDescriptor',
      name: 'Windows-1252 Test',
      representations: [{
        rel: 'original',
        mediaType,
        checksum,
      }],
    };

    // Detect entities
    const results = await worker.detectReferences(resource, ['Person', 'Location']);

    // Verify offsets are correct
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
   * REGRESSION TEST: Mixed content with complex entity positions
   *
   * This test simulates a realistic scenario where entities appear
   * at various positions in text with extended characters.
   */
  it('should maintain correct offsets for entities at different positions in ISO-8859-1 text', async () => {
    // Text with entities before, between, and after extended Latin characters
    const text = 'Person López works at Café de París Location serving résumé to another Person';
    const mediaType = 'text/plain; charset=iso-8859-1';
    const buffer = Buffer.from(text, 'latin1');

    // Store representation
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(buffer, { mediaType });
    const checksum = stored.checksum;

    // Create resource descriptor
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-complex',
      '@type': 'ResourceDescriptor',
      name: 'Complex Latin-1 Test',
      representations: [{
        rel: 'original',
        mediaType,
        checksum,
      }],
    };

    // Detect entities
    const results = await worker.detectReferences(resource, ['Person', 'Location']);

    // Should find 2 Person entities and 1 Location entity
    expect(results).toHaveLength(3);

    const personResults = results.filter(r => r.annotation.entityTypes.includes('Person'));
    expect(personResults).toHaveLength(2);

    const locationResults = results.filter(r => r.annotation.entityTypes.includes('Location'));
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
   * REGRESSION TEST: Verify charset is respected from mediaType
   */
  it('should respect charset from resource mediaType, not assume UTF-8', async () => {
    // Same byte sequence, different interpretations based on charset
    const textLatin1 = 'café'; // 4 characters in Latin-1
    const bufferLatin1 = Buffer.from(textLatin1, 'latin1');

    // Store as Latin-1
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(bufferLatin1, { mediaType: 'text/plain; charset=iso-8859-1' });
    const checksum = stored.checksum;

    // Create resource with explicit ISO-8859-1 charset
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-charset-respect',
      '@type': 'ResourceDescriptor',
      name: 'Charset Respect Test',
      representations: [{
        rel: 'original',
        mediaType: 'text/plain; charset=iso-8859-1',
        checksum,
      }],
    };

    // Mock entity extractor to find "café"
    const { extractEntities } = await import('@semiont/inference');
    (extractEntities as any).mockImplementationOnce(async (text: string) => {
      const index = text.indexOf('café');
      if (index === -1) return [];
      return [{
        exact: 'café',
        entityType: 'Place',
        startOffset: index,
        endOffset: index + 4, // 4 characters in Latin-1
      }];
    });

    // Detect entities
    const results = await worker.detectReferences(resource, ['Place']);

    // Should find the entity with correct offset
    expect(results).toHaveLength(1);
    expect(results[0]?.annotation.selector.exact).toBe('café');
    expect(results[0]?.annotation.selector.start).toBe(0);
    expect(results[0]?.annotation.selector.end).toBe(4);

    // Verify the offset works correctly with the same encoding
    const retrievedBuffer = await repStore.retrieve(checksum, 'text/plain; charset=iso-8859-1');
    const retrievedText = retrievedBuffer!.toString('latin1');
    const extractedEntity = retrievedText.substring(
      results[0]?.annotation.selector.start ?? 0,
      results[0]?.annotation.selector.end ?? 0
    );
    expect(extractedEntity).toBe('café');
  });

  /**
   * REGRESSION TEST: Content without explicit charset defaults to UTF-8
   */
  it('should default to UTF-8 when charset is not specified', async () => {
    const text = 'Person works in Location';
    const buffer = Buffer.from(text, 'utf8');

    // Store without charset in mediaType
    const repStore = new FilesystemRepresentationStore({ basePath: testDir }, testDir);
    const stored = await repStore.store(buffer, { mediaType: 'text/plain' });
    const checksum = stored.checksum;

    // Create resource without charset
    const resource: ResourceDescriptor = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'urn:semiont:resource:test-no-charset',
      '@type': 'ResourceDescriptor',
      name: 'No Charset Test',
      representations: [{
        rel: 'original',
        mediaType: 'text/plain', // No charset parameter
        checksum,
      }],
    };

    // Detect entities
    const results = await worker.detectReferences(resource, ['Person', 'Location']);

    // Should still work correctly with UTF-8 default
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
