/**
 * Manifest Type Tests
 *
 * Tests format constants, type guards, and version validation
 * for backup and snapshot manifest headers.
 */

import { describe, it, expect } from 'vitest';
import {
  BACKUP_FORMAT,
  SNAPSHOT_FORMAT,
  FORMAT_VERSION,
  isBackupManifest,
  isSnapshotManifest,
  validateManifestVersion,
  type BackupManifestHeader,
  type SnapshotManifestHeader,
} from '../../exchange/manifest';

describe('manifest', () => {
  describe('constants', () => {
    it('has expected format strings', () => {
      expect(BACKUP_FORMAT).toBe('semiont-backup');
      expect(SNAPSHOT_FORMAT).toBe('semiont-snapshot');
    });

    it('has a numeric version', () => {
      expect(typeof FORMAT_VERSION).toBe('number');
      expect(FORMAT_VERSION).toBeGreaterThanOrEqual(1);
    });
  });

  describe('isBackupManifest', () => {
    it('returns true for a valid backup manifest', () => {
      const header: BackupManifestHeader = {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://localhost:8080',
        stats: { streams: 2, events: 10, blobs: 3, contentBytes: 5000 },
      };
      expect(isBackupManifest(header)).toBe(true);
    });

    it('returns false for a snapshot manifest', () => {
      const header: SnapshotManifestHeader = {
        format: SNAPSHOT_FORMAT,
        version: 1,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://localhost:8080',
        entityTypes: ['Person'],
        stats: { resources: 5 },
      };
      expect(isBackupManifest(header)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isBackupManifest(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isBackupManifest(undefined)).toBe(false);
    });

    it('returns false for a string', () => {
      expect(isBackupManifest('semiont-backup')).toBe(false);
    });

    it('returns false for an object with the wrong format', () => {
      expect(isBackupManifest({ format: 'wrong-format', version: 1 })).toBe(false);
    });

    it('returns false for an empty object', () => {
      expect(isBackupManifest({})).toBe(false);
    });
  });

  describe('isSnapshotManifest', () => {
    it('returns true for a valid snapshot manifest', () => {
      const header: SnapshotManifestHeader = {
        format: SNAPSHOT_FORMAT,
        version: 1,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://localhost:8080',
        entityTypes: [],
        stats: { resources: 0 },
      };
      expect(isSnapshotManifest(header)).toBe(true);
    });

    it('returns false for a backup manifest', () => {
      const header: BackupManifestHeader = {
        format: BACKUP_FORMAT,
        version: 1,
        exportedAt: '2026-03-12T00:00:00Z',
        sourceUrl: 'http://localhost:8080',
        stats: { streams: 0, events: 0, blobs: 0, contentBytes: 0 },
      };
      expect(isSnapshotManifest(header)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isSnapshotManifest(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isSnapshotManifest(undefined)).toBe(false);
    });
  });

  describe('validateManifestVersion', () => {
    it('accepts version equal to FORMAT_VERSION', () => {
      expect(() => validateManifestVersion(FORMAT_VERSION)).not.toThrow();
    });

    it('accepts version less than FORMAT_VERSION', () => {
      if (FORMAT_VERSION > 1) {
        expect(() => validateManifestVersion(FORMAT_VERSION - 1)).not.toThrow();
      } else {
        // version 1 is the minimum, and it should accept version 1
        expect(() => validateManifestVersion(1)).not.toThrow();
      }
    });

    it('rejects version greater than FORMAT_VERSION', () => {
      expect(() => validateManifestVersion(FORMAT_VERSION + 1)).toThrow(
        /Unsupported format version/
      );
    });

    it('rejects far-future versions', () => {
      expect(() => validateManifestVersion(999)).toThrow(
        /Unsupported format version 999/
      );
    });

    it('includes FORMAT_VERSION in the error message', () => {
      try {
        validateManifestVersion(FORMAT_VERSION + 1);
      } catch (e: unknown) {
        expect((e as Error).message).toContain(String(FORMAT_VERSION));
      }
    });
  });
});
