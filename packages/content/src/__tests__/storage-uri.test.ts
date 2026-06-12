/**
 * Storage URI Derivation Tests
 *
 * Extension-mapping coverage lives with the registry in
 * @semiont/core's media-types tests; this file covers only the
 * name-slugging and URI assembly that @semiont/content owns.
 */

import { describe, it, expect } from 'vitest';
import { deriveStorageUri } from '../storage-uri';

describe('deriveStorageUri', () => {
  it('should slugify the name and append the registry extension', () => {
    expect(deriveStorageUri('My Document', 'text/markdown')).toBe('file://my-document.md');
  });

  it('should collapse runs of non-alphanumeric characters into single hyphens', () => {
    expect(deriveStorageUri('Q3 — Sales & Marketing (final)', 'application/pdf')).toBe('file://q3-sales-marketing-final.pdf');
  });

  it('should strip leading and trailing hyphens from the slug', () => {
    expect(deriveStorageUri('  (draft)  ', 'text/plain')).toBe('file://draft.txt');
  });

  it('should use the canonical registry extension for non-text types', () => {
    expect(deriveStorageUri('Team Photo', 'image/jpeg')).toBe('file://team-photo.jpg');
    expect(deriveStorageUri('Release Bundle', 'application/zip')).toBe('file://release-bundle.zip');
  });
});
