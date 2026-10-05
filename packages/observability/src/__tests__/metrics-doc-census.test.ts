/**
 * The Metrics table in docs/operator/administration/OBSERVABILITY.md restates,
 * by hand, the instruments this package creates. This holds the two to each
 * other: an instrument with no row is a series an operator cannot look up, and
 * a row with no instrument promises one that never arrives. Source-level on
 * purpose — counters and histograms are created at their first recording, so
 * no running process lists them all.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/operator/administration/OBSERVABILITY.md';

const CREATE = '\\.create(?:Counter|UpDownCounter|Histogram|Gauge|Observable(?:Counter|UpDownCounter|Gauge))\\(';

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the Metrics table in OBSERVABILITY.md', () => {
  const source = sources(SRC).map((file) => readFileSync(file, 'utf-8')).join('\n');
  const created = [...source.matchAll(new RegExp(`${CREATE}\\s*'(semiont\\.[^']+)'`, 'g'))].map((m) => m[1]!);
  const doc = readFileSync(join(SRC, '..', '..', '..', DOC), 'utf-8');
  const rows = [...doc.matchAll(/^\| `(semiont\.[^`]+)`/gm)].map((m) => m[1]!);

  it('reads every instrument the package creates', () => {
    expect(created.length, 'the walk found no instruments — the gate would pass on nothing').toBeGreaterThan(0);
    expect(
      source.match(new RegExp(CREATE, 'g'))?.length,
      "an instrument is created under a name this gate cannot read — give it a literal 'semiont.…' name",
    ).toBe(created.length);
  });

  it('has a row for every instrument', () => {
    const missing = created.filter((name) => !rows.includes(name));
    expect(missing, `no row in the Metrics table of ${DOC} — add one for each`).toEqual([]);
  });

  it('has no row for an instrument the package does not create', () => {
    const stale = rows.filter((name) => !created.includes(name));
    expect(stale, `rows in the Metrics table of ${DOC} that name no instrument — remove each`).toEqual([]);
  });
});
