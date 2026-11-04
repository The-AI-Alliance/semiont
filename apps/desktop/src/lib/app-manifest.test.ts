import { describe, it, expect } from 'vitest';
import { parseAppManifest } from './app-manifest';

describe('parseAppManifest', () => {
  it('parses the title', () => {
    expect(parseAppManifest('[app]\ntitle = "My App"')).toEqual({ title: 'My App' });
  });

  it('falls back to the default title when absent', () => {
    expect(parseAppManifest(null)).toEqual({ title: 'Semiont' });
    expect(parseAppManifest('[other]\nx = 1')).toEqual({ title: 'Semiont' });
  });
});
