#!/usr/bin/env node
/**
 * lint:state-unit-census — every TypeScript state unit is held to the
 * state-unit axioms, as every Rust and Python one is by its SDK's census
 * (packages/rust/sdk/tests/census.rs, packages/python/sdk/tests/test_census.py).
 * A unit added without a test that runs the axioms against it fails here.
 *
 * A unit is an interface that extends `StateUnit`, or a class that implements
 * it, in the source of a workspace under apps/, images/ or packages/, tests left out.
 * It is held when a test hands the harness a subject of it by name:
 * `assertStateUnitAxioms<BeckonStateUnit>({ ... })`. The type argument is the
 * census's evidence, as `type Unit = …` is Rust's and `AxiomSubject[…]` is
 * Python's, and the compiler holds the subject's `setup` to it. A call that
 * names no unit holds none.
 *
 * The harness's own probe (`DisposeProbe`, in packages/typescript/core/src/state-unit-axioms.ts)
 * stands in for what a unit is given, and is no unit.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HARNESS = 'packages/typescript/core/src/state-unit-axioms.ts';

const typescript = (file) => /^(apps|images|packages)\//.test(file) && /\.tsx?$/.test(file) && !file.endsWith('.d.ts');
const isTest = (file) => /(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/.test(file);
const read = (file) => withoutComments(readFileSync(join(ROOT, file), 'utf8'));
/** The names a heritage clause lists, each without its type arguments. */
const named = (clause) => clause.split(',').map((name) => name.trim().replace(/<.*$/s, ''));

const files = repositoryFiles(ROOT).filter(typescript);

/** unit → the file that declares it */
const units = new Map();
for (const file of files.filter((file) => !isTest(file) && file !== HARNESS)) {
  const source = read(file);
  for (const header of source.matchAll(/\binterface\s+(\w+)\s*(?:<[^>{]*>)?\s*extends\s+([^{]+?)\s*\{/g)) {
    if (named(header[2]).includes('StateUnit')) units.set(header[1], file);
  }
  for (const header of source.matchAll(/\bclass\s+(\w+)[^{]*?\bimplements\s+([^{]+?)\s*\{/g)) {
    if (named(header[2]).includes('StateUnit')) units.set(header[1], file);
  }
}

const held = new Set();
for (const file of files.filter(isTest)) {
  for (const call of read(file).matchAll(/\bassertStateUnitAxioms\s*<\s*(\w+)/g)) held.add(call[1]);
}

const failures = [];
// A census that finds nothing passes everything: it must find a unit it is known to have.
if (!units.has('MarkStateUnit')) failures.push('no `MarkStateUnit` was found among the units: this census cannot read where the units are declared');
for (const [unit, file] of units) {
  if (!held.has(unit)) failures.push(`${file}: ${unit} is a state unit that no test holds to the axioms: hand the harness a subject of it by name, \`assertStateUnitAxioms<${unit}>({ … })\`, from its tests`);
}

if (failures.length > 0) {
  console.error(`✗ lint:state-unit-census — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`✓ lint:state-unit-census — ${units.size} TypeScript state units, each held to the axioms by a test that names it`);
