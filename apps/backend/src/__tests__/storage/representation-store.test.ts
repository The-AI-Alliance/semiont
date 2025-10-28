/**
 * RepresentationStore Tests
 * Tests for Layer 1 content-addressed representation storage
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesystemRepresentationStore } from '../../storage/representation/representation-store';
import { calculateChecksum } from '@semiont/core';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('FilesystemRepresentationStore', () => {
  let testDir: string;
  let store: FilesystemRepresentationStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-rep-store-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FilesystemRepresentationStore({ basePath: testDir });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('store()', () => {
    it('should store content and return metadata with raw hex checksum', async () => {
      const content = Buffer.from('Hello, World!');
      const expectedChecksum = calculateChecksum(content);

      const result = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Verify checksum is raw hex (no sha256: prefix)
      expect(result.checksum).toBe(expectedChecksum);
      expect(result.checksum).not.toContain(':');
      expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);

      // Verify other metadata
      expect(result.mediaType).toBe('text/plain');
      expect(result.byteSize).toBe(content.length);
      expect(result['@id']).toBe(expectedChecksum);

      // Verify no storageUri
      expect(result).not.toHaveProperty('storageUri');
    });

    it('should use checksum-based sharding for storage', async () => {
      const content = Buffer.from('Test content for sharding');

      const result = await store.store(content, {
        mediaType: 'text/markdown',
        rel: 'original',
      });

      // Verify content is retrievable (proves sharding works)
      const retrieved = await store.retrieve(result.checksum, 'text/markdown');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should be idempotent (same content = same file)', async () => {
      const content = Buffer.from('Idempotent test');

      const result1 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const result2 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Same checksum
      expect(result1.checksum).toBe(result2.checksum);

      // Verify content is retrievable
      const retrieved = await store.retrieve(result1.checksum, 'text/plain');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should create directory structure automatically', async () => {
      const content = Buffer.from('Auto-create dirs');
      const checksum = calculateChecksum(content);
      const ab = checksum.substring(0, 2);
      const cd = checksum.substring(2, 4);

      await store.store(content, {
        mediaType: 'application/json',
        rel: 'derived',
      });

      // Verify directory exists
      const expectedDir = join(testDir, 'representations', 'application~1json', ab, cd);
      const dirExists = await fs.access(expectedDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);
    });
  });

  describe('retrieve()', () => {
    it('should retrieve content by raw hex checksum', async () => {
      const content = Buffer.from('Retrieve me!');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'text/plain');

      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should throw error for non-existent checksum', async () => {
      const fakeChecksum = 'a'.repeat(64); // Valid format but doesn't exist

      await expect(
        store.retrieve(fakeChecksum, 'text/plain')
      ).rejects.toThrow(/not found/i);
    });

    it('should require both checksum AND mediaType for lookup', async () => {
      const content = Buffer.from('Media type matters');
      const stored = await store.store(content, {
        mediaType: 'text/markdown',
        rel: 'original',
      });

      // Should fail with wrong mediaType (different path)
      await expect(
        store.retrieve(stored.checksum, 'text/plain')
      ).rejects.toThrow(/not found/i);

      // Should succeed with correct mediaType
      const retrieved = await store.retrieve(stored.checksum, 'text/markdown');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should reject invalid checksum format', async () => {
      await expect(
        store.retrieve('', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);

      await expect(
        store.retrieve('abc', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);
    });
  });


  describe('Content deduplication', () => {
    it('should deduplicate identical content across different metadata', async () => {
      const content = Buffer.from('Duplicate content test');

      const stored1 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
        language: 'en',
      });

      const stored2 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'derived',
        language: 'es',
      });

      // Same checksum despite different metadata
      expect(stored1.checksum).toBe(stored2.checksum);

      // Content is retrievable
      const retrieved = await store.retrieve(stored1.checksum, 'text/plain');
      expect(retrieved.toString()).toBe(content.toString());
    });
  });

  describe('Checksum format consistency', () => {
    it('should use same checksum format as core calculateChecksum()', async () => {
      const content = Buffer.from('Consistency test');
      const coreChecksum = calculateChecksum(content);

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Should match EXACTLY (no prefix added)
      expect(stored.checksum).toBe(coreChecksum);
      expect(stored.checksum).not.toContain('sha256:');
    });

    it('should reject checksums with sha256: prefix in retrieve', async () => {
      const content = Buffer.from('No prefix allowed');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Old format with prefix should fail
      const oldFormatChecksum = `sha256:${stored.checksum}`;

      await expect(
        store.retrieve(oldFormatChecksum, 'text/plain')
      ).rejects.toThrow();
    });
  });

  describe('Large content handling', () => {
    it('should handle large files (>1MB)', async () => {
      // Create 2MB of content
      const largeContent = Buffer.alloc(2 * 1024 * 1024, 'x');

      const stored = await store.store(largeContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      expect(stored.byteSize).toBe(2 * 1024 * 1024);

      // Verify retrieval
      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(largeContent.length);
    });
  });

  describe('Binary content handling', () => {
    it('should handle binary content correctly', async () => {
      // Create some binary data
      const binaryContent = Buffer.from([0x00, 0xFF, 0xAB, 0xCD, 0xEF]);

      const stored = await store.store(binaryContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');

      expect(retrieved).toEqual(binaryContent);
      expect(retrieved[0]).toBe(0x00);
      expect(retrieved[1]).toBe(0xFF);
    });
  });
});
