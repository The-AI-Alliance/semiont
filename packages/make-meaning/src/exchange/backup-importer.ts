/**
 * Backup Importer
 *
 * Restores a knowledge base from a backup tar.gz archive.
 * Replays events through the EventBus → Stower pipeline so all
 * derived state (materialized views, graph) rebuilds naturally.
 *
 * Accepts a Readable stream so callers can pipe directly from disk
 * or network without buffering the entire archive first.
 * Content blobs are resolved lazily via a closure over the parsed
 * tar entries, avoiding a separate copy of all blob data in memory.
 */

import type { Readable } from 'node:stream';
import type { Logger } from '@semiont/core';
import { EventBus } from '@semiont/core';
import { readTarGz } from './tar';
import {
  BACKUP_FORMAT,
  type BackupManifestHeader,
  type BackupStreamSummary,
  isBackupManifest,
  validateManifestVersion,
} from './manifest';
import { replayEventStream, type ReplayStats, type ContentBlobResolver } from './replay';

export interface BackupImporterOptions {
  eventBus: EventBus;
  logger?: Logger;
}

export interface BackupImportResult {
  manifest: BackupManifestHeader;
  stats: ReplayStats;
  hashChainValid: boolean;
}

/**
 * Build a blob resolver closure over raw tar entries.
 *
 * Extracts the checksum from entry names like "content/{checksum}.{ext}"
 * and returns the Buffer on demand. The entries map is shared — not copied.
 */
function buildBlobResolver(entries: Map<string, Buffer>): ContentBlobResolver {
  // Build a checksum → entry-name index (lightweight — just strings)
  const checksumIndex = new Map<string, string>();
  for (const name of entries.keys()) {
    if (name.startsWith('content/')) {
      const filename = name.slice('content/'.length);
      const dotIndex = filename.lastIndexOf('.');
      const checksum = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
      checksumIndex.set(checksum, name);
    }
  }

  return (checksum: string): Buffer | undefined => {
    const entryName = checksumIndex.get(checksum);
    return entryName ? entries.get(entryName) : undefined;
  };
}

/**
 * Import a backup archive by replaying events through the EventBus.
 *
 * Flow:
 *   1. Stream and decompress tar.gz entries
 *   2. Parse manifest.jsonl → validate format
 *   3. Build blob resolver over content/ entries
 *   4. Replay __system__.jsonl (entity types)
 *   5. Replay each {resourceId}.jsonl (resources, annotations)
 *
 * Events flow: importer → EventBus → Stower → EventStore + Views
 */
export async function importBackup(
  archive: Readable,
  options: BackupImporterOptions,
): Promise<BackupImportResult> {
  const { eventBus, logger } = options;

  // Stream and decompress archive entries
  const entries = new Map<string, Buffer>();
  for await (const entry of readTarGz(archive)) {
    entries.set(entry.name, entry.data);
  }

  // 1. Parse manifest
  const manifestData = entries.get('manifest.jsonl');
  if (!manifestData) {
    throw new Error('Invalid backup: missing manifest.jsonl');
  }

  const manifestLines = manifestData.toString('utf8').trim().split('\n');
  const header = JSON.parse(manifestLines[0]);

  if (!isBackupManifest(header)) {
    throw new Error(`Invalid backup: expected format "${BACKUP_FORMAT}", got "${header.format}"`);
  }
  validateManifestVersion(header.version);

  const streamSummaries: BackupStreamSummary[] = manifestLines
    .slice(1)
    .map((line) => JSON.parse(line));

  logger?.info('Backup import: parsed manifest', {
    streams: header.stats.streams,
    events: header.stats.events,
    blobs: header.stats.blobs,
  });

  // 2. Build blob resolver (closure over entries — no extra copy)
  const resolveBlob = buildBlobResolver(entries);

  // 3. Replay system events first (entity types)
  const systemData = entries.get('events/__system__.jsonl');
  let stats: ReplayStats = { eventsReplayed: 0, resourcesCreated: 0, annotationsCreated: 0, entityTypesAdded: 0 };
  let hashChainValid = true;

  if (systemData) {
    const result = await replayEventStream(
      systemData.toString('utf8'),
      eventBus,
      resolveBlob,
      logger,
    );
    stats = mergeStats(stats, result.stats);
    if (!result.hashChainValid) hashChainValid = false;
  }

  // 4. Replay resource event streams
  for (const summary of streamSummaries) {
    if (summary.stream === '__system__') continue;

    const eventData = entries.get(`events/${summary.stream}.jsonl`);
    if (!eventData) {
      logger?.warn('Backup import: missing event stream', { stream: summary.stream });
      continue;
    }

    const result = await replayEventStream(
      eventData.toString('utf8'),
      eventBus,
      resolveBlob,
      logger,
    );
    stats = mergeStats(stats, result.stats);
    if (!result.hashChainValid) hashChainValid = false;
  }

  logger?.info('Backup import complete', { ...stats, hashChainValid });

  return { manifest: header, stats, hashChainValid };
}

function mergeStats(a: ReplayStats, b: ReplayStats): ReplayStats {
  return {
    eventsReplayed: a.eventsReplayed + b.eventsReplayed,
    resourcesCreated: a.resourcesCreated + b.resourcesCreated,
    annotationsCreated: a.annotationsCreated + b.annotationsCreated,
    entityTypesAdded: a.entityTypesAdded + b.entityTypesAdded,
  };
}
