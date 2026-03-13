/**
 * Snapshot Importer
 *
 * Restores a knowledge base from a snapshot (JSONL or tar.gz).
 * Unlike backup import, this creates new resources from current-state
 * data — no event history is preserved.
 *
 * Accepts a Readable stream so callers can pipe directly from disk
 * or network without buffering the entire file first.
 * Events flow through EventBus → Stower for all writes.
 */

import type { Readable } from 'node:stream';
import { firstValueFrom, race, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Logger, UserId } from '@semiont/core';
import { EventBus } from '@semiont/core';
import type { components } from '@semiont/core';
import { readTarGz } from './tar';
import {
  SNAPSHOT_FORMAT,
  type SnapshotManifestHeader,
  type SnapshotResource,
  isSnapshotManifest,
  validateManifestVersion,
} from './manifest';

type ContentFormat = components['schemas']['ContentFormat'];
type Annotation = components['schemas']['Annotation'];

export interface SnapshotImporterOptions {
  eventBus: EventBus;
  userId: UserId;
  logger?: Logger;
}

export interface SnapshotImportResult {
  manifest: SnapshotManifestHeader;
  resourcesCreated: number;
  annotationsCreated: number;
  entityTypesAdded: number;
}

const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Read all chunks from a Readable into a Buffer.
 * Used to peek at the first two bytes for gzip detection.
 */
async function collectStream(input: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Import a snapshot.
 *
 * Accepts a Readable stream containing either:
 * - Plain JSONL (text-only snapshots)
 * - tar.gz (snapshots with binary content)
 *
 * Detection is automatic based on the gzip magic number.
 */
export async function importSnapshot(
  input: Readable,
  options: SnapshotImporterOptions,
): Promise<SnapshotImportResult> {
  const { eventBus, userId, logger } = options;

  // Buffer enough to detect format, then process
  const data = await collectStream(input);

  // Detect format: gzip starts with 0x1f 0x8b
  const isGzip = data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;

  let jsonlText: string;
  const binaryBlobs = new Map<string, Buffer>();

  if (isGzip) {
    // Re-wrap buffer as a binary-mode Readable for the tar reader.
    // Readable.from() creates an object-mode stream which breaks pipe to gunzip.
    const { Readable: ReadableStream } = await import('node:stream');
    const bufferStream = new ReadableStream({ read() {} });
    bufferStream.push(data);
    bufferStream.push(null);

    const entries = new Map<string, Buffer>();
    for await (const entry of readTarGz(bufferStream)) {
      entries.set(entry.name, entry.data);
    }

    const snapshotData = entries.get('snapshot.jsonl');
    if (!snapshotData) {
      throw new Error('Invalid snapshot archive: missing snapshot.jsonl');
    }
    jsonlText = snapshotData.toString('utf8');

    // Collect binary content blobs
    for (const [name, buf] of entries) {
      if (name.startsWith('content/')) {
        const filename = name.slice('content/'.length);
        const dotIndex = filename.lastIndexOf('.');
        const checksum = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
        binaryBlobs.set(checksum, buf);
      }
    }
  } else {
    jsonlText = data.toString('utf8');
  }

  // Parse JSONL
  const lines = jsonlText.trim().split('\n');
  const header = JSON.parse(lines[0]);

  if (!isSnapshotManifest(header)) {
    throw new Error(`Invalid snapshot: expected format "${SNAPSHOT_FORMAT}", got "${header.format}"`);
  }
  validateManifestVersion(header.version);

  const resources: SnapshotResource[] = lines.slice(1).map((line) => JSON.parse(line));

  logger?.info('Snapshot import: parsed', {
    resources: resources.length,
    entityTypes: header.entityTypes.length,
    binaryBlobs: binaryBlobs.size,
  });

  let entityTypesAdded = 0;
  let resourcesCreated = 0;
  let annotationsCreated = 0;

  // 1. Add entity types
  for (const entityType of header.entityTypes) {
    const result$ = race(
      eventBus.get('mark:entity-type-added').pipe(map(() => 'ok' as const)),
      eventBus.get('mark:entity-type-add-failed').pipe(map((e) => { throw e.error; })),
      timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error(`Timeout adding entity type: ${entityType}`); })),
    );

    eventBus.get('mark:add-entity-type').next({ tag: entityType, userId });
    await firstValueFrom(result$);
    entityTypesAdded++;
  }

  // 2. Import each resource
  for (const resource of resources) {
    // Resolve content buffer
    let contentBuffer: Buffer;
    if (resource.content.text !== undefined) {
      contentBuffer = Buffer.from(resource.content.text, 'utf8');
    } else if (resource.content.path) {
      const checksum = resource.content.checksum;
      const blob = binaryBlobs.get(checksum);
      if (!blob) {
        throw new Error(`Missing binary content for resource ${resource.id} (checksum: ${checksum})`);
      }
      contentBuffer = blob;
    } else {
      logger?.warn('Snapshot import: resource has no content', { id: resource.id });
      continue;
    }

    // Create resource via EventBus
    const createResult$ = race(
      eventBus.get('yield:created').pipe(map((r) => r)),
      eventBus.get('yield:create-failed').pipe(map((e) => { throw e.error; })),
      timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error(`Timeout creating resource: ${resource.name}`); })),
    );

    eventBus.get('yield:create').next({
      name: resource.name,
      content: contentBuffer,
      format: resource.format as ContentFormat,
      userId,
      language: resource.language,
      entityTypes: resource.entityTypes,
      creationMethod: resource.creationMethod,
    });

    const created = await firstValueFrom(createResult$);
    resourcesCreated++;

    // Create annotations
    for (const annotation of resource.annotations) {
      const ann = annotation as Annotation;
      const annResult$ = race(
        eventBus.get('mark:created').pipe(map(() => 'ok' as const)),
        eventBus.get('mark:create-failed').pipe(map((e) => { throw e.error; })),
        timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error(`Timeout creating annotation: ${ann.id}`); })),
      );

      eventBus.get('mark:create').next({
        annotation: ann,
        userId,
        resourceId: created.resourceId,
      });

      await firstValueFrom(annResult$);
      annotationsCreated++;
    }

    logger?.debug('Snapshot import: resource imported', {
      name: resource.name,
      annotations: resource.annotations.length,
    });
  }

  logger?.info('Snapshot import complete', {
    resourcesCreated,
    annotationsCreated,
    entityTypesAdded,
  });

  return {
    manifest: header,
    resourcesCreated,
    annotationsCreated,
    entityTypesAdded,
  };
}
