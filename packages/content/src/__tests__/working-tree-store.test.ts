/**
 * WorkingTreeStore Tests
 *
 * Covers both write paths (store / register), retrieval, move, remove,
 * URI resolution, and git index staging when the project has gitSync enabled.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { SemiontProject } from '@semiont/core/node';
import { WorkingTreeStore, ChecksumMismatchError } from '../working-tree-store';
import { calculateChecksum } from '../checksum';

interface TestProject {
  project: SemiontProject;
  root: string;
  cleanup: () => Promise<void>;
}

async function createProject(opts?: { gitSync?: boolean }): Promise<TestProject> {
  const root = await fs.mkdtemp(join(tmpdir(), 'semiont-content-test-'));
  await fs.mkdir(join(root, '.semiont'), { recursive: true });
  const gitSection = opts?.gitSync ? '\n[git]\nsync = true\n' : '';
  await fs.writeFile(
    join(root, '.semiont', 'config'),
    `[project]\nname = "working-tree-test"\n${gitSection}`
  );
  if (opts?.gitSync) {
    execFileSync('git', ['init'], { cwd: root });
  }
  const project = new SemiontProject(root);
  return {
    project,
    root,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

function stagedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '--cached'], { cwd: root, encoding: 'utf-8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

describe('WorkingTreeStore', () => {
  let project: SemiontProject;
  let root: string;
  let cleanup: () => Promise<void>;
  let store: WorkingTreeStore;

  beforeAll(async () => {
    ({ project, root, cleanup } = await createProject());
    store = new WorkingTreeStore(project);
  });

  afterAll(async () => {
    await cleanup();
  });

  describe('store', () => {
    it('should write content to the path indicated by the URI', async () => {
      const content = Buffer.from('# Overview\n');
      await store.store(content, 'file://docs/overview.md');

      const onDisk = await fs.readFile(join(root, 'docs', 'overview.md'));
      expect(onDisk.equals(content)).toBe(true);
    });

    it('should return checksum, byte size, and timestamp metadata', async () => {
      const content = Buffer.from('hello world');
      const stored = await store.store(content, 'file://hello.txt');

      expect(stored.storageUri).toBe('file://hello.txt');
      expect(stored.checksum).toBe(calculateChecksum(content));
      expect(stored.byteSize).toBe(content.length);
      expect(stored.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should create intermediate directories', async () => {
      await store.store(Buffer.from('deep'), 'file://a/b/c/deep.txt');

      const onDisk = await fs.readFile(join(root, 'a', 'b', 'c', 'deep.txt'), 'utf-8');
      expect(onDisk).toBe('deep');
    });

    it('should overwrite existing content at the same URI', async () => {
      await store.store(Buffer.from('first'), 'file://overwrite.txt');
      const stored = await store.store(Buffer.from('second'), 'file://overwrite.txt');

      expect(stored.checksum).toBe(calculateChecksum(Buffer.from('second')));
      const onDisk = await fs.readFile(join(root, 'overwrite.txt'), 'utf-8');
      expect(onDisk).toBe('second');
    });
  });

  describe('register', () => {
    it('should return metadata for a file already on disk', async () => {
      const content = Buffer.from('pre-existing');
      await fs.writeFile(join(root, 'existing.txt'), content);

      const registered = await store.register('file://existing.txt');

      expect(registered.storageUri).toBe('file://existing.txt');
      expect(registered.checksum).toBe(calculateChecksum(content));
      expect(registered.byteSize).toBe(content.length);
    });

    it('should accept a matching expected checksum', async () => {
      const content = Buffer.from('verified');
      await fs.writeFile(join(root, 'verified.txt'), content);

      const registered = await store.register('file://verified.txt', calculateChecksum(content));
      expect(registered.checksum).toBe(calculateChecksum(content));
    });

    it('should throw ChecksumMismatchError when the expected checksum does not match', async () => {
      const content = Buffer.from('actual content');
      await fs.writeFile(join(root, 'mismatch.txt'), content);
      const wrongChecksum = calculateChecksum(Buffer.from('expected content'));

      const error = await store.register('file://mismatch.txt', wrongChecksum).catch(e => e);

      expect(error).toBeInstanceOf(ChecksumMismatchError);
      expect(error.storageUri).toBe('file://mismatch.txt');
      expect(error.expected).toBe(wrongChecksum);
      expect(error.actual).toBe(calculateChecksum(content));
    });

    it('should throw when the file does not exist', async () => {
      await expect(store.register('file://no-such-file.txt')).rejects.toThrow();
    });
  });

  describe('retrieve', () => {
    it('should return the stored bytes', async () => {
      const content = Buffer.from('round trip');
      await store.store(content, 'file://round-trip.txt');

      const retrieved = await store.retrieve('file://round-trip.txt');
      expect(retrieved.equals(content)).toBe(true);
    });

    it('should throw "Resource not found" for a missing URI', async () => {
      await expect(store.retrieve('file://missing.txt')).rejects.toThrow(
        'Resource not found: file://missing.txt'
      );
    });

    it('should propagate non-ENOENT filesystem errors unchanged', async () => {
      await fs.mkdir(join(root, 'a-directory'), { recursive: true });

      const error = await store.retrieve('file://a-directory').catch(e => e);

      expect(error.code).toBe('EISDIR');
      expect(error.message).not.toContain('Resource not found');
    });
  });

  describe('move', () => {
    it('should rename the file and preserve its content', async () => {
      const content = Buffer.from('movable');
      await store.store(content, 'file://from.txt');

      await store.move('file://from.txt', 'file://moved/to.txt');

      await expect(fs.access(join(root, 'from.txt'))).rejects.toThrow();
      const retrieved = await store.retrieve('file://moved/to.txt');
      expect(retrieved.equals(content)).toBe(true);
    });
  });

  describe('remove', () => {
    it('should delete the file', async () => {
      await store.store(Buffer.from('doomed'), 'file://doomed.txt');

      await store.remove('file://doomed.txt');

      await expect(fs.access(join(root, 'doomed.txt'))).rejects.toThrow();
    });

    it('should leave the file on disk with keepFile', async () => {
      await store.store(Buffer.from('survivor'), 'file://survivor.txt');

      await store.remove('file://survivor.txt', { keepFile: true });

      const onDisk = await fs.readFile(join(root, 'survivor.txt'), 'utf-8');
      expect(onDisk).toBe('survivor');
    });

    it('should not throw when the file is already absent', async () => {
      await expect(store.remove('file://already-gone.txt')).resolves.toBeUndefined();
    });
  });

  describe('resolveUri', () => {
    it('should map a file:// URI to a path under the project root', () => {
      expect(store.resolveUri('file://docs/overview.md')).toBe(join(root, 'docs', 'overview.md'));
    });

    it('should reject URIs without the file:// scheme', () => {
      expect(() => store.resolveUri('https://example.com/x')).toThrow(
        'Invalid storage URI (must start with file://): https://example.com/x'
      );
    });
  });

  describe('byte fidelity', () => {
    async function roundTrip(content: Buffer, uri: string): Promise<Buffer> {
      const stored = await store.store(content, uri);
      expect(stored.checksum).toBe(calculateChecksum(content));
      expect(stored.byteSize).toBe(content.length);
      const retrieved = await store.retrieve(uri);
      expect(retrieved.equals(content)).toBe(true);
      return retrieved;
    }

    it('should preserve binary content', async () => {
      const content = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from(Array.from({ length: 2048 }, (_, i) => (i * 7 + 13) % 256)),
      ]);
      await roundTrip(content, 'file://fidelity/image.png');
    });

    it('should preserve content that is all null bytes', async () => {
      await roundTrip(Buffer.alloc(1024, 0x00), 'file://fidelity/nulls.bin');
    });

    it('should preserve content that is all 0xFF bytes', async () => {
      await roundTrip(Buffer.alloc(1024, 0xff), 'file://fidelity/ff.bin');
    });

    it('should preserve control characters', async () => {
      const content = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
      await roundTrip(content, 'file://fidelity/control.bin');
    });

    it('should preserve multi-byte UTF-8 text byte-exactly', async () => {
      const text = 'héllo wörld — 你好世界 — مرحبا بالعالم — Здравствуй';
      const retrieved = await roundTrip(Buffer.from(text, 'utf-8'), 'file://fidelity/utf8.txt');
      expect(retrieved.toString('utf-8')).toBe(text);
    });

    it('should preserve Unicode special characters', async () => {
      // ZWSP, ZWJ, RLO, combining acute, BOM
      const text = 'a\u200B\u200Db\u202Ec\u0301d\uFEFF';
      const retrieved = await roundTrip(Buffer.from(text, 'utf-8'), 'file://fidelity/special.txt');
      expect(retrieved.toString('utf-8')).toBe(text);
    });

    it('should preserve emoji sequences', async () => {
      const text = '👨‍👩‍👧‍👦 🏳️‍🌈 👍🏽 🇺🇳';
      const retrieved = await roundTrip(Buffer.from(text, 'utf-8'), 'file://fidelity/emoji.txt');
      expect(retrieved.toString('utf-8')).toBe(text);
    });
  });

  describe('extreme sizes', () => {
    it('should handle zero-byte content', async () => {
      const stored = await store.store(Buffer.alloc(0), 'file://sizes/empty.bin');

      expect(stored.byteSize).toBe(0);
      expect(stored.checksum).toBe(calculateChecksum(Buffer.alloc(0)));
      const retrieved = await store.retrieve('file://sizes/empty.bin');
      expect(retrieved.length).toBe(0);
    });

    it('should handle single-byte content', async () => {
      const content = Buffer.from([0x42]);
      await store.store(content, 'file://sizes/one.bin');

      const retrieved = await store.retrieve('file://sizes/one.bin');
      expect(retrieved.equals(content)).toBe(true);
    });

    it('should handle 1MB content', async () => {
      const content = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < content.length; i++) content[i] = i % 256;

      const stored = await store.store(content, 'file://sizes/1mb.bin');

      expect(stored.byteSize).toBe(1024 * 1024);
      const retrieved = await store.retrieve('file://sizes/1mb.bin');
      expect(retrieved.equals(content)).toBe(true);
    });

    it('should handle 10MB content', async () => {
      const content = Buffer.alloc(10 * 1024 * 1024);
      for (let i = 0; i < content.length; i++) content[i] = (i * 31 + 7) % 256;

      const stored = await store.store(content, 'file://sizes/10mb.bin');

      expect(stored.byteSize).toBe(10 * 1024 * 1024);
      const retrieved = await store.retrieve('file://sizes/10mb.bin');
      expect(retrieved.equals(content)).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('should handle many concurrent stores to distinct URIs', async () => {
      const results = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          store.store(Buffer.from(`Content ${i}`), `file://concurrent/file-${i}.txt`)
        )
      );

      expect(results).toHaveLength(50);
      expect(new Set(results.map(r => r.checksum)).size).toBe(50);

      const retrieved = await Promise.all(
        Array.from({ length: 50 }, (_, i) => store.retrieve(`file://concurrent/file-${i}.txt`))
      );
      retrieved.forEach((buf, i) => expect(buf.toString()).toBe(`Content ${i}`));
    });

    it('should handle mixed concurrent stores and retrieves', async () => {
      await store.store(Buffer.from('Retrieve me 1'), 'file://mixed/a.txt');
      await store.store(Buffer.from('Retrieve me 2'), 'file://mixed/b.txt');

      const results = await Promise.all([
        store.store(Buffer.from('New 1'), 'file://mixed/new-1.txt'),
        store.retrieve('file://mixed/a.txt'),
        store.store(Buffer.from('New 2'), 'file://mixed/new-2.txt'),
        store.retrieve('file://mixed/b.txt'),
        store.store(Buffer.from('New 3'), 'file://mixed/new-3.txt'),
      ]);

      expect((results[1] as Buffer).toString()).toBe('Retrieve me 1');
      expect((results[3] as Buffer).toString()).toBe('Retrieve me 2');
      const newOnes = await Promise.all([
        store.retrieve('file://mixed/new-1.txt'),
        store.retrieve('file://mixed/new-2.txt'),
        store.retrieve('file://mixed/new-3.txt'),
      ]);
      expect(newOnes.map(b => b.toString())).toEqual(['New 1', 'New 2', 'New 3']);
    });
  });
});

describe('WorkingTreeStore with gitSync', () => {
  let project: SemiontProject;
  let root: string;
  let cleanup: () => Promise<void>;
  let store: WorkingTreeStore;

  beforeAll(async () => {
    ({ project, root, cleanup } = await createProject({ gitSync: true }));
    store = new WorkingTreeStore(project);
  });

  afterAll(async () => {
    await cleanup();
  });

  it('should read gitSync from the project config', () => {
    expect(project.gitSync).toBe(true);
  });

  it('should stage stored files in the git index', async () => {
    await store.store(Buffer.from('staged'), 'file://docs/staged.md');

    expect(stagedFiles(root)).toContain('docs/staged.md');
  });

  it('should skip staging with noGit', async () => {
    await store.store(Buffer.from('unstaged'), 'file://docs/unstaged.md', { noGit: true });

    expect(stagedFiles(root)).not.toContain('docs/unstaged.md');
  });

  it('should stage registered files in the git index', async () => {
    await fs.writeFile(join(root, 'registered.txt'), 'registered');

    await store.register('file://registered.txt');

    expect(stagedFiles(root)).toContain('registered.txt');
  });

  it('should update the git index on move', async () => {
    await store.store(Buffer.from('mv me'), 'file://mv-from.txt');

    await store.move('file://mv-from.txt', 'file://mv-to.txt');

    const staged = stagedFiles(root);
    expect(staged).toContain('mv-to.txt');
    expect(staged).not.toContain('mv-from.txt');
    const retrieved = await store.retrieve('file://mv-to.txt');
    expect(retrieved.toString()).toBe('mv me');
  });

  it('should unstage but keep the file on disk with keepFile', async () => {
    await store.store(Buffer.from('cached only'), 'file://cached-only.txt');
    expect(stagedFiles(root)).toContain('cached-only.txt');

    await store.remove('file://cached-only.txt', { keepFile: true });

    expect(stagedFiles(root)).not.toContain('cached-only.txt');
    const onDisk = await fs.readFile(join(root, 'cached-only.txt'), 'utf-8');
    expect(onDisk).toBe('cached only');
  });
});
