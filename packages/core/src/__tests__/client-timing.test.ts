/**
 * The client-timing table's generator refuses a table that cannot be meant.
 *
 * specs/src/client/timing.json is the authority every SDK generates its
 * deadlines and retry budgets from. A generated constant cannot drift from it,
 * so what is left to hold is the table itself: each case hands the generator
 * the committed table with one fault and expects a refusal that names it. The
 * first case is the control: the committed table is accepted.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = fileURLToPath(new URL('../../../../scripts/spec/generate-client-timing.mjs', import.meta.url));
const TABLE = fileURLToPath(new URL('../../../../specs/src/client/timing.json', import.meta.url));

interface Entry {
  name: string;
  value: unknown;
  docs?: string;
}

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'client-timing-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the generator on the committed table after `fault` has changed it. */
function generate(fault: (timing: Entry[]) => void): { status: number | null; stderr: string; out: string } {
  const table = JSON.parse(readFileSync(TABLE, 'utf8')) as { timing: Entry[] };
  fault(table.timing);
  const tablePath = join(dir, 'timing.json');
  const out = join(dir, 'client-timing.ts');
  writeFileSync(tablePath, JSON.stringify(table));
  const run = spawnSync(process.execPath, [GENERATOR, '--table', tablePath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, out };
}

const entry = (timing: Entry[], name: string): Entry => {
  const found = timing.find((e) => e.name === name);
  if (!found) throw new Error(`the committed table has no ${name}`);
  return found;
};

describe('the client-timing generator', () => {
  it('accepts the committed table, naming a duration and a budget as constants', () => {
    const run = generate(() => {});
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const generated = readFileSync(run.out, 'utf8');
    expect(generated).toContain('export const BUS_REQUEST_TIMEOUT_MS = 30000;');
    expect(generated).toContain('export const EMIT_RETRY: RetryPolicy = { attempts: 4, initialDelayMs: 1000, maxDelayMs: 4000 };');
  });

  it('refuses a name stated twice', () => {
    const run = generate((t) => {
      t.push({ ...entry(t, 'lingerMs') });
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('lingerMs is stated twice');
  });

  it('names a count as a constant', () => {
    const run = generate(() => {});
    expect(readFileSync(run.out, 'utf8')).toContain('export const SEEN_EVENT_IDS_COUNT = 512;');
  });

  it('refuses a count that is not a whole number above zero', () => {
    for (const value of [0, -5, 1.5, '512']) {
      const run = generate((t) => {
        entry(t, 'seenEventIdsCount').value = value;
      });
      expect(run.status, JSON.stringify(value)).toBe(1);
      expect(run.stderr).toContain('seenEventIdsCount is a count');
    }
  });

  it('refuses a name that says neither duration nor budget nor count', () => {
    const run = generate((t) => {
      entry(t, 'lingerMs').name = 'linger';
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"linger" is not a name');
  });

  it('refuses an entry with no docs', () => {
    const run = generate((t) => {
      delete entry(t, 'emitRetry').docs;
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('emitRetry has no docs');
  });

  it('refuses a duration that is not a whole number of milliseconds above zero', () => {
    for (const value of [0, -5, 1.5, '30000']) {
      const run = generate((t) => {
        entry(t, 'emitTimeoutMs').value = value;
      });
      expect(run.status, JSON.stringify(value)).toBe(1);
      expect(run.stderr).toContain('emitTimeoutMs is a duration');
    }
  });

  it('refuses a budget that is not exactly attempts and two delays', () => {
    const run = generate((t) => {
      entry(t, 'emitRetry').value = { attempts: 4, initialDelayMs: 1000 };
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('emitRetry is a budget');
  });

  it('refuses a budget that allows no attempt', () => {
    const run = generate((t) => {
      entry(t, 'refreshRetry').value = { attempts: 0, initialDelayMs: 500, maxDelayMs: 4000 };
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('refreshRetry allows no attempt');
  });

  it('refuses a backoff that starts above its ceiling', () => {
    const run = generate((t) => {
      entry(t, 'refreshRetry').value = { attempts: 4, initialDelayMs: 5000, maxDelayMs: 4000 };
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("refreshRetry's backoff starts above its ceiling");
  });
});
