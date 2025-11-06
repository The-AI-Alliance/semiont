/**
 * PathBuilder Tests
 * Tests for centralized path construction and sharding
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PathBuilder } from '../../storage/shared/path-builder';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resourceId } from '@semiont/core';

describe('PathBuilder', () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-pathbuilder-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Path Construction', () => {
    it('should build sharded path for resources', () => {
      const builder = new PathBuilder({
        basePath: testDir,
        namespace: 'resources',
      });
      const docId = resourceId('doc-sha256:abc123def456');
      const path = builder.buildPath(docId, '.dat');

      // Should match pattern: testDir/resources/ab/cd/doc-sha256:abc123def456.dat
      expect(path).toContain('resources');
      expect(path).toMatch(/\/[0-9a-f]{2}\/[0-9a-f]{2}\//);
      expect(path).toContain('doc-sha256:abc123def456.dat');
    });

    it('should build sharded path for projections with subnamespace', () => {
      const builder = new PathBuilder({
        basePath: testDir,
        namespace: 'projections',
        subNamespace: 'annotations',
      });
      const docId = resourceId('doc-sha256:abc123def456');
      const path = builder.buildPath(docId, '.json');

      // Should match pattern: testDir/projections/annotations/ab/cd/doc-sha256:abc123def456.json
      expect(path).toContain('projections');
      expect(path).toContain('annotations');
      expect(path).toMatch(/\/[0-9a-f]{2}\/[0-9a-f]{2}\//);
      expect(path).toContain('doc-sha256:abc123def456.json');
    });

    it('should handle different extensions', () => {
      const builder = new PathBuilder({
        basePath: testDir,
        namespace: 'resources',
      });
      const docId = resourceId('doc-sha256:test123');

      const datPath = builder.buildPath(docId, '.dat');
      const jsonPath = builder.buildPath(docId, '.json');
      const txtPath = builder.buildPath(docId, '.txt');

      expect(datPath).toMatch(/\.dat$/);
      expect(jsonPath).toMatch(/\.json$/);
      expect(txtPath).toMatch(/\.txt$/);
    });

    it('should use consistent sharding for same resource ID', () => {
      const builder = new PathBuilder({
        basePath: testDir,
        namespace: 'resources',
      });
      const docId = resourceId('doc-sha256:consistent123');

      const path1 = builder.buildPath(docId, '.dat');
      const path2 = builder.buildPath(docId, '.dat');

      expect(path1).toBe(path2);
    });

    it('should distribute resources across shards', () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'resources' });
      const shards = new Set<string>();

      // Generate 100 resource IDs and check their shard distribution
      for (let i = 0; i < 100; i++) {
        const docId = `doc-sha256:test${i}`;
        const path = builder.buildPath(docId, '.dat');
        const match = path.match(/\/([0-9a-f]{2})\/([0-9a-f]{2})\//);
        if (match) {
          shards.add(`${match[1]}/${match[2]}`);
        }
      }

      // Should use multiple shards (not all in one)
      expect(shards.size).toBeGreaterThan(10);
    });
  });

  describe('Directory Management', () => {
    it('should create shard directories', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'test-docs' });
      const docId = resourceId('doc-sha256:dirtest123');
      const filePath = builder.buildPath(docId, '.dat');

      await builder.ensureDirectory(filePath);

      // Check that directory exists
      const dirPath = join(testDir, 'test-docs');
      const stat = await fs.stat(dirPath);
      expect(stat.isDirectory()).toBe(true);
    });

    it('should handle nested directory creation', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'nested', subNamespace: 'deep' });
      const docId = resourceId('doc-sha256:nested123');
      const filePath = builder.buildPath(docId, '.json');

      await builder.ensureDirectory(filePath);

      // Check that nested directories exist
      const nestedPath = join(testDir, 'nested', 'deep');
      const stat = await fs.stat(nestedPath);
      expect(stat.isDirectory()).toBe(true);
    });
  });

  describe('Resource Scanning', () => {
    it('should scan and find all resources with extension', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'scan-test' });

      // Create test resources
      const docIds = ['doc-1', 'doc-2', 'doc-3'];
      for (const docId of docIds) {
        const filePath = builder.buildPath(docId, '.json');
        await builder.ensureDirectory(filePath);
        await fs.writeFile(filePath, JSON.stringify({ id: docId }));
      }

      // Scan for resources
      const found = await builder.scanForResources('.json');

      expect(found).toHaveLength(3);
      expect(found).toContain('doc-1');
      expect(found).toContain('doc-2');
      expect(found).toContain('doc-3');
    });

    it('should filter by extension when scanning', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'filter-test' });

      // Create resources with different extensions
      const doc1Path = builder.buildPath('doc-json', '.json');
      const doc2Path = builder.buildPath('doc-dat', '.dat');

      await builder.ensureDirectory(doc1Path);
      await builder.ensureDirectory(doc2Path);
      await fs.writeFile(doc1Path, '{}');
      await fs.writeFile(doc2Path, 'data');

      // Scan only for .json files
      const jsonDocs = await builder.scanForResources('.json');
      expect(jsonDocs).toHaveLength(1);
      expect(jsonDocs).toContain('doc-json');

      // Scan only for .dat files
      const datDocs = await builder.scanForResources('.dat');
      expect(datDocs).toHaveLength(1);
      expect(datDocs).toContain('doc-dat');
    });

    it('should return empty array when directory does not exist', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'non-existent' });
      const docs = await builder.scanForResources('.json');

      expect(docs).toEqual([]);
    });

    it('should handle scanning with subnamespace', async () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'with-sub', subNamespace: 'namespace' });

      // Create test resource
      const docId = resourceId('doc-sub-test');
      const filePath = builder.buildPath(docId, '.json');
      await builder.ensureDirectory(filePath);
      await fs.writeFile(filePath, '{}');

      // Scan for resources
      const found = await builder.scanForResources('.json');

      expect(found).toContain('doc-sub-test');
    });
  });

  describe('Sharding Consistency', () => {
    it('should use jump consistent hash for sharding', () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'resources' });

      // These resource IDs should map to specific shards consistently
      const testCases = [
        { id: 'doc-sha256:abc', expectedShard: /\/[0-9a-f]{2}\/[0-9a-f]{2}\// },
        { id: 'doc-sha256:def', expectedShard: /\/[0-9a-f]{2}\/[0-9a-f]{2}\// },
        { id: 'doc-sha256:123', expectedShard: /\/[0-9a-f]{2}\/[0-9a-f]{2}\// },
      ];

      for (const { id, expectedShard } of testCases) {
        const path = builder.buildPath(id, '.dat');
        expect(path).toMatch(expectedShard);

        // Verify consistency
        const path2 = builder.buildPath(id, '.dat');
        expect(path).toBe(path2);
      }
    });

    it('should handle different resource ID formats', () => {
      const builder = new PathBuilder({ basePath: testDir, namespace: 'resources' });

      const formats = [
        'doc-sha256:abc123',
        'ann-sha256:def456',
        'ref-sha256:ghi789',
        'simple-id-123',
      ];

      for (const id of formats) {
        const path = builder.buildPath(id, '.dat');
        expect(path).toMatch(/\/[0-9a-f]{2}\/[0-9a-f]{2}\//);
        expect(path).toContain(id);
      }
    });
  });
});
