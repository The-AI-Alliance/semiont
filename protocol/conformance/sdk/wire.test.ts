/**
 * The wire layer: every SDK, through its driver, put through every case in
 * sdk/wire/ against a real gateway on each signal plane. README.md states the
 * driver protocol and the case format; case.ts runs one case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, inject, it } from 'vitest';
import { SPEC_SOURCE } from '../harness/paths';
import { eachPlane } from '../harness/world';
import { cases, runCase, type Case } from './case';

const corpus = cases('wire');

const table = <T>(path: string): T => JSON.parse(readFileSync(join(SPEC_SOURCE, path), 'utf8')) as T;
const named = (name: string): Case => {
  const found = corpus.find((c) => c.name === name);
  if (!found) throw new Error(`the corpus has no case ${name}`);
  return found;
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// A case states what a table already states. These hold each to its table, so
// a table that changes fails the case that restates it rather than leaving it
// to agree with a client about a stale value.
describe('the corpus against the tables it restates', () => {
  it('failure-codes answers with every code a failure can carry, and expects of each the client code protocol/specs/src/errors/codes.json gives it', () => {
    const { busRequest, transport } = table<{
      busRequest: { unrecognizedFailure: string; codes: Array<{ code: string; wire?: string }> };
      transport: { unclassified: string };
    }>('errors/codes.json');
    const wireCodes = table<{ properties: { code: { enum: string[] } } }>('components/schemas/CommandError.json').properties.code.enum;
    // A failure with no words is not its channel's, and is refused as a result with a fault is.
    const expected = (failure: Record<string, unknown>): string =>
      typeof failure['message'] !== 'string'
        ? transport.unclassified
        : (busRequest.codes.find((entry) => entry.wire !== undefined && entry.wire === failure['code'])?.code ?? busRequest.unrecognizedFailure);

    const answered: unknown[] = [];
    let wordless = 0;
    let last: Record<string, unknown> | undefined;
    for (const step of named('failure-codes').steps) {
      if ('backend' in step && step.backend === 'emit' && isObject(step.with?.['payload'])) {
        last = step.with['payload'];
        if (typeof last['message'] === 'string') answered.push(last['code']);
        else wordless++;
      } else if ('settles' in step) {
        expect(last, 'a settle with no failure before it').toBeDefined();
        expect(step.fails, `the failure answering ${JSON.stringify(last)}`).toEqual({ code: expected(last!) });
        last = undefined;
      }
    }
    expect(wireCodes.filter((code) => !answered.includes(code)), 'wire codes the case never answers with').toEqual([]);
    expect(answered, 'a failure stating no code').toContain(undefined);
    expect(answered.some((code) => typeof code === 'string' && !wireCodes.includes(code)), 'a failure stating a code the wire does not declare').toBe(true);
    expect(wordless, 'a failure with no words').toBeGreaterThan(0);
  });

  it('emit-budget-spent refuses as many attempts as protocol/specs/src/client/timing.json gives one emit', () => {
    const { timing } = table<{ timing: Array<{ name: string; value: unknown }> }>('client/timing.json');
    const budget = timing.find((entry) => entry.name === 'emitRetry')?.value as { attempts: number };
    const steps = named('emit-budget-spent').steps;
    const refused = steps.filter((step) => 'wire' in step && step.wire === 'POST /bus/emit' && step.status === 429);
    expect(refused).toHaveLength(budget.attempts);
    const scripted = steps.find((step) => 'backend' in step && step.backend === 'refuse');
    expect(scripted && 'with' in scripted ? scripted.with?.['times'] : undefined).toBe(budget.attempts);
  });

  it('dedup-window has the new stream replay as many events as protocol/specs/src/client/timing.json has a client remember', () => {
    const { timing } = table<{ timing: Array<{ name: string; value: unknown }> }>('client/timing.json');
    const remembered = timing.find((entry) => entry.name === 'seenEventIdsCount')?.value;
    const steps = named('dedup-window').steps;
    const replayed = steps.find((step) => 'backend' in step && step.backend === 'record' && step.with?.['count'] !== undefined);
    expect(replayed && 'with' in replayed ? replayed.with?.['count'] : undefined).toBe(remembered);
    const delivered = steps.find((step) => 'frames' in step);
    expect(delivered && 'count' in delivered ? delivered.count : undefined).toBe(remembered);
  });
});

describe('the exemptions', () => {
  it('each names a case of the corpus, and says why', () => {
    for (const [sdk, { exempt }] of Object.entries(inject('sdkDrivers'))) {
      for (const [name, why] of Object.entries(exempt ?? {})) {
        expect(corpus.map((c) => c.name), `${sdk} is exempt from ${name}`).toContain(name);
        expect(why.trim(), `why ${sdk} is exempt from ${name}`).not.toBe('');
      }
    }
  });
});

for (const [sdk, { wire, exempt }] of Object.entries(inject('sdkDrivers'))) {
  if (!wire) continue;
  eachPlane(`the ${sdk} SDK on the wire`, (world, plane) => {
    for (const kase of corpus) {
      if (kase.planes && !kase.planes.includes(plane)) continue;
      const why = exempt?.[kase.name];
      if (why === undefined) {
        it(`${kase.name}: ${kase.about}`, () => runCase(world(), wire, kase, 'wire'));
      } else {
        // An exemption is held, not taken on trust: the driver must say it
        // cannot do what the case asks. One that can is not exempt.
        it(`${kase.name}: exempt, because ${why}`, async () => {
          await expect(runCase(world(), wire, kase, 'wire')).rejects.toThrow(/the driver does not implement /);
        });
      }
    }
  });
}
