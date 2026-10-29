/**
 * `index.html` is served before any language is chosen, so it names none. The
 * `lang` and `dir` of `<html>` are set when i18next has a language (see
 * `document-language.test.tsx`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('index.html', () => {
  it('declares no language', () => {
    const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const opening = html.match(/<html[^>]*>/);

    expect(opening?.[0]).toBe('<html>');
  });
});
