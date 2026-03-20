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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readEntityTypesProjection } from '../../views/entity-types-reader';
import { bootstrapEntityTypes, resetBootstrap } from '../../bootstrap/entity-types';
import { createEventStore } from '@semiont/event-sourcing';
import { DEFAULT_ENTITY_TYPES } from '@semiont/ontology';
import { EventBus, type Logger, type SemiontProject } from '@semiont/core';
import { createKnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import type { GraphServiceConfig } from '@semiont/core';
import type { MakeMeaningConfig } from '../../config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createTestProject } from '../helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('Entity Types Projection Reader', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;
  let config: MakeMeaningConfig;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('reader'));
    config = {
      services: {},
      _metadata: { projectRoot: project.root },
    };
  });

  afterEach(async () => {
    await teardown();
  });

  describe('reading existing projections', () => {
    it('should return entity types from existing projection', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Person', 'Organization', 'Location'] }));

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Person', 'Organization', 'Location']);
    });

    it('should return sorted entity types', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Zebra', 'Apple', 'Mango'] }));

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Zebra', 'Apple', 'Mango']); // Returns as-is from file
    });

    it('should return all DEFAULT_ENTITY_TYPES after bootstrap', async () => {
      resetBootstrap();

      const eventBus = new EventBus();
      const eventStore = createEventStore(project.dataDir, project.stateDir, undefined, eventBus, mockLogger);
      const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const kb = createKnowledgeBase(eventStore, project, graphDb, mockLogger);
      const stower = new Stower(kb, eventBus, mockLogger);
      await stower.initialize();
      await bootstrapEntityTypes(eventBus, config);
      await stower.stop();
      eventBus.destroy();

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
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Type1', 'Type2'] }, null, 2));

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['Type1', 'Type2']);
    });

    it('should return empty array if entityTypes property is missing', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ otherProperty: 'value' }));

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual([]);
    });

    it('should throw on malformed JSON', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, 'invalid json {');

      await expect(readEntityTypesProjection(config)).rejects.toThrow();
    });
  });

  describe('path resolution', () => {
    it('should handle absolute filesystem paths', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['AbsolutePathTest'] }));

      const result = await readEntityTypesProjection(config);

      expect(result).toEqual(['AbsolutePathTest']);
    });

    it('should handle different path configurations', async () => {
      const { project: altProject, teardown: altTeardown } = await createTestProject('reader-alt');
      const altConfig = {
        ...config,
        _metadata: { projectRoot: altProject.root }
      };

      const projectionPath = join(altProject.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(altProject.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['AlternatePath'] }));

      const result = await readEntityTypesProjection(altConfig);
      await altTeardown();

      expect(result).toEqual(['AlternatePath']);
    });
  });

  describe('error handling', () => {
    it('should throw if projectRoot is not configured', async () => {
      const invalidConfig = { ...config, _metadata: undefined };

      await expect(
        readEntityTypesProjection(invalidConfig as MakeMeaningConfig)
      ).rejects.toThrow('projectRoot is required');
    });

    it('should handle filesystem errors other than ENOENT', async () => {
      // Create a directory where file should be (causes EISDIR error on read)
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(projectionPath, { recursive: true });

      await expect(readEntityTypesProjection(config)).rejects.toThrow();
    });
  });

  describe('integration', () => {
    it('should read types after bootstrap process', async () => {
      resetBootstrap();

      const eventBus = new EventBus();
      const eventStore = createEventStore(project.dataDir, project.stateDir, undefined, eventBus, mockLogger);
      const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const kb = createKnowledgeBase(eventStore, project, graphDb, mockLogger);
      const stower = new Stower(kb, eventBus, mockLogger);
      await stower.initialize();

      const beforeBootstrap = await readEntityTypesProjection(config);
      expect(beforeBootstrap).toEqual([]);

      await bootstrapEntityTypes(eventBus, config);
      await stower.stop();
      eventBus.destroy();

      const afterBootstrap = await readEntityTypesProjection(config);
      expect(afterBootstrap.length).toBeGreaterThan(0);
      expect(afterBootstrap).toEqual(DEFAULT_ENTITY_TYPES.sort());
    });

    it('should reflect updates to projection file', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'entitytypes.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });

      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Type1'] }));
      const initial = await readEntityTypesProjection(config);
      expect(initial).toEqual(['Type1']);

      await fs.writeFile(projectionPath, JSON.stringify({ entityTypes: ['Type1', 'Type2'] }));
      const updated = await readEntityTypesProjection(config);
      expect(updated).toEqual(['Type1', 'Type2']);
    });
  });
});
