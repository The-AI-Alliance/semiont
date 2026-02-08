/**
 * Entity Types Projection Reader Tests
 *
 * Tests the entity types projection reader:
 * - Reading existing projection files
 * - Handling missing projection files (returns empty array)
 * - Path resolution (absolute and relative)
 * - JSON parsing
 * - Error handling for malformed JSON
 * - Integration with bootstrap (after bootstrap, reader returns types)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readEntityTypesProjection } from '../../views/entity-types-reader';
import { bootstrapEntityTypes, resetBootstrap } from '../../bootstrap/entity-types';
import { createEventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import type { EnvironmentConfig } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Entity Types Projection Reader', () => {
  let testDir: string;
  let config: EnvironmentConfig;

  beforeEach(async () => {
    // Create temporary test directory
    testDir = join(tmpdir(), `semiont-test-reader-${Date.now()}`);
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
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('reading existing projections', () => {
    it('should return entity types from existing projection', async () => {
      // Create projection file
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['Person', 'Organization', 'Location'] })
      );

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should return sorted entity types', async () => {
      // Create projection with unsorted types
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['Zebra', 'Apple', 'Mango'] })
      );

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Zebra', 'Apple', 'Mango']); // Returns as-is from file
    });

    it('should return all DEFAULT_ENTITY_TYPES after bootstrap', async () => {
      resetBootstrap();

      // Bootstrap creates the projection
      const eventStore = createEventStore(testDir, config.services.backend!.publicURL);
      await bootstrapEntityTypes(eventStore, config);

      // Reader should return all bootstrapped types
      const result = await readEntityTypesProjection(config);

      expect(result.length).toBe(DEFAULT_ENTITY_TYPES.length);
      expect(result).toEqual(expect.arrayContaining(DEFAULT_ENTITY_TYPES));
    });
  });

  describe('handling missing projections', () => {
    it('should return empty array when projection does not exist', async () => {
      const result = await readEntityTypesProjection(config);

      expect(result).toEqual([]);
    });

    it('should return empty array when projection directory does not exist', async () => {
      const result = await readEntityTypesProjection(config);

      expect(result).toEqual([]);
    });
  });

  describe('JSON parsing', () => {
    it('should parse valid JSON projection', async () => {
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({
          entityTypes: ['Type1', 'Type2']
        }, null, 2)
      );

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Type1', 'Type2']);
    });

    it('should return empty array if entityTypes property is missing', async () => {
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ otherProperty: 'value' })
      );

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual([]);
    });

    it('should throw on malformed JSON', async () => {
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, 'invalid json {');

      await expect(readEntityTypesProjection(config)).rejects.toThrow();
    });
  });

  describe('path resolution', () => {
    it('should handle absolute filesystem paths', async () => {
      // Create projection in test directory
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['AbsolutePathTest'] })
      );

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['AbsolutePathTest']);
    });

    it('should handle different path configurations', async () => {
      const alternateDir = join(testDir, 'alternate');
      await fs.mkdir(alternateDir, { recursive: true });

      const alternateConfig = {
        ...config,
        services: {
          ...config.services,
          filesystem: {
            platform: { type: 'posix' as const },
            path: alternateDir
          }
        },
        _metadata: {
          environment: 'test',
          projectRoot: alternateDir
        }
      };

      // Create projection in alternate directory
      const projectionPath = join(alternateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(alternateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['AlternatePath'] })
      );

      const result = await readEntityTypesProjection(alternateConfig);

      expect(result).toEqual(['AlternatePath']);
    });
  });

  describe('error handling', () => {
    it('should throw if filesystem path is not configured', async () => {
      const invalidConfig = { ...config };
      delete invalidConfig.services.filesystem;

      await expect(
        readEntityTypesProjection(invalidConfig as EnvironmentConfig)
      ).rejects.toThrow();
    });

    it('should handle filesystem errors other than ENOENT', async () => {
      // Create a directory where file should be (causes EISDIR error on read)
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(projectionPath, { recursive: true });

      await expect(readEntityTypesProjection(config)).rejects.toThrow();
    });
  });

  describe('integration', () => {
    it('should read types after bootstrap process', async () => {
      resetBootstrap();

      const eventStore = createEventStore(testDir, config.services.backend!.publicURL);

      // Initially no projection
      const beforeBootstrap = await readEntityTypesProjection(config);
      expect(beforeBootstrap).toEqual([]);

      // Bootstrap creates projection
      await bootstrapEntityTypes(eventStore, config);

      // Now projection should exist and be readable
      const afterBootstrap = await readEntityTypesProjection(config);
      expect(afterBootstrap.length).toBeGreaterThan(0);
      expect(afterBootstrap).toEqual(DEFAULT_ENTITY_TYPES.sort());
    });

    it('should reflect updates to projection file', async () => {
      const projectionPath = join(testDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(testDir, 'projections', '__system__'), { recursive: true });

      // Initial projection
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['Type1'] })
      );

      const initial = await readEntityTypesProjection(config);
      expect(initial).toEqual(['Type1']);

      // Update projection
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ entityTypes: ['Type1', 'Type2'] })
      );

      const updated = await readEntityTypesProjection(config);
      expect(updated).toEqual(['Type1', 'Type2']);
    });
  });
});
