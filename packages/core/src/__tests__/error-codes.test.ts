/**
 * The error-code table's generator refuses a table that lies.
 *
 * specs/src/errors/codes.json is the authority every SDK generates its error
 * vocabularies from. A generated type cannot drift from it, so the place the
 * table can still go wrong is against the facts it restates: the wire's own
 * failure codes (`CommandError.code`), and itself. Each case here hands the
 * generator the committed table with one such fault and expects a refusal that
 * names it. The first case is the control: the committed table is accepted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = fileURLToPath(new URL('../../../../scripts/spec/generate-error-codes.mjs', import.meta.url));
const TABLE = fileURLToPath(new URL('../../../../specs/src/errors/codes.json', import.meta.url));

interface Entry {
  code: string;
  docs?: string;
  wire?: string;
  status?: number;
  statusFrom?: number;
}
interface Table {
  busRequest: { docs: string; unrecognizedFailure: string; codes: Entry[] };
  transport: { docs: string; unclassified: string; codes: Entry[] };
  session: { docs: string; codes: Entry[] };
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'error-codes-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator on the committed table after `fault` has changed it. */
function generate(fault: (table: Table) => void): { status: number | null; stderr: string; out: string } {
  const table = JSON.parse(readFileSync(TABLE, 'utf8')) as Table;
  fault(table);
  const tablePath = join(dir, 'codes.json');
  const out = join(dir, 'error-codes.ts');
  writeFileSync(tablePath, JSON.stringify(table));
  const run = spawnSync(process.execPath, [GENERATOR, '--table', tablePath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, out };
}

const entry = (codes: Entry[], code: string): Entry => {
  const found = codes.find((e) => e.code === code);
  if (!found) throw new Error(`the committed table has no ${code}`);
  return found;
};

describe('the error-code generator', () => {
  it('accepts the committed table', () => {
    const run = generate(() => {});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(readFileSync(run.out, 'utf8')).toContain('export type BusRequestErrorCode');
  });

  it('refuses a bus code that restates a wire code CommandError does not declare', () => {
    const run = generate((t) => {
      entry(t.busRequest.codes, 'bus.timeout').wire = 'timed-out';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"timed-out", which CommandError.code does not declare');
  });

  it('refuses a table that leaves a wire code unmapped', () => {
    const run = generate((t) => {
      delete entry(t.busRequest.codes, 'bus.not-found').wire;
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('CommandError.code declares "not-found", and no busRequest code restates it');
  });

  it('refuses one wire code restated by two bus codes', () => {
    const run = generate((t) => {
      entry(t.busRequest.codes, 'bus.closed').wire = 'not-found';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the wire code "not-found" becomes both');
  });

  it('refuses a code stated twice', () => {
    const run = generate((t) => {
      t.session.codes.push({ ...entry(t.session.codes, 'session.auth-failed') });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"session" states session.auth-failed twice');
  });

  it('refuses a code with no docs', () => {
    const run = generate((t) => {
      delete entry(t.transport.codes, 'conflict').docs;
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('conflict has no docs');
  });

  it('refuses an unrecognized-failure code that is itself a recognized one', () => {
    const run = generate((t) => {
      t.busRequest.unrecognizedFailure = 'bus.not-found';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('an unrecognized failure cannot be a recognized one');
  });

  it('refuses one status claimed by two transport codes', () => {
    const run = generate((t) => {
      entry(t.transport.codes, 'conflict').status = 404;
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('status 404 is both not-found and conflict');
  });

  it('refuses an exact status that also falls in the open range', () => {
    const run = generate((t) => {
      entry(t.transport.codes, 'conflict').status = 503;
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("status 503 is conflict and also falls in unavailable's range");
  });

  it('refuses a transport code that nothing produces', () => {
    const run = generate((t) => {
      t.transport.codes.push({ code: 'gone', docs: 'A member with no status.' });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('gone maps from no status and is not the unclassified code');
  });
});
