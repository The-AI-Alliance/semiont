import { describe, expect, it } from 'vitest';

import { readConfig } from './config.js';

describe('readConfig', () => {
  it('returns the branded url and token', () => {
    expect(readConfig({
      SEMIONT_API_URL: 'http://localhost:4000',
      SEMIONT_ACCESS_TOKEN: 'jwt-value',
    })).toEqual({ apiUrl: 'http://localhost:4000', token: 'jwt-value' });
  });

  it('throws when SEMIONT_API_URL is missing', () => {
    expect(() => readConfig({ SEMIONT_ACCESS_TOKEN: 'jwt-value' }))
      .toThrow('SEMIONT_API_URL environment variable is required');
  });

  it('throws when SEMIONT_ACCESS_TOKEN is missing', () => {
    expect(() => readConfig({ SEMIONT_API_URL: 'http://localhost:4000' }))
      .toThrow('SEMIONT_ACCESS_TOKEN environment variable is required');
  });

  it('rejects an empty value the same as an unset one', () => {
    expect(() => readConfig({ SEMIONT_API_URL: '', SEMIONT_ACCESS_TOKEN: 'jwt-value' }))
      .toThrow('SEMIONT_API_URL environment variable is required');
    expect(() => readConfig({ SEMIONT_API_URL: 'http://localhost:4000', SEMIONT_ACCESS_TOKEN: '' }))
      .toThrow('SEMIONT_ACCESS_TOKEN environment variable is required');
  });

  it('does not accept SEMIONT_API_TOKEN in place of SEMIONT_ACCESS_TOKEN', () => {
    expect(() => readConfig({
      SEMIONT_API_URL: 'http://localhost:4000',
      SEMIONT_API_TOKEN: 'jwt-value',
    })).toThrow('SEMIONT_ACCESS_TOKEN environment variable is required');
  });
});
