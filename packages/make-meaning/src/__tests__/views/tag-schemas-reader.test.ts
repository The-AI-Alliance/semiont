/**
 * Tag Schemas Projection Reader Tests
 *
 * Mirrors entity-types-reader.test.ts:
 *  - reading existing projections
 *  - missing projection / missing dir → empty array
 *  - JSON parsing edge cases
 *  - integration with the Stower handler (write event → read projection)
 *  - filesystem error pass-through
 *
 * The reader is the consumer side of the same projection ViewMaterializer
 * writes to in `materializeTagSchemas`. End-to-end coverage
 * (Stower.handleAddTagSchema → ViewMaterializer → reader) lives in the
 * integration block at the end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readTagSchemasProjection } from '../../views/tag-schemas-reader';
import { createEventStore } from '@semiont/event-sourcing';
import { type SemiontProject } from '@semiont/core/node';
import {
  EventBus,
  type Logger,
  type GraphServiceConfig,
  type TagSchema,
  userId as makeUserId,
} from '@semiont/core';
import { createKnowledgeBase } from '../../knowledge-base';
import { Stower } from '../../stower';
import { getGraphDatabase } from '@semiont/graph';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createTestProject } from '../helpers/test-project';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger),
};

const SAMPLE_SCHEMA: TagSchema = {
  id: 'sample-schema',
  name: 'Sample Schema',
  description: 'A sample schema for projection-reader tests.',
  domain: 'test',
  tags: [
    { name: 'A', description: 'cat A', examples: ['ex1'] },
    { name: 'B', description: 'cat B', examples: ['ex2'] },
  ],
};

describe('Tag Schemas Projection Reader', () => {
  let project: SemiontProject;
  let teardown: () => Promise<void>;

  beforeEach(async () => {
    ({ project, teardown } = await createTestProject('tag-schemas-reader'));
  });

  afterEach(async () => {
    await teardown();
  });

  describe('reading existing projections', () => {
    it('returns the schemas from an existing projection file', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'tagschemas.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ tagSchemas: [SAMPLE_SCHEMA] }));

      const result = await readTagSchemasProjection(project);

      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe('sample-schema');
      expect(result[0]?.tags.map((t) => t.name)).toEqual(['A', 'B']);
    });

    it('returns multiple schemas in the order they appear in the file', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'tagschemas.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      const second: TagSchema = { ...SAMPLE_SCHEMA, id: 'second', name: 'Second' };
      await fs.writeFile(
        projectionPath,
        JSON.stringify({ tagSchemas: [SAMPLE_SCHEMA, second] }),
      );

      const result = await readTagSchemasProjection(project);

      expect(result.map((s) => s.id)).toEqual(['sample-schema', 'second']);
    });
  });

  describe('handling missing projections', () => {
    it('returns empty array when the projection file does not exist', async () => {
      const result = await readTagSchemasProjection(project);
      expect(result).toEqual([]);
    });

    it('returns empty array when the __system__ directory does not exist', async () => {
      // Fresh project, no __system__ dir at all.
      const result = await readTagSchemasProjection(project);
      expect(result).toEqual([]);
    });
  });

  describe('JSON parsing', () => {
    it('returns empty array if the tagSchemas property is missing', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'tagschemas.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, JSON.stringify({ otherProperty: 'value' }));

      const result = await readTagSchemasProjection(project);
      expect(result).toEqual([]);
    });

    it('throws on malformed JSON', async () => {
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'tagschemas.json');
      await fs.mkdir(join(project.stateDir, 'projections', '__system__'), { recursive: true });
      await fs.writeFile(projectionPath, '{ invalid json');

      await expect(readTagSchemasProjection(project)).rejects.toThrow();
    });
  });

  describe('error handling', () => {
    it('rethrows filesystem errors other than ENOENT', async () => {
      // Create a directory where the file should be — read fails with EISDIR.
      const projectionPath = join(project.stateDir, 'projections', '__system__', 'tagschemas.json');
      await fs.mkdir(projectionPath, { recursive: true });

      await expect(readTagSchemasProjection(project)).rejects.toThrow();
    });
  });

  describe('integration with Stower.handleAddTagSchema', () => {
    // This is the load-bearing test: emitting the write command must
    // produce a projection the reader can serve back. If this fails but
    // the unit-level tests pass, the wiring between Stower / event store /
    // ViewMaterializer / projection file is broken.
    it('reads the schema after Stower handles a frame:add-tag-schema command', async () => {
      const eventBus = new EventBus();
      const eventStore = createEventStore(project, eventBus, mockLogger);
      const graphDb = await getGraphDatabase({ type: 'memory' } as GraphServiceConfig);
      const kb = await createKnowledgeBase(eventStore, project, graphDb, eventBus, mockLogger);
      const stower = new Stower(kb, eventBus, mockLogger);
      await stower.initialize();

      const before = await readTagSchemasProjection(project);
      expect(before).toEqual([]);

      // Drive the registration through the bus, the way the SDK and HTTP
      // gateway do in production. `_userId` is normally injected by the
      // gateway.
      eventBus.get('frame:add-tag-schema').next({
        schema: SAMPLE_SCHEMA,
        _userId: makeUserId('did:web:test:users:test'),
      } as never);

      // The handler is async; wait until the projection materializes.
      // Poll briefly rather than rely on a fixed sleep.
      let after: TagSchema[] = [];
      for (let i = 0; i < 50; i++) {
        after = await readTagSchemasProjection(project);
        if (after.length > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(after).toHaveLength(1);
      expect(after[0]?.id).toBe(SAMPLE_SCHEMA.id);
      expect(after[0]?.tags.map((t) => t.name)).toEqual(['A', 'B']);

      await stower.stop();
      eventBus.destroy();
    });
  });
});
