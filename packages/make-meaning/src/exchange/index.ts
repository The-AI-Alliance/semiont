/**
 * Exchange Module — Knowledge Base Import/Export
 *
 * Two formats:
 * - Backup: Lossless round-trip of event log + content store (tar.gz)
 * - Snapshot: Current-state export of resources + annotations (JSONL or tar.gz)
 */

export { exportBackup, type BackupExporterOptions, type BackupEventStoreReader, type BackupContentReader } from './backup-exporter';
export { importBackup, type BackupImporterOptions, type BackupImportResult } from './backup-importer';
export { exportSnapshot, type SnapshotExporterOptions, type SnapshotViewReader, type SnapshotContentReader } from './snapshot-exporter';
export { importSnapshot, type SnapshotImporterOptions, type SnapshotImportResult } from './snapshot-importer';
export { type ReplayStats, type ContentBlobResolver } from './replay';
export {
  BACKUP_FORMAT,
  SNAPSHOT_FORMAT,
  FORMAT_VERSION,
  type BackupManifestHeader,
  type BackupStreamSummary,
  type SnapshotManifestHeader,
  type SnapshotResource,
  isBackupManifest,
  isSnapshotManifest,
  validateManifestVersion,
} from './manifest';
