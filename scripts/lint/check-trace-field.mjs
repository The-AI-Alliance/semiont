#!/usr/bin/env node
/**
 * lint:trace-field — the payload field a relayed frame's trace rides in is
 * written once, in the bus registry, and everything else names it by the
 * constant generated from there.
 *
 * The registry's `trace.field` (specs/src/bus/registry.json) is the field. The
 * generators write it into the committed vocabulary of TypeScript, Go and
 * Python (`GENERATED`), and the Rust SDK's build into its `channels` module;
 * the gateway and every SDK read it from those. A second place that spells
 * the field is a mirror nothing holds: a code literal, a comment, a document,
 * or a payload schema that declares it.
 *
 * So the field, as a word of its own, may appear only in the registry and in
 * the generated files, and each of those must still state it: a gate that
 * passes on silence would pass on a generator that stopped writing it.
 *
 * Every file of the repository is read (`repository-files.mjs`), except a
 * test's: a test writes the wire as it is sent, and a stale name there fails
 * that test. A link is not read: what it names is read where it is.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REGISTRY = 'specs/src/bus/registry.json';
const GENERATED = [
  'packages/core/src/bus-protocol.ts',
  'packages/go/sdk/bus/channels_gen.go',
  'packages/python/sdk/src/semiont/channels.py',
];
const TEST = /(^|\/)(__tests__|tests)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]*\.py$/;

const field = JSON.parse(readFileSync(join(ROOT, REGISTRY), 'utf8')).trace?.field;
if (typeof field !== 'string' || field === '') {
  console.error(`✗ lint:trace-field — ${REGISTRY} states no trace.field: the check has lost what it holds.`);
  process.exit(1);
}
const word = new RegExp(`(?<![\\w$])${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);

const allowed = new Set([REGISTRY, ...GENERATED]);
const stated = new Set();
const stray = [];
for (const file of repositoryFiles(ROOT)) {
  if (TEST.test(file) || !lstatSync(join(ROOT, file)).isFile()) continue;
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!word.test(line)) return;
    if (allowed.has(file)) stated.add(file);
    else stray.push(`    ${file}:${i + 1}  ${line.trim()}`);
  });
}

const silent = [...allowed].filter((file) => !stated.has(file));
if (silent.length > 0) {
  console.error(`✗ lint:trace-field — these no longer state ${field}, though only they may: ${silent.join(', ')}. Silence is not agreement.`);
}
if (stray.length > 0) {
  console.error(`✗ lint:trace-field — ${field} is written outside ${REGISTRY} and the files generated from it:`);
  console.error(stray.join('\n'));
  console.error("  Name the constant generated from the registry's `trace`; in prose, point at the registry.");
}
if (silent.length > 0 || stray.length > 0) process.exit(1);
console.log(`✓ lint:trace-field — ${field} is written in ${REGISTRY} and the ${GENERATED.length} files generated from it, and nowhere else`);
