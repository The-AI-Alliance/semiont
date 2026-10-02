/**
 * The generator of the kinds of id refuses what cannot be meant.
 *
 * specs/src/identifiers/kinds.json and each kind's schema are what every SDK
 * generates its id types from. A generated constructor cannot drift from
 * them, so what is left to hold is the generator's own refusals: each case
 * hands it the committed inputs with one fault and expects a refusal that
 * names it. The first case is the control: the committed inputs are accepted.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATOR = fileURLToPath(new URL('../../../../scripts/spec/generate-identifiers.mjs', import.meta.url));
const KINDS = fileURLToPath(new URL('../../../../specs/src/identifiers/kinds.json', import.meta.url));
const SCHEMAS = fileURLToPath(new URL('../../../../specs/src/components/schemas', import.meta.url));

/** The types as openapi-typescript writes the four schemas, before any is branded. */
const TYPES = [
  'export interface components {',
  '    schemas: {',
  '        AnnotationId: string;',
  '        JobId: string;',
  '        ResourceId: string;',
  '        UserId: string;',
  '    };',
  '}',
  '',
].join('\n');

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'identifiers-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Fault {
  kinds?: (kinds: Array<{ schema: string }>) => void;
  schema?: [name: string, change: (schema: Record<string, unknown>) => void];
  types?: (types: string) => string;
}

/** Run the generator on the committed inputs after `fault` has changed them. */
function generate(fault: Fault = {}): { status: number | null; stderr: string; types: string; out: string } {
  const table = JSON.parse(readFileSync(KINDS, 'utf8')) as { kinds: Array<{ schema: string }> };
  fault.kinds?.(table.kinds);
  const kindsPath = join(dir, 'kinds.json');
  writeFileSync(kindsPath, JSON.stringify(table));
  const schemas = join(dir, 'schemas');
  rmSync(schemas, { recursive: true, force: true });
  cpSync(SCHEMAS, schemas, { recursive: true });
  if (fault.schema) {
    const [name, change] = fault.schema;
    const path = join(schemas, `${name}.json`);
    const schema = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    change(schema);
    writeFileSync(path, JSON.stringify(schema));
  }
  const typesPath = join(dir, 'types.ts');
  writeFileSync(typesPath, fault.types ? fault.types(TYPES) : TYPES);
  const out = join(dir, 'identifiers.ts');
  const run = spawnSync(process.execPath, [GENERATOR, '--kinds', kindsPath, '--schemas', schemas, '--types', typesPath, '--out', out], { encoding: 'utf8' });
  return { status: run.status, stderr: run.stderr, types: readFileSync(typesPath, 'utf8'), out };
}

describe('the generator of the kinds of id', () => {
  it('accepts the committed kinds: each schema is branded, and each has a constructor whose check is its pattern', () => {
    const run = generate();
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.types).toContain('        ResourceId: string & { readonly __brand: "ResourceId" };');
    expect(run.types).toContain('        UserId: string & { readonly __brand: "UserId" };');
    expect(run.types).not.toMatch(/Id: string;/);
    const generated = readFileSync(run.out, 'utf8');
    expect(generated).toContain("const RESOURCE_ID = new RegExp(\"^[A-Za-z0-9_-]{1,128}$\", 'u');");
    expect(generated).toContain('export function isResourceId(value: string): value is ResourceId {');
    expect(generated).toContain('export function resourceId(value: string): ResourceId {');
    expect(generated).toContain('export function jobId(value: string): JobId {');
  });

  it('refuses a kind whose schema states no rule', () => {
    const run = generate({ schema: ['JobId', (schema) => delete schema['pattern']] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('JobId is not a string with a pattern and a description');
  });

  it('refuses a rule that is not a regular expression', () => {
    const run = generate({ schema: ['UserId', (schema) => { schema['pattern'] = '^did:(' }] });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("UserId's pattern is not a regular expression");
  });

  it('refuses a kind the generated types do not declare: a brand with nothing to brand', () => {
    const run = generate({ types: (types) => types.replace('        JobId: string;\n', '') });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('declares JobId as a string 0 times');
  });

  it('refuses a name that is not a kind of id', () => {
    const run = generate({ kinds: (kinds) => { kinds[0]!.schema = 'Motivation'; } });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"Motivation" is not a kind\'s name');
  });
});
