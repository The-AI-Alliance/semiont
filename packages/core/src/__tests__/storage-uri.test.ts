/**
 * Storage URI Derivation Tests
 *
 * Extension-mapping coverage lives with the registry in the media-types
 * tests; this file covers name-slugging, URI assembly, and the folder
 * arithmetic the compose and generation forms do with the result.
 * Moved here with the function (GENERATION-OUTPUT-FORMAT D10).
 */

import { describe, it, expect } from 'vitest';
import {
  deriveStorageUri,
  storageFileName,
  folderOf,
  proposeStoragePath,
} from '../storage-uri';

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

describe('storageFileName — the fragment the form composes with', () => {
  it('is deriveStorageUri without the scheme', () => {
    expect(storageFileName('My Document', 'text/markdown')).toBe('my-document.md');
    expect(deriveStorageUri('My Document', 'text/markdown'))
      .toBe(`file://${storageFileName('My Document', 'text/markdown')}`);
  });

  it('carries no file:// prefix — the form renders that as a chip beside the input', () => {
    expect(storageFileName('Report', 'application/pdf')).not.toContain('file://');
  });

  it('slugs and extends exactly as the URI form does', () => {
    expect(storageFileName('Q3 — Sales & Marketing (final)', 'application/pdf'))
      .toBe('q3-sales-marketing-final.pdf');
  });
});

describe('folderOf — where a form proposes to save, read off the source', () => {
  it('strips the scheme and returns the folder without a trailing slash', () => {
    expect(folderOf('file://notes/q3/report.md')).toBe('notes/q3');
  });

  it('accepts a bare path — the scheme is optional', () => {
    expect(folderOf('notes/report.md')).toBe('notes');
  });

  it('answers "" at the tree root, where there is no folder to name', () => {
    expect(folderOf('file://report.md')).toBe('');
    expect(folderOf('report.md')).toBe('');
  });

  it('answers "" for a resource carrying no storageUri', () => {
    // ResourceViewerPage passes `getStorageUri(resource)` straight through,
    // and the type admits undefined — so the absent case is a caller reality,
    // not a defensive branch.
    expect(folderOf(undefined)).toBe('');
    expect(folderOf('')).toBe('');
  });
});

describe('proposeStoragePath — the Save location a form proposes (D11)', () => {
  it('names the file for the title, beside the source', () => {
    expect(proposeStoragePath('notes', 'Q3 Report', 'text/markdown')).toBe('notes/q3-report.md');
  });

  it('drops the folder segment at the tree root', () => {
    expect(proposeStoragePath('', 'Q3 Report', 'text/markdown')).toBe('q3-report.md');
  });

  it('rewrites the extension when the format changes', () => {
    // This is what keeps D7's mismatch refusal unreachable while the path is
    // untouched: the proposal owns the whole filename, extension included.
    expect(proposeStoragePath('notes', 'Q3 Report', 'application/pdf')).toBe('notes/q3-report.pdf');
    expect(proposeStoragePath('notes', 'Q3 Report', 'text/plain')).toBe('notes/q3-report.txt');
  });

  it('proposes nothing for an empty title — a bare ".md" is a hidden file, not an intent', () => {
    expect(proposeStoragePath('notes', '', 'text/markdown')).toBe('');
    expect(proposeStoragePath('', '', 'text/markdown')).toBe('');
  });

  it('treats a title that slugs away to nothing the same way', () => {
    expect(proposeStoragePath('notes', '   ', 'text/markdown')).toBe('');
    expect(proposeStoragePath('notes', '!!!', 'text/markdown')).toBe('');
  });

  it('composes with folderOf, which is how the clone form uses both', () => {
    const folder = folderOf('file://notes/q3/source.md');
    const proposed = proposeStoragePath(folder, 'Clone of Source', 'text/markdown');
    expect(proposed).toBe('notes/q3/clone-of-source.md');
    expect(folderOf(proposed)).toBe(folder);
  });
});
