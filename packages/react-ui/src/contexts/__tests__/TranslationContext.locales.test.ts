import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AVAILABLE_LOCALES } from '../TranslationContext';

describe('AVAILABLE_LOCALES', () => {
  it('names exactly the locales that have a translations file', () => {
    const translated = readdirSync(resolve(process.cwd(), 'translations'))
      .filter((file) => file.endsWith('.json'))
      .map((file) => basename(file, '.json'))
      .sort();

    expect([...AVAILABLE_LOCALES].sort()).toEqual(translated);
  });
});
