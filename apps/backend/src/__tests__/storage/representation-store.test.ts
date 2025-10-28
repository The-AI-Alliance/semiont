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
    });

    it('should use checksum-based sharding in file path', async () => {
      const content = Buffer.from('Test content for sharding');
      const checksum = calculateChecksum(content);

      // Expected sharding: first 4 hex digits -> ab/cd
      const ab = checksum.substring(0, 2);
      const cd = checksum.substring(2, 4);

      const result = await store.store(content, {
        mediaType: 'text/markdown',
        rel: 'original',
      });

      // Verify file path contains sharding
      expect(result.storageUri).toContain(`/${ab}/${cd}/`);
      expect(result.storageUri).toContain(`rep-${checksum}.dat`);
    });

    it('should encode media type in path (/ becomes ~1)', async () => {
      const content = Buffer.from('Image data');

      const result = await store.store(content, {
        mediaType: 'image/png',
        rel: 'original',
      });

      // Verify media type encoding
      expect(result.storageUri).toContain('image~1png');
      expect(result.storageUri).not.toContain('image/png');
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

      // Same checksum, same file path
      expect(result1.checksum).toBe(result2.checksum);
      expect(result1.storageUri).toBe(result2.storageUri);

      // Verify file was written (not just metadata)
      const fileExists = await fs.access(result1.storageUri.replace('file://', ''))
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(true);
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

  describe('retrieveByChecksum()', () => {
    it('should retrieve content by raw hex checksum', async () => {
      const content = Buffer.from('Retrieve me!');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const retrieved = await store.retrieveByChecksum(stored.checksum, 'text/plain');

      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should throw error for non-existent checksum', async () => {
      const fakeChecksum = 'a'.repeat(64); // Valid format but doesn't exist

      await expect(
        store.retrieveByChecksum(fakeChecksum, 'text/plain')
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
        store.retrieveByChecksum(stored.checksum, 'text/plain')
      ).rejects.toThrow(/not found/i);

      // Should succeed with correct mediaType
      const retrieved = await store.retrieveByChecksum(stored.checksum, 'text/markdown');
      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should reject invalid checksum format', async () => {
      await expect(
        store.retrieveByChecksum('', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);

      await expect(
        store.retrieveByChecksum('abc', 'text/plain')
      ).rejects.toThrow(/invalid checksum/i);
    });
  });

  describe('retrieve() - legacy URI-based retrieval', () => {
    it('should retrieve content by storage URI', async () => {
      const content = Buffer.from('URI retrieval');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.storageUri);

      expect(retrieved.toString()).toBe(content.toString());
    });

    it('should throw error for non-existent URI', async () => {
      const fakeUri = `file://${testDir}/nonexistent.dat`;

      await expect(
        store.retrieve(fakeUri)
      ).rejects.toThrow(/not found/i);
    });
  });

  describe('delete()', () => {
    it('should delete representation by URI', async () => {
      const content = Buffer.from('Delete me');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      await store.delete(stored.storageUri);

      // Verify file is gone
      await expect(
        store.retrieve(stored.storageUri)
      ).rejects.toThrow(/not found/i);
    });

    it('should not throw error if file does not exist', async () => {
      const fakeUri = `file://${testDir}/nonexistent.dat`;

      // Should not throw
      await expect(
        store.delete(fakeUri)
      ).resolves.toBeUndefined();
    });
  });

  describe('exists()', () => {
    it('should return true for existing representation', async () => {
      const content = Buffer.from('Exists test');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const exists = await store.exists(stored.storageUri);

      expect(exists).toBe(true);
    });

    it('should return false for non-existent representation', async () => {
      const fakeUri = `file://${testDir}/nonexistent.dat`;

      const exists = await store.exists(fakeUri);

      expect(exists).toBe(false);
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

      // Same checksum and file path despite different metadata
      expect(stored1.checksum).toBe(stored2.checksum);
      expect(stored1.storageUri).toBe(stored2.storageUri);

      // Content is retrievable
      const retrieved = await store.retrieveByChecksum(stored1.checksum, 'text/plain');
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

    it('should reject checksums with sha256: prefix in retrieveByChecksum', async () => {
      const content = Buffer.from('No prefix allowed');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Old format with prefix should fail
      const oldFormatChecksum = `sha256:${stored.checksum}`;

      await expect(
        store.retrieveByChecksum(oldFormatChecksum, 'text/plain')
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
      const retrieved = await store.retrieveByChecksum(stored.checksum, 'application/octet-stream');
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

      const retrieved = await store.retrieveByChecksum(stored.checksum, 'application/octet-stream');

      expect(retrieved).toEqual(binaryContent);
      expect(retrieved[0]).toBe(0x00);
      expect(retrieved[1]).toBe(0xFF);
    });
  });
});
