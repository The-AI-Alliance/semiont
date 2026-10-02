/**
 * The cache-refresh table's generator refuses a table that cannot be meant.
 *
 * specs/src/client/refresh.json is the authority every SDK generates from:
 * what each event on the bus, and the reopening of a dropped stream, does to a
 * client's cache. A generated table cannot drift from it, so what is left to
 * hold is the table itself: each case hands the generator the committed table
 * with one fault and expects a refusal that names it. The first case is the
 * control: the committed table is accepted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = fileURLToPath(new URL('../../../../scripts/spec/generate-cache-refresh.mjs', import.meta.url));
const TABLE = fileURLToPath(new URL('../../../../specs/src/client/refresh.json', import.meta.url));

interface Query {
  name: string;
  per?: string;
  asks: string;
  docs?: string;
}

interface Row {
  on: string;
  when?: string;
  reach?: string;
  refetches?: string[];
  writes?: string[];
  removes?: string[];
  docs?: string;
}

interface Table {
  queries: Query[];
  refresh: Row[];
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cache-refresh-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator on the committed table after `fault` has changed it. */
function generate(fault: (table: Table) => void): { status: number | null; stderr: string; out: string } {
  const table = JSON.parse(readFileSync(TABLE, 'utf8')) as Table;
  fault(table);
  const tablePath = join(dir, 'refresh.json');
  const out = join(dir, 'cache-refresh.ts');
  writeFileSync(tablePath, JSON.stringify(table));
  const run = spawnSync(process.execPath, [GENERATOR, '--table', tablePath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, out };
}

const row = (table: Table, on: string, when?: string): Row => {
  const found = table.refresh.find((r) => r.on === on && r.when === when);
  if (!found) throw new Error(`the committed table has no row for ${on}`);
  return found;
};

const refused = (fault: (table: Table) => void, saying: string): void => {
  const run = generate(fault);
  expect(run.status, run.stderr).toBe(1);
  expect(run.stderr).toContain(saying);
};

describe('the cache-refresh generator', () => {
  it('accepts the committed table, with a row per trigger and two for a split channel', () => {
    const run = generate(() => {});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const generated = readFileSync(run.out, 'utf8');
    expect(generated).toContain("'mark:added': [{ reach: 'subject', refetches: ['annotations', 'events'], writes: [], removes: [] }],");
    expect(generated).toContain("'reopened': [{ reach: 'held', ");
    expect(generated).toContain("'mark:body-updated': [{ when: 'enriched', ");
    expect(generated).toContain("{ when: 'unenriched', ");
  });

  it('refuses a query stated twice, one with no docs, and one that asks no operation', () => {
    refused((t) => t.queries.push({ ...t.queries[0]! }), 'the query resource is stated twice');
    refused((t) => delete t.queries[0]!.docs, 'the query resource has no docs');
    refused((t) => (t.queries[0]!.asks = 'browse:resource-result'), 'which is not an operation of the registry');
    refused((t) => (t.queries[0]!.per = 'page'), 'is kept per "page"');
  });

  it('refuses a trigger that is neither a channel nor reopened', () => {
    refused((t) => (row(t, 'mark:added').on = 'mark:invented'), '"mark:invented" is neither a channel of the registry nor `reopened`');
  });

  it('refuses a row with no docs, one that does nothing, and one stated twice', () => {
    refused((t) => delete row(t, 'mark:added').docs, 'mark:added has no docs');
    refused((t) => delete row(t, 'frame:entity-type-added').refetches, 'frame:entity-type-added does nothing');
    refused((t) => t.refresh.push({ ...row(t, 'mark:added') }), 'mark:added is stated twice');
  });

  it('refuses an act on something that is not a query, or on one query twice', () => {
    refused((t) => row(t, 'mark:added').refetches!.push('bookmarks'), 'mark:added refetches "bookmarks", which is not a query');
    refused((t) => (row(t, 'mark:removed').removes = ['annotations']), 'mark:removed acts on annotations twice');
  });

  it('refuses a reach that is neither, and a reopened that names a subject', () => {
    refused((t) => (row(t, 'mark:added').reach = 'everything'), 'mark:added reaches "everything"');
    refused((t) => (row(t, 'reopened').reach = 'subject'), 'reopened names no subject');
  });

  it('refuses a split the registry does not support, and one that is not whole', () => {
    refused((t) => (row(t, 'mark:removed').when = 'enriched'), 'the registry does not say its events are enriched');
    refused((t) => (row(t, 'mark:body-updated', 'enriched').when = 'sometimes'), 'mark:body-updated is split by "sometimes"');
    refused((t) => t.refresh.splice(t.refresh.indexOf(row(t, 'mark:body-updated', 'unenriched')), 1), 'mark:body-updated is split, so it has a row for each of enriched and unenriched');
  });

  it('refuses a row whose trigger nothing replays, unless reopened repairs what it refreshes', () => {
    // `yield:created` reaches every client on no scope: one published while a
    // stream is down is lost, and only `reopened` asks again for what it feeds.
    refused((t) => row(t, 'yield:created').refetches!.push('referencedBy'), 'yield:created refetches referencedBy, and nothing replays it');
    refused((t) => (row(t, 'reopened').refetches = row(t, 'reopened').refetches!.filter((q) => q !== 'entityTypes')), 'frame:entity-type-added refetches entityTypes');
    refused((t) => t.refresh.splice(t.refresh.indexOf(row(t, 'reopened')), 1), 'has no row for `reopened`');
  });

  it('refuses a write or a removal on a passing trigger', () => {
    refused((t) => (row(t, 'yield:updated').removes = ['annotation']), 'yield:updated removes annotation, and its frames are passing');
    refused((t) => (row(t, 'frame:tag-schema-added').writes = ['annotation']), 'frame:tag-schema-added writes annotation');
  });

  it('refuses a row that states something a row does not have', () => {
    refused((t) => Object.assign(row(t, 'mark:added'), { invalidates: ['annotations'] }), 'mark:added states invalidates');
  });
});
