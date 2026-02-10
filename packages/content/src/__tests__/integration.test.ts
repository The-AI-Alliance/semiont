/**
 * Integration Tests
 * Tests for complete store-retrieve workflows and real-world scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FilesystemRepresentationStore } from '../representation-store';
import { calculateChecksum } from '../checksum';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('FilesystemRepresentationStore - Integration', () => {
  let testDir: string;
  let store: FilesystemRepresentationStore;

  beforeAll(async () => {
    testDir = join(tmpdir(), `semiont-integration-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    store = new FilesystemRepresentationStore({ basePath: testDir });
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('Complete store-retrieve workflows', () => {
    it('should store and retrieve text content with charset', async () => {
      const content = Buffer.from('Hello, 世界!', 'utf-8');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
        language: 'ja',
      });

      expect(stored.checksum).toBeDefined();
      expect(stored.mediaType).toBe('text/plain; charset=utf-8');
      expect(stored.language).toBe('ja');

      const retrieved = await store.retrieve(stored.checksum, 'text/plain; charset=utf-8');
      expect(retrieved.toString('utf-8')).toBe('Hello, 世界!');
    });

    it('should store and retrieve JSON content', async () => {
      const data = { name: 'Test', value: 42, nested: { foo: 'bar' } };
      const content = Buffer.from(JSON.stringify(data, null, 2));

      const stored = await store.store(content, {
        mediaType: 'application/json',
        rel: 'derived',
      });

      const retrieved = await store.retrieve(stored.checksum, 'application/json');
      const parsed = JSON.parse(retrieved.toString());
      expect(parsed).toEqual(data);
    });

    it('should store and retrieve binary image data', async () => {
      // Simulate PNG file header
      const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

      const stored = await store.store(pngHeader, {
        mediaType: 'image/png',
        rel: 'thumbnail',
      });

      const retrieved = await store.retrieve(stored.checksum, 'image/png');
      expect(retrieved).toEqual(pngHeader);
      expect(retrieved[0]).toBe(0x89);
      expect(retrieved[1]).toBe(0x50);
    });

    it('should store markdown with metadata', async () => {
      const markdown = Buffer.from('# Heading\n\nParagraph with **bold** text.');

      const stored = await store.store(markdown, {
        mediaType: 'text/markdown',
        rel: 'original',
        filename: 'README.md',
        language: 'en',
      });

      expect(stored.filename).toBe('README.md');
      expect(stored.language).toBe('en');

      const retrieved = await store.retrieve(stored.checksum, 'text/markdown');
      expect(retrieved.toString()).toBe('# Heading\n\nParagraph with **bold** text.');
    });
  });

  describe('Multi-representation workflows', () => {
    it('should store multiple representations of same resource', async () => {
      const baseResource = 'Resource content';

      // Original
      const original = Buffer.from(baseResource);
      const storedOriginal = await store.store(original, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Derived (uppercase transformation)
      const derived = Buffer.from(baseResource.toUpperCase());
      const storedDerived = await store.store(derived, {
        mediaType: 'text/plain',
        rel: 'derived',
      });

      // Different checksums since content differs
      expect(storedOriginal.checksum).not.toBe(storedDerived.checksum);

      // Both retrievable
      const retrievedOriginal = await store.retrieve(storedOriginal.checksum, 'text/plain');
      const retrievedDerived = await store.retrieve(storedDerived.checksum, 'text/plain');

      expect(retrievedOriginal.toString()).toBe('Resource content');
      expect(retrievedDerived.toString()).toBe('RESOURCE CONTENT');
    });

    it('should store different media type representations', async () => {
      const jsonData = { title: 'Test', value: 123 };

      // JSON representation
      const jsonContent = Buffer.from(JSON.stringify(jsonData));
      const storedJson = await store.store(jsonContent, {
        mediaType: 'application/json',
        rel: 'original',
      });

      // YAML representation (same data)
      const yamlContent = Buffer.from('title: Test\nvalue: 123\n');
      const storedYaml = await store.store(yamlContent, {
        mediaType: 'application/yaml',
        rel: 'derived',
      });

      // Different checksums and stored in different paths
      expect(storedJson.checksum).not.toBe(storedYaml.checksum);

      // Both retrievable with correct media types
      const retrievedJson = await store.retrieve(storedJson.checksum, 'application/json');
      const retrievedYaml = await store.retrieve(storedYaml.checksum, 'application/yaml');

      expect(JSON.parse(retrievedJson.toString())).toEqual(jsonData);
      expect(retrievedYaml.toString()).toContain('title: Test');
    });
  });

  describe('Path construction and organization', () => {
    it('should create proper sharded directory structure', async () => {
      const content = Buffer.from('Test sharding');
      const checksum = calculateChecksum(content);
      const ab = checksum.substring(0, 2);
      const cd = checksum.substring(2, 4);

      await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
      });

      // Verify directory structure exists
      const expectedDir = join(testDir, 'representations', 'text~1plain', ab, cd);
      const dirExists = await fs.access(expectedDir)
        .then(() => true)
        .catch(() => false);

      expect(dirExists).toBe(true);

      // Verify file exists with correct name
      const expectedFile = join(expectedDir, `rep-${checksum}.txt`);
      const fileExists = await fs.access(expectedFile)
        .then(() => true)
        .catch(() => false);

      expect(fileExists).toBe(true);
    });

    it('should handle media types with special characters', async () => {
      const content = Buffer.from('<svg></svg>');

      const stored = await store.store(content, {
        mediaType: 'image/svg+xml',
        rel: 'original',
      });

      // Should encode / as ~1 in path
      const ab = stored.checksum.substring(0, 2);
      const cd = stored.checksum.substring(2, 4);
      const expectedDir = join(testDir, 'representations', 'image~1svg+xml', ab, cd);

      const dirExists = await fs.access(expectedDir)
        .then(() => true)
        .catch(() => false);

      expect(dirExists).toBe(true);

      // Should be retrievable
      const retrieved = await store.retrieve(stored.checksum, 'image/svg+xml');
      expect(retrieved.toString()).toBe('<svg></svg>');
    });

    it('should organize by media type to enable browsing', async () => {
      // Store multiple files of different types
      await store.store(Buffer.from('Text 1'), { mediaType: 'text/plain', rel: 'original' });
      await store.store(Buffer.from('Text 2'), { mediaType: 'text/plain', rel: 'original' });
      await store.store(Buffer.from('{"key": "value"}'), { mediaType: 'application/json', rel: 'original' });
      await store.store(Buffer.from('# Markdown'), { mediaType: 'text/markdown', rel: 'original' });

      // Should have separate directories for each media type
      const textPlainDir = join(testDir, 'representations', 'text~1plain');
      const jsonDir = join(testDir, 'representations', 'application~1json');
      const markdownDir = join(testDir, 'representations', 'text~1markdown');

      const textPlainExists = await fs.access(textPlainDir).then(() => true).catch(() => false);
      const jsonExists = await fs.access(jsonDir).then(() => true).catch(() => false);
      const markdownExists = await fs.access(markdownDir).then(() => true).catch(() => false);

      expect(textPlainExists).toBe(true);
      expect(jsonExists).toBe(true);
      expect(markdownExists).toBe(true);
    });
  });

  describe('Deduplication workflows', () => {
    it('should deduplicate identical content across different metadata', async () => {
      const content = Buffer.from('Shared content');

      const stored1 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'original',
        filename: 'file1.txt',
        language: 'en',
      });

      const stored2 = await store.store(content, {
        mediaType: 'text/plain',
        rel: 'derived',
        filename: 'file2.txt',
        language: 'es',
      });

      // Same checksum despite different metadata
      expect(stored1.checksum).toBe(stored2.checksum);
      expect(stored1['@id']).toBe(stored2['@id']);

      // Different metadata preserved
      expect(stored1.filename).toBe('file1.txt');
      expect(stored2.filename).toBe('file2.txt');
      expect(stored1.language).toBe('en');
      expect(stored2.language).toBe('es');

      // Only one file on disk
      const ab = stored1.checksum.substring(0, 2);
      const cd = stored1.checksum.substring(2, 4);
      const dir = join(testDir, 'representations', 'text~1plain', ab, cd);
      const files = await fs.readdir(dir);

      const repFiles = files.filter(f => f.startsWith('rep-'));
      expect(repFiles.length).toBe(1);
    });

    it('should handle concurrent stores of identical content', async () => {
      const content = Buffer.from('Concurrent identical content');

      // Store same content concurrently
      const [stored1, stored2, stored3, stored4] = await Promise.all([
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
        store.store(content, { mediaType: 'text/plain', rel: 'original' }),
      ]);

      // All should have same checksum
      expect(stored1.checksum).toBe(stored2.checksum);
      expect(stored2.checksum).toBe(stored3.checksum);
      expect(stored3.checksum).toBe(stored4.checksum);

      // All retrievable
      const retrieved = await store.retrieve(stored1.checksum, 'text/plain');
      expect(retrieved.toString()).toBe('Concurrent identical content');
    });
  });

  describe('Real-world content scenarios', () => {
    it('should handle typical web page workflow', async () => {
      // Original HTML
      const html = Buffer.from('<!DOCTYPE html><html><body><h1>Title</h1></body></html>');
      const storedHtml = await store.store(html, {
        mediaType: 'text/html',
        rel: 'original',
        filename: 'index.html',
      });

      // Extracted text
      const text = Buffer.from('Title');
      const storedText = await store.store(text, {
        mediaType: 'text/plain',
        rel: 'derived',
      });

      // Metadata
      const metadata = Buffer.from(JSON.stringify({ title: 'Title', wordCount: 1 }));
      const storedMetadata = await store.store(metadata, {
        mediaType: 'application/json',
        rel: 'derived',
      });

      // All retrievable
      expect((await store.retrieve(storedHtml.checksum, 'text/html')).toString()).toContain('Title');
      expect((await store.retrieve(storedText.checksum, 'text/plain')).toString()).toBe('Title');
      expect(JSON.parse((await store.retrieve(storedMetadata.checksum, 'application/json')).toString())).toEqual({ title: 'Title', wordCount: 1 });
    });

    it('should handle document conversion pipeline', async () => {
      // Original Markdown
      const markdown = Buffer.from('# Document\n\nParagraph with **bold** text.');
      const storedMd = await store.store(markdown, {
        mediaType: 'text/markdown',
        rel: 'original',
        filename: 'doc.md',
      });

      // Converted to HTML
      const html = Buffer.from('<h1>Document</h1><p>Paragraph with <strong>bold</strong> text.</p>');
      const storedHtml = await store.store(html, {
        mediaType: 'text/html',
        rel: 'derived',
      });

      // Converted to plain text
      const text = Buffer.from('Document\n\nParagraph with bold text.');
      const storedText = await store.store(text, {
        mediaType: 'text/plain',
        rel: 'derived',
      });

      // All versions stored and retrievable
      expect(storedMd.checksum).toBeDefined();
      expect(storedHtml.checksum).toBeDefined();
      expect(storedText.checksum).toBeDefined();

      expect((await store.retrieve(storedMd.checksum, 'text/markdown')).toString()).toContain('**bold**');
      expect((await store.retrieve(storedHtml.checksum, 'text/html')).toString()).toContain('<strong>bold</strong>');
      expect((await store.retrieve(storedText.checksum, 'text/plain')).toString()).toContain('Paragraph with bold text');
    });

    it('should handle media thumbnailing workflow', async () => {
      // Original large image (simulated)
      const original = Buffer.alloc(1024 * 500, 0xFF); // 500KB
      const storedOriginal = await store.store(original, {
        mediaType: 'image/png',
        rel: 'original',
        filename: 'photo.png',
      });

      // Thumbnail (simulated smaller version)
      const thumbnail = Buffer.alloc(1024 * 10, 0xFF); // 10KB
      const storedThumbnail = await store.store(thumbnail, {
        mediaType: 'image/png',
        rel: 'thumbnail',
      });

      // Preview (simulated medium version)
      const preview = Buffer.alloc(1024 * 100, 0xFF); // 100KB
      const storedPreview = await store.store(preview, {
        mediaType: 'image/png',
        rel: 'preview',
      });

      // All different sizes, all retrievable
      expect(storedOriginal.byteSize).toBe(1024 * 500);
      expect(storedThumbnail.byteSize).toBe(1024 * 10);
      expect(storedPreview.byteSize).toBe(1024 * 100);

      const retrievedOriginal = await store.retrieve(storedOriginal.checksum, 'image/png');
      const retrievedThumbnail = await store.retrieve(storedThumbnail.checksum, 'image/png');
      const retrievedPreview = await store.retrieve(storedPreview.checksum, 'image/png');

      expect(retrievedOriginal.length).toBe(1024 * 500);
      expect(retrievedThumbnail.length).toBe(1024 * 10);
      expect(retrievedPreview.length).toBe(1024 * 100);
    });
  });

  describe('Character encoding scenarios', () => {
    it('should preserve UTF-8 encoded content', async () => {
      const content = Buffer.from('Hello 世界 🌍', 'utf-8');

      const stored = await store.store(content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
      });

      const retrieved = await store.retrieve(stored.checksum, 'text/plain; charset=utf-8');
      expect(retrieved.toString('utf-8')).toBe('Hello 世界 🌍');
    });

    it('should handle different character encodings in metadata', async () => {
      // ISO-8859-1 metadata
      const latin1Content = Buffer.from('Café', 'latin1');
      const storedLatin1 = await store.store(latin1Content, {
        mediaType: 'text/plain; charset=iso-8859-1',
        rel: 'original',
      });

      // UTF-8 version (different bytes, different checksum)
      const utf8Content = Buffer.from('Café', 'utf-8');
      const storedUtf8 = await store.store(utf8Content, {
        mediaType: 'text/plain; charset=utf-8',
        rel: 'original',
      });

      // Different checksums due to different byte representation
      expect(storedLatin1.checksum).not.toBe(storedUtf8.checksum);

      // Both stored under text/plain directory (charset stripped for path)
      const ab1 = storedLatin1.checksum.substring(0, 2);
      const cd1 = storedLatin1.checksum.substring(2, 4);
      const ab2 = storedUtf8.checksum.substring(0, 2);
      const cd2 = storedUtf8.checksum.substring(2, 4);

      const latin1File = join(testDir, 'representations', 'text~1plain', ab1, cd1, `rep-${storedLatin1.checksum}.txt`);
      const utf8File = join(testDir, 'representations', 'text~1plain', ab2, cd2, `rep-${storedUtf8.checksum}.txt`);

      const latin1Exists = await fs.access(latin1File).then(() => true).catch(() => false);
      const utf8Exists = await fs.access(utf8File).then(() => true).catch(() => false);

      expect(latin1Exists).toBe(true);
      expect(utf8Exists).toBe(true);
    });
  });
});
