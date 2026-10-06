/**
 * FilesystemViewStorage reads the view files the Archivist keeps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FilesystemViewStorage } from '../../storage/view-storage';
import type { ResourceView } from '../../storage/view-storage';
import { annotationId, getShardPath, resourceId } from '@semiont/core';
import type { Annotation, Logger, ResourceId } from '@semiont/core';
import { validators, formatErrors } from '@semiont/core/openapi';
import { promises as fs, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';

function viewOf(id: string, name: string, overrides: Partial<ResourceView['resource']> = {}, annotations: ResourceView['annotations']['annotations'] = []): ResourceView {
  const rid = resourceId(id);
  return {
    resource: {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': rid,
      name,
      representations: [],
      ...overrides,
    },
    annotations: { resourceId: rid, version: 1, updatedAt: '2026-01-01T00:00:00.000Z', annotations },
    lastSequence: 1,
  };
}

/** The strings the spec's table says a `ResourceId` refuses (specs/src/identifiers/kinds.json). */
const REFUSED: string[] = (
  JSON.parse(readFileSync(resolve(__dirname, '../../../../../specs/src/identifiers/kinds.json'), 'utf8')) as {
    kinds: Array<{ schema: string; refuses: Array<{ id: string }> }>;
  }
).kinds.find((kind) => kind.schema === 'ResourceId')!.refuses.map((refused) => refused.id);

describe('FilesystemViewStorage', () => {
  let resourcesDir: string;
  let storage: FilesystemViewStorage;

  const viewFile = (rid: ResourceId): string => {
    const [ab, cd] = getShardPath(rid);
    return join(resourcesDir, ab, cd, `${rid}.json`);
  };

  /** A view file as the Archivist leaves it. */
  const kept = async (view: ResourceView): Promise<void> => {
    const validate = validators.ResourceView;
    expect(validate(view), formatErrors(validate.errors)).toBe(true);
    const file = viewFile(resourceId(view.resource['@id']));
    await fs.mkdir(dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(view, null, 2), 'utf-8');
  };

  beforeEach(async () => {
    resourcesDir = join(tmpdir(), `semiont-test-viewstorage-${randomUUID()}`);
    await fs.mkdir(resourcesDir, { recursive: true });
    storage = new FilesystemViewStorage({ resourcesDir });
  });

  afterEach(async () => {
    await fs.rm(resourcesDir, { recursive: true, force: true });
  });

  describe('An id is one name in the file system', () => {
    // The type says a `ResourceId` is one. A value that got past the type is
    // text, and here is where that text would become a file's name.
    it.each(REFUSED)('no view is read for %j', async (text) => {
      await expect(storage.get(text as ResourceId)).rejects.toThrow(TypeError);
    });
  });

  describe('get()', () => {
    it('reads the view kept for a resource', async () => {
      const view = viewOf('doc1', 'Test Document', {
        representations: [
          { mediaType: 'text/plain', byteSize: 100, checksum: 'checksum1', created: '2026-01-01T00:00:00.000Z' },
          { mediaType: 'text/html', byteSize: 200, checksum: 'checksum2', created: '2026-01-01T00:00:00.000Z' },
        ],
      });
      await kept(view);

      expect(await storage.get(resourceId('doc1'))).toEqual(view);
    });

    it('reads the annotations the view carries', async () => {
      const annotation = (id: string): Annotation => ({
        '@context': 'http://www.w3.org/ns/anno.jsonld' as const,
        id: annotationId(id),
        type: 'Annotation' as const,
        motivation: 'commenting' as const,
        body: [{ type: 'TextualBody' as const, value: 'test comment', purpose: 'commenting' as const }],
        target: { source: resourceId('doc1') },
        created: '2026-01-01T00:00:00.000Z',
        creator: { '@id': 'http://localhost:4000/users/user1', '@type': 'Person' as const, name: 'user1' },
      });
      await kept(viewOf('doc1', 'Annotated Document', {}, [annotation('anno1'), annotation('anno2')]));

      const view = await storage.get(resourceId('doc1'));

      expect(view?.annotations.annotations.map((a) => a.id)).toEqual(['anno1', 'anno2']);
    });

    it('returns null where no view is kept', async () => {
      expect(await storage.get(resourceId('nonexistent'))).toBeNull();
    });

    it('reads a corrupted file as missing, and says so', async () => {
      const error = vi.fn();
      const logger = { error } as Partial<Logger> as Logger;
      const rid = resourceId('doc1');
      await fs.mkdir(dirname(viewFile(rid)), { recursive: true });
      await fs.writeFile(viewFile(rid), '{ "resource": ', 'utf-8');

      expect(await new FilesystemViewStorage({ resourcesDir }, logger).get(rid)).toBeNull();
      expect(error).toHaveBeenCalledTimes(1);
    });
  });
});
