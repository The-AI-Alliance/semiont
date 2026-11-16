/**
 * Storage URI Index Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveStorageUri,
  writeStorageUriEntry,
  removeStorageUriEntry,
  listStorageUriEntries,
  ResourceNotFoundError,
} from '../../storage/storage-uri-index';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';

describe('storage-uri-index', () => {
  let projectionsDir: string;

  beforeEach(async () => {
    projectionsDir = join(tmpdir(), `semiont-test-uri-index-${uuidv4()}`);
    await fs.mkdir(projectionsDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(projectionsDir, { recursive: true, force: true });
  });

  describe('resolveStorageUri()', () => {
    it('should resolve a written entry', async () => {
      await writeStorageUriEntry(projectionsDir, 'file://docs/overview.md', 'res-1');
      const resolved = await resolveStorageUri(projectionsDir, 'file://docs/overview.md');
      expect(resolved).toBe('res-1');
    });

    it('should throw ResourceNotFoundError for an unknown URI', async () => {
      await expect(resolveStorageUri(projectionsDir, 'file://missing.md'))
        .rejects.toThrow(ResourceNotFoundError);
    });
  });

  describe('removeStorageUriEntry()', () => {
    it('should remove an entry', async () => {
      await writeStorageUriEntry(projectionsDir, 'file://docs/overview.md', 'res-1');
      await removeStorageUriEntry(projectionsDir, 'file://docs/overview.md');
      await expect(resolveStorageUri(projectionsDir, 'file://docs/overview.md'))
        .rejects.toThrow(ResourceNotFoundError);
    });

    it('should be a no-op for an unknown URI', async () => {
      await expect(removeStorageUriEntry(projectionsDir, 'file://missing.md'))
        .resolves.toBeUndefined();
    });
  });

  describe('listStorageUriEntries()', () => {
    it('should return an empty array when the index does not exist', async () => {
      const entries = await listStorageUriEntries(projectionsDir);
      expect(entries).toEqual([]);
    });

    it('should return all written entries across shards', async () => {
      const written = [
        { uri: 'file://docs/overview.md', resourceId: 'res-1' },
        { uri: 'file://docs/guide.md', resourceId: 'res-2' },
        { uri: 'file://notes/todo.txt', resourceId: 'res-3' },
      ];
      for (const { uri, resourceId } of written) {
        await writeStorageUriEntry(projectionsDir, uri, resourceId);
      }

      const entries = await listStorageUriEntries(projectionsDir);
      expect(entries).toHaveLength(3);
      const byUri = Object.fromEntries(entries.map(e => [e.uri, e.resourceId]));
      expect(byUri).toEqual({
        'file://docs/overview.md': 'res-1',
        'file://docs/guide.md': 'res-2',
        'file://notes/todo.txt': 'res-3',
      });
    });

    it('should not include removed entries', async () => {
      await writeStorageUriEntry(projectionsDir, 'file://docs/overview.md', 'res-1');
      await writeStorageUriEntry(projectionsDir, 'file://docs/guide.md', 'res-2');
      await removeStorageUriEntry(projectionsDir, 'file://docs/overview.md');

      const entries = await listStorageUriEntries(projectionsDir);
      expect(entries).toEqual([{ uri: 'file://docs/guide.md', resourceId: 'res-2' }]);
    });
  });
});
