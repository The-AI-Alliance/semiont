/**
 * RepresentationStore Tests
 * Tests for content-addressed representation storage
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FilesystemRepresentationStore } from '../representation-store';
import { calculateChecksum } from '../checksum';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Logger } from '@semiont/core';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(() => mockLogger)
};

describe('FilesystemRepresentationStore', () => {
  let testDir: string;
  let store: FilesystemRepresentationStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-rep-store-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FilesystemRepresentationStore({ basePath: testDir }, undefined, mockLogger);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Constructor', () => {
    it('should accept absolute basePath', () => {
      const absolutePath = join(tmpdir(), 'test-absolute');
      const testStore = new FilesystemRepresentationStore({ basePath: absolutePath }, undefined, mockLogger);
      expect(testStore).toBeDefined();
    });

    it('should resolve relative basePath against projectRoot', () => {
      const projectRoot = tmpdir();
      const relativePath = 'data/representations';
      const testStore = new FilesystemRepresentationStore({ basePath: relativePath }, projectRoot, mockLogger);
      expect(testStore).toBeDefined();
    });

    it('should resolve relative basePath against cwd when no projectRoot', () => {
      const relativePath = 'data';
      const testStore = new FilesystemRepresentationStore({ basePath: relativePath }, undefined, mockLogger);
      expect(testStore).toBeDefined();
    });

    it('should normalize paths with trailing slashes', () => {
      const pathWithSlash = join(tmpdir(), 'test-trailing/');
      const testStore = new FilesystemRepresentationStore({ basePath: pathWithSlash }, undefined, mockLogger);
      expect(testStore).toBeDefined();
    });
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

  describe('Edge cases', () => {
    it('should reject invalid checksums in store', async () => {
      const checksumModule = await import('../checksum');

      // Test empty checksum
      vi.spyOn(checksumModule, 'calculateChecksum').mockReturnValueOnce('');
      await expect(
        store.store(Buffer.from('test'), { mediaType: 'text/plain', rel: 'original' })
      ).rejects.toThrow(/invalid checksum/i);

      // Test checksum too short
      vi.spyOn(checksumModule, 'calculateChecksum').mockReturnValueOnce('abc');
      await expect(
        store.store(Buffer.from('test'), { mediaType: 'text/plain', rel: 'original' })
      ).rejects.toThrow(/invalid checksum/i);

      vi.restoreAllMocks();
    });

    it('should handle filesystem errors beyond ENOENT', async () => {
      const content = Buffer.from('Test content');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Mock fs.readFile to throw a non-ENOENT error
      const fsModule = await import('fs');
      const error = new Error('Permission denied');
      (error as any).code = 'EACCES';
      vi.spyOn(fsModule.promises, 'readFile').mockRejectedValueOnce(error);

      await expect(
        store.retrieve(stored.checksum, 'text/plain')
      ).rejects.toThrow('Permission denied');

      vi.restoreAllMocks();
    });

    it('should handle empty content (zero bytes)', async () => {
      const emptyContent = Buffer.from('');

      const stored = await store.store(emptyContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      expect(stored.byteSize).toBe(0);

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(0);
    });

    it('should handle content with null bytes', async () => {
      const contentWithNulls = Buffer.from([0x00, 0x00, 0x61, 0x00, 0x62]);

      const stored = await store.store(contentWithNulls, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved).toEqual(contentWithNulls);
    });

    it('should store with charset parameter in mediaType', async () => {
      const content = Buffer.from('Test content with charset');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
      });

      expect(stored.mediaType).toBe('text/plain; charset=utf-8');

      // Should be retrievable with same mediaType
      const retrieved = await store.retrieve(stored.checksum, 'text/plain; charset=utf-8');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should store with multiple parameters in mediaType', async () => {
      const content = Buffer.from('Boundary test');

      const stored = await store.store(content, {
        mediaType: 'multipart/form-data; boundary=----WebKitFormBoundary; charset=utf-8',
        rel: 'original',
      });

      expect(stored.mediaType).toContain('boundary');
      expect(stored.mediaType).toContain('charset');
    });

    it('should handle whitespace in mediaType on retrieve', async () => {
      const content = Buffer.from('Whitespace test');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Should work with whitespace
      const retrieved = await store.retrieve(stored.checksum, '  text/plain  ');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should reject empty checksum', async () => {
      await expect(
        store.retrieve('', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);
    });

    it('should reject checksum that is too short', async () => {
      await expect(
        store.retrieve('abc', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);
    });

    it('should handle concurrent store operations', async () => {
      const content1 = Buffer.from('Concurrent test 1');
      const content2 = Buffer.from('Concurrent test 2');
      const content3 = Buffer.from('Concurrent test 3');

      const [stored1, stored2, stored3] = await Promise.all([
        store.store(content1, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content2, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content3, { mediaType: 'text/plain', rel: 'original' }),
      ]);

      expect(stored1.checksum).not.toBe(stored2.checksum);
      expect(stored2.checksum).not.toBe(stored3.checksum);

      // All should be retrievable
      const retrieved1 = await store.retrieve(stored1.checksum, 'text/plain');
      const retrieved2 = await store.retrieve(stored2.checksum, 'text/plain');
      const retrieved3 = await store.retrieve(stored3.checksum, 'text/plain');

      expect(retrieved1.toString()).toBe('Concurrent test 1');
      expect(retrieved2.toString()).toBe('Concurrent test 2');
      expect(retrieved3.toString()).toBe('Concurrent test 3');
    });

    it('should handle concurrent stores of same content (idempotency)', async () => {
      const content = Buffer.from('Duplicate concurrent');

      const [stored1, stored2, stored3] = await Promise.all([
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
      ]);

      // All should have same checksum
      expect(stored1.checksum).toBe(stored2.checksum);
      expect(stored2.checksum).toBe(stored3.checksum);

      // Content should be retrievable
      const retrieved = await store.retrieve(stored1.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('Duplicate concurrent');
    });
  });
});
