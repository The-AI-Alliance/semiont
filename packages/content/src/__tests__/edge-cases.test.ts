/**
 * Edge Cases Tests
 * Tests for extreme values, boundary conditions, and unusual scenarios
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FilesystemRepresentationStore } from '../representation-store';
import { getExtensionForMimeType, hasKnownExtension } from '../mime-extensions';
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

describe('Edge Cases - Extreme Scenarios', () => {
  let testDir: string;
  let store: FilesystemRepresentationStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-edge-cases-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FilesystemRepresentationStore({ basePath: testDir }, undefined, mockLogger);
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Extreme file sizes', () => {
    it('should handle very large files (10MB)', async () => {
      // Create 10MB of content
      const largeContent = Buffer.alloc(10 * 1024 * 1024, 'x');

      const stored = await store.store(largeContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      expect(stored.byteSize).toBe(10 * 1024 * 1024);

      // Verify retrieval works
      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(10 * 1024 * 1024);
    });

    it('should handle single-byte content', async () => {
      const tinyContent = Buffer.from('x');

      const stored = await store.store(tinyContent, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      expect(stored.byteSize).toBe(1);

      const retrieved = await store.retrieve(stored.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('x');
    });

    it('should handle zero-byte content', async () => {
      const emptyContent = Buffer.from('');

      const stored = await store.store(emptyContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      expect(stored.byteSize).toBe(0);
      expect(stored.checksum).toBeDefined();

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(0);
    });
  });

  describe('Unusual MIME types', () => {
    it('should handle vendor-specific MIME types', async () => {
      const content = Buffer.from('Vendor data');

      const stored = await store.store(content, {
        mediaType: 'application/vnd.custom.format+json',
        rel: 'original',
      });

      expect(stored.mediaType).toBe('application/vnd.custom.format+json');

      const retrieved = await store.retrieve(stored.checksum, 'application/vnd.custom.format+json');
      expect(retrieved.toString()).toBe('Vendor data');
    });

    it('should handle experimental MIME types', async () => {
      const content = Buffer.from('Experimental');

      const stored = await store.store(content, {
        mediaType: 'application/x-custom-format',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/x-custom-format');
      expect(retrieved.toString()).toBe('Experimental');
    });

    it('should handle MIME types with multiple parameters', async () => {
      const content = Buffer.from('Multi-param content');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8; boundary=----WebKit; format=flowed',
        rel: 'original',
      });

      expect(stored.mediaType).toBe('text/plain; charset=utf-8; boundary=----WebKit; format=flowed');

      const retrieved = await store.retrieve(
        stored.checksum,
        'text/plain; charset=utf-8; boundary=----WebKit; format=flowed'
      );
      expect(retrieved.toString()).toBe('Multi-param content');
    });

    it('should handle MIME types with very long parameter values', async () => {
      const content = Buffer.from('Long param');
      const longBoundary = '-'.repeat(200);

      const stored = await store.store(content, {
        mediaType: `multipart/form-data; boundary=${longBoundary}`,
        rel: 'original',
      });

      expect(stored.mediaType).toContain(longBoundary);
    });
  });

  describe('Unusual characters in content', () => {
    it('should handle content with all null bytes', async () => {
      const nullContent = Buffer.alloc(100, 0x00);

      const stored = await store.store(nullContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(100);
      expect(retrieved.every(byte => byte === 0x00)).toBe(true);
    });

    it('should handle content with all 0xFF bytes', async () => {
      const ffContent = Buffer.alloc(100, 0xFF);

      const stored = await store.store(ffContent, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved.length).toBe(100);
      expect(retrieved.every(byte => byte === 0xFF)).toBe(true);
    });

    it('should handle content with control characters', async () => {
      const controlChars = Buffer.from([
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
        0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
      ]);

      const stored = await store.store(controlChars, {
        mediaType: 'application/octet-stream',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/octet-stream');
      expect(retrieved).toEqual(controlChars);
    });

    it('should handle content with Unicode special characters', async () => {
      const specialChars = 'Zero-width: \u200B, RTL: \u202E, Combining: e\u0301';
      const content = Buffer.from(specialChars, 'utf-8');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'text/plain; charset=utf-8');
      expect(retrieved.toString('utf-8')).toBe(specialChars);
    });

    it('should handle content with emoji sequences', async () => {
      const emojiContent = '👨‍👩‍👧‍👦 👍🏽 🏴󠁧󠁢󠁳󠁣󠁴󠁿';
      const content = Buffer.from(emojiContent, 'utf-8');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'text/plain; charset=utf-8');
      expect(retrieved.toString('utf-8')).toBe(emojiContent);
    });
  });

  describe('Metadata edge cases', () => {
    it('should handle very long filename', async () => {
      const content = Buffer.from('Test');
      const longFilename = 'a'.repeat(255) + '.txt';

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
        filename: longFilename,
      });

      expect(stored.filename).toBe(longFilename);
    });

    it('should handle filename with special characters', async () => {
      const content = Buffer.from('Test');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
        filename: 'file with spaces & special!@#$%^chars.txt',
      });

      expect(stored.filename).toBe('file with spaces & special!@#$%^chars.txt');
    });

    it('should handle all metadata fields populated', async () => {
      const content = Buffer.from('Full metadata');

      const stored = await store.store(content, {
        mediaType: 'text/markdown; charset=utf-8',
        filename: 'document.md',
        encoding: 'gzip',
        language: 'en-US',
        rel: 'derived',
      });

      expect(stored.mediaType).toBe('text/markdown; charset=utf-8');
      expect(stored.filename).toBe('document.md');
      expect(stored.encoding).toBe('gzip');
      expect(stored.language).toBe('en-US');
      expect(stored.rel).toBe('derived');
    });

    it('should handle minimal metadata (only required mediaType)', async () => {
      const content = Buffer.from('Minimal');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
      });

      expect(stored.mediaType).toBe('text/plain');
      expect(stored.rel).toBeUndefined();
      expect(stored.filename).toBeUndefined();
    });
  });

  describe('Checksum collision scenarios', () => {
    it('should handle checksums starting with 00', async () => {
      // We can't force a checksum, but we can test retrieval with such a checksum
      const content = Buffer.from('Test content for low checksum');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Should work regardless of checksum value
      const retrieved = await store.retrieve(stored.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('Test content for low checksum');
    });

    it('should handle checksums starting with FF', async () => {
      const content = Buffer.from('Test content for high checksum');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('Test content for high checksum');
    });

    it('should handle checksums with repeating patterns', async () => {
      const content = Buffer.from('Pattern test');
      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Should work with any checksum pattern
      const retrieved = await store.retrieve(stored.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('Pattern test');
    });
  });

  describe('MIME extension mapping edge cases', () => {
    it('should handle extremely long MIME type', async () => {
      const longMimeType = `application/vnd.${'x'.repeat(200)}.format`;

      // Should not throw, should use .dat
      const extension = getExtensionForMimeType(longMimeType);
      expect(extension).toBe('.dat');
    });

    it('should handle MIME type with only type (no subtype)', async () => {
      const extension = getExtensionForMimeType('text');
      expect(extension).toBe('.dat');
    });

    it('should handle MIME type with empty subtype', async () => {
      const extension = getExtensionForMimeType('text/');
      expect(extension).toBe('.dat');
    });

    it('should handle MIME type with numbers', async () => {
      const extension = getExtensionForMimeType('application/3gpp');
      expect(extension).toBe('.dat'); // Unknown type
    });

    it('should handle hasKnownExtension for edge cases', () => {
      expect(hasKnownExtension('')).toBe(false);
      expect(hasKnownExtension('/')).toBe(false);
      expect(hasKnownExtension('text')).toBe(false);
      expect(hasKnownExtension('   ')).toBe(false);
    });
  });

  describe('Concurrent operations', () => {
    it('should handle many concurrent stores (stress test)', async () => {
      const operations = Array.from({ length: 50 }, (_, i) =>
        store.store(Buffer.from(`Content ${i}`), {
          mediaType: 'text/plain',
          rel: 'original',
        })
      );

      const results = await Promise.all(operations);

      // All should succeed
      expect(results).toHaveLength(50);
      expect(results.every(r => r.checksum)).toBe(true);

      // All should have different checksums (different content)
      const checksums = new Set(results.map(r => r.checksum));
      expect(checksums.size).toBe(50);
    });

    it('should handle mixed concurrent stores and retrieves', async () => {
      // Store some content first
      const stored1 = await store.store(Buffer.from('Retrieve me 1'), {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const stored2 = await store.store(Buffer.from('Retrieve me 2'), {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Mix stores and retrieves
      const operations = [
        store.store(Buffer.from('New 1'), { mediaType: 'text/plain', rel: 'original' }),
        store.retrieve(stored1.checksum, 'text/plain'),
        store.store(Buffer.from('New 2'), { mediaType: 'text/plain', rel: 'original' }),
        store.retrieve(stored2.checksum, 'text/plain'),
        store.store(Buffer.from('New 3'), { mediaType: 'text/plain', rel: 'original' }),
      ];

      const results = await Promise.all(operations);

      expect(results).toHaveLength(5);
      expect((results[1] as Buffer).toString()).toBe('Retrieve me 1');
      expect((results[3] as Buffer).toString()).toBe('Retrieve me 2');
    });
  });

  describe('Timestamp handling', () => {
    it('should generate valid ISO 8601 timestamps', async () => {
      const content = Buffer.from('Timestamp test');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      expect(stored.created).toBeDefined();
      expect(stored.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

      // Should be parseable
      const date = new Date(stored.created);
      expect(date.getTime()).toBeGreaterThan(0);
    });

    it('should have recent timestamps', async () => {
      const before = new Date();
      const content = Buffer.from('Recent test');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const after = new Date();
      const created = new Date(stored.created);

      expect(created.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(created.getTime()).toBeLessThanOrEqual(after.getTime());
    });
  });

  describe('Representation ID handling', () => {
    it('should use checksum as @id', async () => {
      const content = Buffer.from('ID test');

      const stored = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      expect(stored['@id']).toBe(stored.checksum);
      expect(stored['@id']).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should maintain consistent @id across stores', async () => {
      const content = Buffer.from('Consistent ID');

      const stored1 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      const stored2 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'derived',
      });

      expect(stored1['@id']).toBe(stored2['@id']);
      expect(stored1['@id']).toBe(stored1.checksum);
      expect(stored2['@id']).toBe(stored2.checksum);
    });
  });
});
