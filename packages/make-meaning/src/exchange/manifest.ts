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

// ── Linked Data manifest (JSON-LD) ──

export const LINKED_DATA_FORMAT = 'semiont-linked-data' as const;

export interface LinkedDataManifest {
  '@context': Record<string, string>;
  '@type': string;
  'semiont:format': typeof LINKED_DATA_FORMAT;
  'semiont:version': number;
  'dct:created': string;
  'prov:wasGeneratedBy': {
    '@type': string;
    'prov:used': string;
  };
  'semiont:entityTypes': string[];
  'void:entities': number;
}

export function isLinkedDataManifest(obj: unknown): obj is LinkedDataManifest {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as LinkedDataManifest)['semiont:format'] === LINKED_DATA_FORMAT
  );
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
