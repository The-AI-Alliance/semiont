/**
 * The locale registry's generator refuses a registry that cannot be meant.
 *
 * specs/src/locales/registry.json is the authority for which languages Semiont
 * supports and what each is called, so a generated row cannot drift from it.
 * What is left to hold is the registry itself: each case hands the generator
 * the committed one with one fault and expects a refusal that names it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCALES, LOCALE_CODES } from '../locales';

const at = (path: string): string => fileURLToPath(new URL(`../../../../${path}`, import.meta.url));
const GENERATOR = at('scripts/spec/generate-locales.mjs');
const TABLE = at('specs/src/locales/registry.json');

interface Row {
  code: string;
  nativeName?: string;
  englishName?: string;
  [key: string]: unknown;
}

interface Registry {
  locales: Row[];
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'locales-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator on the committed registry after `fault` has changed it. */
function generate(fault: (registry: Registry) => void): { status: number | null; stderr: string; out: string } {
  const registry = JSON.parse(readFileSync(TABLE, 'utf8')) as Registry;
  fault(registry);
  const tablePath = join(dir, 'registry.json');
  const out = join(dir, 'locales.ts');
  writeFileSync(tablePath, JSON.stringify(registry));
  const run = spawnSync(process.execPath, [GENERATOR, '--table', tablePath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, out };
}

const row = (registry: Registry, code: string): Row => {
  const found = registry.locales.find((r) => r.code === code);
  if (!found) throw new Error(`the committed registry has no ${code}`);
  return found;
};

describe('the locale registry generator', () => {
  it('accepts the committed registry, writing a row per language in its order', () => {
    const run = generate(() => {});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const generated = readFileSync(run.out, 'utf8');
    expect(generated).toContain("  { code: 'de', nativeName: 'Deutsch', englishName: 'German' },");
    const stated = (JSON.parse(readFileSync(TABLE, 'utf8')) as Registry).locales.map((r) => r.code);
    expect([...LOCALE_CODES]).toEqual(stated);
    expect(LOCALES.map((l) => l.code)).toEqual(stated);
  });

  it('refuses a language stated twice', () => {
    const run = generate((r) => {
      r.locales.push({ ...row(r, 'de') });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('de is stated twice');
  });

  it('refuses a code that is not a lower-case language code', () => {
    const run = generate((r) => {
      row(r, 'de').code = 'DE';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('DE is not a lower-case language code');
  });

  it('refuses a language with no native name, and one with no English name', () => {
    const noNative = generate((r) => {
      delete row(r, 'de').nativeName;
    });
    expect(noNative.status).toBe(1);
    expect(noNative.stderr).toContain('de states no nativeName');

    const noEnglish = generate((r) => {
      row(r, 'de').englishName = '';
    });
    expect(noEnglish.status).toBe(1);
    expect(noEnglish.stderr).toContain('de states no englishName');
  });

  it('refuses a row that states what no generator reads', () => {
    const run = generate((r) => {
      row(r, 'de').direction = 'ltr';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('de states direction, which nothing reads');
  });

  it('refuses a registry with no languages', () => {
    const run = generate((r) => {
      r.locales = [];
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the registry states no languages');
  });
});
