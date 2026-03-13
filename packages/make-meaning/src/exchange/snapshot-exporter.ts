/**
 * Snapshot Exporter
 *
 * Exports the current state of the knowledge base as JSONL.
 * Reads from materialized views (fast — no event replay).
 *
 * Text content is inlined in the `text` field.
 * Binary content is written to a tar.gz wrapper with external files.
 *
 * Unlike the backup format, this is lossy — event history,
 * deleted annotations, and job state are not included.
 */

import type { Writable } from 'node:stream';
import type { Logger } from '@semiont/core';
import type { ResourceView } from '@semiont/event-sourcing';
import { getExtensionForMimeType } from '@semiont/content';
import { writeTarGz, type TarEntry } from './tar';
import {
  SNAPSHOT_FORMAT,
  FORMAT_VERSION,
  type SnapshotManifestHeader,
  type SnapshotResource,
} from './manifest';

/** Subset of ViewStorage used by the snapshot exporter. */
export interface SnapshotViewReader {
  getAll(): Promise<ResourceView[]>;
}

/** Subset of RepresentationStore used by the snapshot exporter. */
export interface SnapshotContentReader {
  retrieve(checksum: string, mediaType: string): Promise<Buffer>;
}

export interface SnapshotExporterOptions {
  views: SnapshotViewReader;
  content: SnapshotContentReader;
  sourceUrl: string;
  entityTypes: string[];
  includeArchived?: boolean;
  logger?: Logger;
}

/**
 * Export a snapshot of the current knowledge base state.
 *
 * If all content is text, writes plain JSONL to `output`.
 * If binary content exists, writes a tar.gz containing
 * snapshot.jsonl + content/{checksum}.{ext}.
 */
export async function exportSnapshot(
  options: SnapshotExporterOptions,
  output: Writable,
): Promise<SnapshotManifestHeader> {
  const { views, content, sourceUrl, entityTypes, includeArchived = false, logger } = options;

  const allViews = await views.getAll();
  const filtered = includeArchived
    ? allViews
    : allViews.filter((v) => !v.resource.archived);

  logger?.info('Snapshot export: enumerating resources', { total: allViews.length, filtered: filtered.length });

  // Build snapshot resources and collect binary content
  const resources: SnapshotResource[] = [];
  const binaryBlobs: Map<string, { data: Buffer; ext: string }> = new Map();
  let hasBinaryContent = false;

  for (const view of filtered) {
    const snapshotResource = await buildSnapshotResource(view, content, binaryBlobs, logger);
    if (snapshotResource) {
      resources.push(snapshotResource);
      if (snapshotResource.content.path) {
        hasBinaryContent = true;
      }
    }
  }

  const manifest: SnapshotManifestHeader = {
    format: SNAPSHOT_FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceUrl,
    entityTypes,
    stats: { resources: resources.length },
  };

  if (hasBinaryContent) {
    // Write tar.gz with snapshot.jsonl + content blobs
    await writeTarGzSnapshot(manifest, resources, binaryBlobs, output);
  } else {
    // Write plain JSONL
    const lines = [
      JSON.stringify(manifest),
      ...resources.map((r) => JSON.stringify(r)),
    ].join('\n') + '\n';
    output.write(lines);
    output.end();
  }

  logger?.info('Snapshot export complete', {
    resources: resources.length,
    binaryBlobs: binaryBlobs.size,
    hasBinaryContent,
  });

  return manifest;
}

async function buildSnapshotResource(
  view: ResourceView,
  contentStore: SnapshotContentReader,
  binaryBlobs: Map<string, { data: Buffer; ext: string }>,
  logger?: Logger,
): Promise<SnapshotResource | null> {
  const { resource, annotations } = view;

  // Find the original representation
  const reps = Array.isArray(resource.representations)
    ? resource.representations
    : resource.representations ? [resource.representations] : [];

  const original = reps.find((r) => r.rel === 'original') || reps[0];
  if (!original || !original.checksum) {
    logger?.warn('Snapshot export: resource has no usable representation', { id: resource['@id'] });
    return null;
  }

  // Extract resource ID from @id URI
  const idMatch = resource['@id']?.match(/\/resources\/(.+)$/);
  const id = idMatch ? idMatch[1] : resource['@id'] || '';

  // Retrieve content
  const contentData = await contentStore.retrieve(original.checksum, original.mediaType);
  const isText = original.mediaType.startsWith('text/');

  const snapshotContent: SnapshotResource['content'] = {
    checksum: original.checksum,
    byteSize: original.byteSize ?? contentData.length,
  };

  if (isText) {
    snapshotContent.text = contentData.toString('utf8');
  } else {
    const ext = getExtensionForMimeType(original.mediaType);
    const blobPath = `content/${original.checksum}${ext}`;
    snapshotContent.path = blobPath;
    binaryBlobs.set(original.checksum, { data: contentData, ext });
  }

  return {
    id,
    name: resource.name,
    format: original.mediaType,
    language: original.language,
    creationMethod: resource.creationMethod || 'api',
    entityTypes: resource.entityTypes || [],
    dateCreated: resource.dateCreated || new Date().toISOString(),
    archived: resource.archived || false,
    content: snapshotContent,
    annotations: annotations.annotations || [],
  };
}

async function writeTarGzSnapshot(
  manifest: SnapshotManifestHeader,
  resources: SnapshotResource[],
  binaryBlobs: Map<string, { data: Buffer; ext: string }>,
  output: Writable,
): Promise<void> {
  async function* generateEntries(): AsyncIterable<TarEntry> {
    // 1. snapshot.jsonl
    const lines = [
      JSON.stringify(manifest),
      ...resources.map((r) => JSON.stringify(r)),
    ].join('\n') + '\n';
    yield { name: 'snapshot.jsonl', data: Buffer.from(lines, 'utf8') };

    // 2. Binary content blobs
    for (const [checksum, { data, ext }] of binaryBlobs) {
      yield { name: `content/${checksum}${ext}`, data };
    }
  }

  await writeTarGz(generateEntries(), output);
}
