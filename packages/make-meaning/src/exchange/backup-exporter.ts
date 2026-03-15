/**
 * Backup Exporter
 *
 * Produces a lossless tar.gz archive of the system of record:
 * - Event log (all streams, JSONL format)
 * - Content store (content-addressed blobs)
 *
 * Reads events via EventStore and content via RepresentationStore.
 * The archive can restore a complete knowledge base.
 */

import type { Writable } from 'node:stream';
import type { ResourceId, StoredEvent, Logger } from '@semiont/core';
import { getExtensionForMimeType } from '@semiont/content';
import { writeTarGz, type TarEntry } from './tar';
import {
  BACKUP_FORMAT,
  FORMAT_VERSION,
  type BackupManifestHeader,
  type BackupStreamSummary,
} from './manifest';

/** Subset of EventStore used by the backup exporter. */
export interface BackupEventStoreReader {
  log: {
    storage: {
      getAllResourceIds(): Promise<ResourceId[]>;
    };
    getEvents(resourceId: ResourceId): Promise<StoredEvent[]>;
  };
}

/** Subset of RepresentationStore used by the backup exporter. */
export interface BackupContentReader {
  retrieve(checksum: string, mediaType: string): Promise<Buffer>;
}

export interface BackupExporterOptions {
  eventStore: BackupEventStoreReader;
  content: BackupContentReader;
  sourceUrl: string;
  logger?: Logger;
}

const SYSTEM_STREAM = '__system__' as ResourceId;

/**
 * Export a full backup of the knowledge base to a tar.gz stream.
 *
 * Archive structure:
 *   .semiont/manifest.jsonl              - Format metadata + per-stream checksums
 *   .semiont/events/__system__.jsonl     - System events
 *   .semiont/events/{resourceId}.jsonl   - Per-resource events
 *   {checksum}.{ext}                     - Content blobs (root level)
 */
export async function exportBackup(
  options: BackupExporterOptions,
  output: Writable,
): Promise<BackupManifestHeader> {
  const { eventStore, content, sourceUrl, logger } = options;

  // Collect all data before writing (we need stats for the manifest header)
  const resourceIds = await eventStore.log.storage.getAllResourceIds();
  logger?.info('Backup export: enumerating streams', { resourceCount: resourceIds.length });

  // Build stream data: system + all resources
  const allStreamIds = [SYSTEM_STREAM, ...resourceIds];
  const streamData: Map<string, StoredEvent[]> = new Map();
  let totalEvents = 0;

  for (const id of allStreamIds) {
    const events = await eventStore.log.getEvents(id);
    if (events.length > 0) {
      streamData.set(id, events);
      totalEvents += events.length;
    }
  }

  // Collect content checksums from resource.created events
  const contentRefs = collectContentRefs(streamData);
  logger?.info('Backup export: collected content refs', {
    streams: streamData.size,
    events: totalEvents,
    blobs: contentRefs.size,
  });

  // Read all content blobs
  const contentBlobs: Map<string, { data: Buffer; ext: string }> = new Map();
  let totalContentBytes = 0;

  for (const [checksum, mediaType] of contentRefs) {
    const data = await content.retrieve(checksum, mediaType);
    const ext = getExtensionForMimeType(mediaType);
    contentBlobs.set(checksum, { data, ext });
    totalContentBytes += data.length;
  }

  // Build manifest
  const streamSummaries: BackupStreamSummary[] = [];
  for (const [streamId, events] of streamData) {
    streamSummaries.push({
      stream: streamId,
      eventCount: events.length,
      firstChecksum: events[0].metadata.checksum || '',
      lastChecksum: events[events.length - 1].metadata.checksum || '',
    });
  }

  const manifestHeader: BackupManifestHeader = {
    format: BACKUP_FORMAT,
    version: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceUrl,
    stats: {
      streams: streamData.size,
      events: totalEvents,
      blobs: contentBlobs.size,
      contentBytes: totalContentBytes,
    },
  };

  // Stream tar entries
  async function* generateEntries(): AsyncIterable<TarEntry> {
    // 1. Manifest (JSONL: header + stream summaries)
    const manifestLines = [
      JSON.stringify(manifestHeader),
      ...streamSummaries.map((s) => JSON.stringify(s)),
    ].join('\n') + '\n';
    yield { name: '.semiont/manifest.jsonl', data: Buffer.from(manifestLines, 'utf8') };

    // 2. Event streams
    for (const [streamId, events] of streamData) {
      const fileName = streamId === SYSTEM_STREAM
        ? '.semiont/events/__system__.jsonl'
        : `.semiont/events/${streamId}.jsonl`;
      const jsonl = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
      yield { name: fileName, data: Buffer.from(jsonl, 'utf8') };
    }

    // 3. Content blobs
    for (const [checksum, { data, ext }] of contentBlobs) {
      yield { name: `${checksum}${ext}`, data };
    }
  }

  await writeTarGz(generateEntries(), output);

  logger?.info('Backup export complete', {
    streams: streamData.size,
    events: totalEvents,
    blobs: contentBlobs.size,
    contentBytes: totalContentBytes,
  });

  return manifestHeader;
}

/**
 * Extract content checksums and media types from resource.created events.
 */
function collectContentRefs(
  streamData: Map<string, StoredEvent[]>,
): Map<string, string> {
  const refs = new Map<string, string>();

  for (const [, events] of streamData) {
    for (const stored of events) {
      if (stored.event.type === 'resource.created') {
        const payload = stored.event.payload as {
          contentChecksum?: string;
          format?: string;
        };
        if (payload.contentChecksum && payload.format) {
          refs.set(payload.contentChecksum, payload.format);
        }
      }
    }
  }

  return refs;
}
