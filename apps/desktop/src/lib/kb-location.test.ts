import { describe, expect, it } from 'vitest';
import { isDirectKbDirectory, normalizeKbDirectory } from './kb-location';

describe('KB-relative directory paths', () => {
  it('normalizes separators and current-directory segments', () => {
    expect(normalizeKbDirectory('./notes//archive/')).toBe('notes/archive');
    expect(normalizeKbDirectory('.')).toBe('');
  });

  it('rejects absolute, traversal, and host-style paths', () => {
    expect(normalizeKbDirectory('/etc')).toBeNull();
    expect(normalizeKbDirectory('../outside')).toBeNull();
    expect(normalizeKbDirectory('notes/../../outside')).toBeNull();
    expect(normalizeKbDirectory('C:\\notes')).toBeNull();
  });

  it('recognizes only direct children under the current directory', () => {
    expect(isDirectKbDirectory('', 'notes')).toBe(true);
    expect(isDirectKbDirectory('notes', 'notes/archive')).toBe(true);
    expect(isDirectKbDirectory('notes', 'elsewhere/archive')).toBe(false);
    expect(isDirectKbDirectory('notes', 'notes/archive/2026')).toBe(false);
    expect(isDirectKbDirectory('notes', 'notes/../outside')).toBe(false);
  });
});
