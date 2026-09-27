/**
 * How a ${VAR} in a knowledge base's config resolves is one rule in two
 * languages: every case in specs/src/config-placeholders/cases.json, run
 * through the TypeScript loader's resolver. The launcher runs the same table
 * in Go (apps/launcher/internal/launcher/placeholders_agreement_test.go),
 * where it resolves the gateway's configuration document.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveEnvVars } from '../config/toml-loader';

interface PlaceholderCase {
  why: string;
  template: string;
  env: Record<string, string>;
  result?: string;
  error?: string;
}

const TABLE = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/config-placeholders/cases.json');
const { cases } = JSON.parse(readFileSync(TABLE, 'utf-8')) as { cases: PlaceholderCase[] };

describe('config placeholders — the TypeScript resolver agrees with the shared table', () => {
  it('the table has cases: a gate that runs nothing passes on silence', () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  it.each(cases)('$why', (c) => {
    if (c.error !== undefined) {
      expect(() => resolveEnvVars(c.template, c.env)).toThrow(c.error);
    } else {
      expect(resolveEnvVars(c.template, c.env)).toBe(c.result);
    }
  });
});
