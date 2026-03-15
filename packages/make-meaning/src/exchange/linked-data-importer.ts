/**
 * Linked Data Importer
 *
 * Creates resources from a JSON-LD tar.gz archive exported by the linked-data exporter.
 * Unlike the backup importer, this is lossy — new resources are created (new IDs),
 * no event history is preserved. Entity types are restored from the manifest.
 *
 * Parses .semiont/manifest.jsonld for format validation and entity types,
 * then processes each .semiont/resources/{resourceId}.jsonld to create
 * resources and annotations via the EventBus → Stower pipeline.
 */

import type { Readable } from 'node:stream';
import { firstValueFrom, race, timer } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Logger, ResourceId, UserId, CreationMethod } from '@semiont/core';
import { EventBus } from '@semiont/core';
import type { components } from '@semiont/core';
import { readTarGz } from './tar';
import {
  LINKED_DATA_FORMAT,
  type LinkedDataManifest,
  isLinkedDataManifest,
  validateManifestVersion,
} from './manifest';

type ContentFormat = components['schemas']['ContentFormat'];
type Annotation = components['schemas']['Annotation'];

export interface LinkedDataImporterOptions {
  eventBus: EventBus;
  userId: UserId;
  logger?: Logger;
}

export interface LinkedDataImportResult {
  manifest: LinkedDataManifest;
  resourcesCreated: number;
  annotationsCreated: number;
  entityTypesAdded: number;
}

const IMPORT_TIMEOUT_MS = 30_000;

/**
 * Build a blob resolver closure over raw tar entries.
 *
 * Content blobs live at the archive root as {checksum}.{ext}.
 * Strips extension to index by checksum.
 */
function buildBlobResolver(entries: Map<string, Buffer>): (checksum: string) => Buffer | undefined {
  const checksumIndex = new Map<string, string>();
  for (const name of entries.keys()) {
    if (!name.startsWith('.semiont/')) {
      const dotIndex = name.lastIndexOf('.');
      const checksum = dotIndex >= 0 ? name.slice(0, dotIndex) : name;
      checksumIndex.set(checksum, name);
    }
  }

  return (checksum: string): Buffer | undefined => {
    const entryName = checksumIndex.get(checksum);
    return entryName ? entries.get(entryName) : undefined;
  };
}

/**
 * Import a JSON-LD archive by creating resources through the EventBus.
 *
 * Flow:
 *   1. Stream and decompress tar.gz entries
 *   2. Parse .semiont/manifest.jsonld → validate format
 *   3. Build blob resolver over root-level content entries
 *   4. Add entity types from manifest via mark:add-entity-type
 *   5. For each .semiont/resources/{id}.jsonld:
 *      a. Parse JSON-LD document
 *      b. Resolve content blob by checksum from representations
 *      c. Emit yield:create → await yield:created
 *      d. For each annotation: emit mark:create → await mark:created
 */
export async function importLinkedData(
  archive: Readable,
  options: LinkedDataImporterOptions,
): Promise<LinkedDataImportResult> {
  const { eventBus, userId, logger } = options;

  // Stream and decompress archive entries
  const entries = new Map<string, Buffer>();
  for await (const entry of readTarGz(archive)) {
    entries.set(entry.name, entry.data);
  }

  // 1. Parse manifest
  const manifestData = entries.get('.semiont/manifest.jsonld');
  if (!manifestData) {
    throw new Error('Invalid linked data archive: missing .semiont/manifest.jsonld');
  }

  const manifest: unknown = JSON.parse(manifestData.toString('utf8'));

  if (!isLinkedDataManifest(manifest)) {
    throw new Error(
      `Invalid linked data archive: expected format "${LINKED_DATA_FORMAT}", got "${(manifest as Record<string, unknown>)['semiont:format']}"`,
    );
  }
  validateManifestVersion(manifest['semiont:version']);

  logger?.info('Linked data import: parsed manifest', {
    entityTypes: manifest['semiont:entityTypes'].length,
    resources: manifest['void:entities'],
  });

  // 2. Build blob resolver
  const resolveBlob = buildBlobResolver(entries);

  // 3. Add entity types
  let entityTypesAdded = 0;
  for (const entityType of manifest['semiont:entityTypes']) {
    await addEntityType(entityType, userId, eventBus, logger);
    entityTypesAdded++;
  }

  // 4. Collect resource entries (sorted for deterministic order)
  const resourceEntries = [...entries.keys()]
    .filter((name) => name.startsWith('.semiont/resources/') && name.endsWith('.jsonld'))
    .sort();

  let resourcesCreated = 0;
  let annotationsCreated = 0;

  // 5. Process each resource
  for (const entryName of resourceEntries) {
    const resourceDoc = JSON.parse(entries.get(entryName)!.toString('utf8'));

    const result = await importResource(resourceDoc, userId, eventBus, resolveBlob, logger);
    resourcesCreated++;
    annotationsCreated += result.annotationsCreated;
  }

  logger?.info('Linked data import complete', {
    resourcesCreated,
    annotationsCreated,
    entityTypesAdded,
  });

  return {
    manifest,
    resourcesCreated,
    annotationsCreated,
    entityTypesAdded,
  };
}

// ── Individual import handlers ──

async function addEntityType(
  entityType: string,
  userId: UserId,
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:entity-type-added').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:entity-type-add-failed').pipe(map((e) => { throw e.error; })),
    timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:entity-type-added'); })),
  );

  eventBus.get('mark:add-entity-type').next({
    tag: entityType,
    userId,
  });

  await firstValueFrom(result$);
  logger?.debug('Added entity type', { entityType });
}

async function importResource(
  doc: Record<string, unknown>,
  userId: UserId,
  eventBus: EventBus,
  resolveBlob: (checksum: string) => Buffer | undefined,
  logger?: Logger,
): Promise<{ annotationsCreated: number }> {
  // Extract resource metadata from JSON-LD
  const name = doc['name'] as string;
  const representations = doc['representations'] as Array<Record<string, unknown>> | undefined;
  const annotations = doc['annotations'] as Annotation[] | undefined;
  const entityTypes = doc['entityTypes'] as string[] | undefined;
  const creationMethod = doc['creationMethod'] as string | undefined;

  // Get format and language from primary representation
  let format: ContentFormat = 'text/markdown';
  let language: string | undefined;
  let contentChecksum: string | undefined;

  if (representations && representations.length > 0) {
    const primary = representations[0]!;
    if (primary['encodingFormat']) format = primary['encodingFormat'] as ContentFormat;
    if (primary['inLanguage']) language = primary['inLanguage'] as string;
    if (primary['sha256']) contentChecksum = primary['sha256'] as string;
  }

  // Resolve content blob
  if (!contentChecksum) {
    throw new Error(`Resource "${name}" has no content checksum in representations`);
  }

  const blob = resolveBlob(contentChecksum);
  if (!blob) {
    throw new Error(`Missing content blob for checksum ${contentChecksum} (resource "${name}")`);
  }

  // Create resource via EventBus
  const createResult$ = race(
    eventBus.get('yield:created').pipe(map((r) => r)),
    eventBus.get('yield:create-failed').pipe(map((e) => { throw e.error; })),
    timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for yield:created'); })),
  );

  eventBus.get('yield:create').next({
    name,
    content: blob,
    format,
    userId,
    language,
    entityTypes: entityTypes ?? [],
    creationMethod: creationMethod as CreationMethod | undefined,
  });

  const created = await firstValueFrom(createResult$);
  const resourceId = created.resourceId;

  logger?.debug('Created resource from JSON-LD', { name, resourceId });

  // Create annotations
  let annotationsCreated = 0;
  if (annotations && annotations.length > 0) {
    for (const annotation of annotations) {
      await createAnnotation(annotation, resourceId, userId, eventBus, logger);
      annotationsCreated++;
    }
  }

  return { annotationsCreated };
}

async function createAnnotation(
  annotation: Annotation,
  resourceId: ResourceId,
  userId: UserId,
  eventBus: EventBus,
  logger?: Logger,
): Promise<void> {
  const result$ = race(
    eventBus.get('mark:created').pipe(map(() => 'ok' as const)),
    eventBus.get('mark:create-failed').pipe(map((e) => { throw e.error; })),
    timer(IMPORT_TIMEOUT_MS).pipe(map(() => { throw new Error('Timeout waiting for mark:created'); })),
  );

  eventBus.get('mark:create').next({
    annotation,
    userId,
    resourceId,
  });

  await firstValueFrom(result$);
  logger?.debug('Created annotation', { annotationId: annotation.id });
}
