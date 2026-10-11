/**
 * The Metrics table in docs/operator/administration/OBSERVABILITY.md restates,
 * by hand, the instruments an operator can look up. This holds it to what
 * creates them: an instrument of this package with no row is a series an
 * operator cannot look up, and a row with no instrument promises one that
 * never arrives. Source-level on purpose — counters and histograms are created
 * at their first recording, so no running process lists them all.
 *
 * Not every row is this package's. A service in another language creates its
 * own instruments (the worker's are Python's), and the table of what every
 * service exports, specs/src/service-telemetry/telemetry.json, is what says so:
 * each service's own suite holds it to that table. So a row is stale only when
 * neither this package nor that table has its instrument.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(SRC, '..', '..', '..');
const DOC = 'docs/operator/administration/OBSERVABILITY.md';
const EXPORTED = 'specs/src/service-telemetry/telemetry.json';

/** The name of every metric the table of what services export lists. */
function exportedMetrics(table: unknown): string[] {
  if (typeof table !== 'object' || table === null || !('metrics' in table) || !Array.isArray(table.metrics)) {
    throw new Error(`${EXPORTED} has no list of metrics`);
  }
  return table.metrics.map((metric: unknown) => {
    if (typeof metric !== 'object' || metric === null || !('name' in metric) || typeof metric.name !== 'string') {
      throw new Error(`${EXPORTED} lists a metric with no name`);
    }
    return metric.name;
  });
}

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
  const doc = readFileSync(join(ROOT, DOC), 'utf-8');
  const rows = [...doc.matchAll(/^\| `(semiont\.[^`]+)`/gm)].map((m) => m[1]!);
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, EXPORTED), 'utf-8'));
  const exported = exportedMetrics(parsed);

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

  it('has no row for an instrument nothing creates', () => {
    expect(exported.length, `${EXPORTED} lists no metric — the gate would pass on nothing`).toBeGreaterThan(0);
    const stale = rows.filter((name) => !created.includes(name) && !exported.includes(name));
    expect(
      stale,
      `rows in the Metrics table of ${DOC} that name an instrument neither this package creates nor ${EXPORTED} lists — remove each`,
    ).toEqual([]);
  });
});
