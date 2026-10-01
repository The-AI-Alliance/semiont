#!/usr/bin/env node
/**
 * lint:conformance-readmes — each conformance suite's README says what every
 * one of its case files checks.
 *
 * For each suite under tests/conformance (a directory with a README.md and
 * `*.test.ts` files), every case file is named in the README in backticks, and
 * every case file the README names exists: a bare name in the suite, a path
 * from tests/conformance.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CONFORMANCE = 'tests/conformance';
const failures = [];

const suites = readdirSync(join(ROOT, CONFORMANCE))
  .map((entry) => `${CONFORMANCE}/${entry}`)
  .filter((dir) => statSync(join(ROOT, dir)).isDirectory() && existsSync(join(ROOT, dir, 'README.md')))
  .map((dir) => ({ dir, cases: readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.test.ts')) }))
  .filter(({ cases }) => cases.length > 0);

if (suites.length === 0) failures.push(`no suite under ${CONFORMANCE} has a README.md and case files`);

for (const { dir, cases } of suites) {
  const readme = readFileSync(join(ROOT, dir, 'README.md'), 'utf8');
  const named = new Set([...readme.matchAll(/`([^`\s]+\.test\.ts)`/g)].map((m) => m[1]));
  for (const file of cases) {
    if (!named.has(file)) failures.push(`${dir}/README.md does not say what ${file} checks`);
  }
  for (const name of named) {
    const path = name.includes('/') ? join(ROOT, CONFORMANCE, name) : join(ROOT, dir, name);
    if (!existsSync(path)) failures.push(`${dir}/README.md names ${name}, which does not exist`);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:conformance-readmes — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:conformance-readmes — ${suites.map(({ dir, cases }) => `${dir} (${cases.length})`).join(' and ')}: every case file named in its README, and every one named exists`);
