/**
 * Exchange Format Manifest Types
 *
 * Defines the metadata structures for backup and snapshot formats.
 * The manifest is the first entry in an archive and describes its contents.
 */

export const BACKUP_FORMAT = 'semiont-backup' as const;
export const SNAPSHOT_FORMAT = 'semiont-snapshot' as const;
import type { CreationMethod } from '@semiont/core';

export const FORMAT_VERSION = 1;

// ── Backup manifest (JSONL: first line = header, subsequent lines = stream summaries) ──

export interface BackupManifestHeader {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  sourceUrl: string;
  stats: {
    streams: number;
    events: number;
    blobs: number;
    contentBytes: number;
  };
}

export interface BackupStreamSummary {
  stream: string; // resourceId or '__system__'
  eventCount: number;
  firstChecksum: string;
  lastChecksum: string;
}

// ── Snapshot manifest (first line of JSONL) ──

export interface SnapshotManifestHeader {
  format: typeof SNAPSHOT_FORMAT;
  version: number;
  exportedAt: string;
  sourceUrl: string;
  entityTypes: string[];
  stats: {
    resources: number;
  };
}

export interface SnapshotResource {
  id: string;
  name: string;
  format: string;
  language?: string;
  creationMethod: CreationMethod;
  entityTypes: string[];
  dateCreated: string;
  archived: boolean;
  content: {
    checksum: string;
    byteSize: number;
    text?: string;   // Inline for text/* content
    path?: string;   // Relative path in tar for binary content
  };
  annotations: unknown[]; // W3C annotation objects
}

// ── Validation ──

export function isBackupManifest(obj: unknown): obj is BackupManifestHeader {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as BackupManifestHeader).format === BACKUP_FORMAT
  );
}

export function isSnapshotManifest(obj: unknown): obj is SnapshotManifestHeader {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as SnapshotManifestHeader).format === SNAPSHOT_FORMAT
  );
}

export function validateManifestVersion(version: number): void {
  if (version > FORMAT_VERSION) {
    throw new Error(
      `Unsupported format version ${version}. This tool supports version ${FORMAT_VERSION}.`
    );
  }
}
