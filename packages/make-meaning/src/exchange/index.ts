/**
 * Exchange Module — Knowledge Base Backup/Restore + Linked Data Export/Import
 */

// Backup (full event-log round-trip)
export { exportBackup, type BackupExporterOptions, type BackupEventStoreReader, type BackupContentReader } from './backup-exporter';
export { importBackup, type BackupImporterOptions, type BackupImportResult } from './backup-importer';
export { type ReplayStats, type ContentBlobResolver } from './replay';
export {
  BACKUP_FORMAT,
  FORMAT_VERSION,
  type BackupManifestHeader,
  type BackupStreamSummary,
  isBackupManifest,
  validateManifestVersion,
} from './manifest';

// Linked Data (current-state JSON-LD export/import)
export { exportLinkedData, type LinkedDataExporterOptions, type LinkedDataViewReader, type LinkedDataContentReader } from './linked-data-exporter';
export { importLinkedData, type LinkedDataImporterOptions, type LinkedDataImportResult } from './linked-data-importer';
