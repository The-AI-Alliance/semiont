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
// to agree with a client about the old value.
describe('the corpus against the tables it restates', () => {
  it('failure-codes answers with every code a failure can carry, and expects of each the client code specs/src/errors/codes.json gives it', () => {
    const { busRequest } = table<{ busRequest: { unrecognizedFailure: string; codes: Array<{ code: string; wire?: string }> } }>('errors/codes.json');
    const wireCodes = table<{ properties: { code: { enum: string[] } } }>('components/schemas/CommandError.json').properties.code.enum;
    const expected = (wire: unknown): string => busRequest.codes.find((entry) => entry.wire !== undefined && entry.wire === wire)?.code ?? busRequest.unrecognizedFailure;

    const answered: unknown[] = [];
    let last: { code: unknown } | undefined;
    for (const step of named('failure-codes').steps) {
      if ('backend' in step && step.backend === 'emit' && isObject(step.with?.['payload'])) {
        last = { code: step.with['payload']['code'] };
        answered.push(last.code);
      } else if ('settles' in step) {
        expect(last, 'a settle with no failure before it').toBeDefined();
        expect(step.fails, `the failure answering ${String(last!.code)}`).toEqual({ code: expected(last!.code) });
        last = undefined;
      }
    }
    expect(wireCodes.filter((code) => !answered.includes(code)), 'wire codes the case never answers with').toEqual([]);
    expect(answered, 'a failure stating no code').toContain(undefined);
    expect(answered.some((code) => typeof code === 'string' && !wireCodes.includes(code)), 'a failure stating a code the wire does not declare').toBe(true);
  });

  it('emit-budget-spent refuses as many attempts as specs/src/client/timing.json gives one emit', () => {
    const { timing } = table<{ timing: Array<{ name: string; value: unknown }> }>('client/timing.json');
    const budget = timing.find((entry) => entry.name === 'emitRetry')?.value as { attempts: number };
    const steps = named('emit-budget-spent').steps;
    const refused = steps.filter((step) => 'wire' in step && step.wire === 'POST /bus/emit' && step.status === 429);
    expect(refused).toHaveLength(budget.attempts);
    const scripted = steps.find((step) => 'backend' in step && step.backend === 'refuse');
    expect(scripted && 'with' in scripted ? scripted.with?.['times'] : undefined).toBe(budget.attempts);
  });
});

for (const [sdk, command] of Object.entries(inject('sdkDrivers'))) {
  eachPlane(`the ${sdk} SDK on the wire`, (world, plane) => {
    for (const kase of corpus) {
      if (kase.planes && !kase.planes.includes(plane)) continue;
      it(`${kase.name}: ${kase.about}`, () => runCase(world(), command, kase));
    }
  });
}
