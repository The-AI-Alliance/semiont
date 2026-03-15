/**
 * Exchange Format Manifest Types
 *
 * Defines the metadata structures for backup archives.
 * The manifest is the first entry in an archive and describes its contents.
 */

export const BACKUP_FORMAT = 'semiont-backup' as const;

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

// ── Validation ──

export function isBackupManifest(obj: unknown): obj is BackupManifestHeader {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as BackupManifestHeader).format === BACKUP_FORMAT
  );
}

export function validateManifestVersion(version: number): void {
  if (version > FORMAT_VERSION) {
    throw new Error(
      `Unsupported format version ${version}. This tool supports version ${FORMAT_VERSION}.`
    );
  }
}
