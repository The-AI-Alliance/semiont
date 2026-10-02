#!/usr/bin/env node
/**
 * Every internal dependency a committed package.json declares is `"*"`.
 *
 * `"*"` links the workspace copy and cannot drift. The exact version is
 * written at publish, by scripts/ci/stamp-internal-deps.mjs, and nowhere else.
 * A manifest committed with that stamp still installs in the workspace, where
 * the pin equals the workspace version, so nothing in CI fails; the publish
 * workflow's NodeNext check then installs each packed tarball on its own,
 * asks the registry for a version that is not published yet, and stops the
 * release after its tag is cut. That happened on 0.6.8.
 *
 * A `file:` specifier is a project outside the workspace naming a package by
 * path (tests/e2e, tests/conformance), and is left alone.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const internal = (name) => name.startsWith('@semiont/') || name.startsWith('semiont-');

const pinned = [];
for (const file of repositoryFiles(ROOT).filter((f) => basename(f) === 'package.json')) {
  const manifest = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  for (const section of SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (internal(name) && specifier !== '*' && !specifier.startsWith('file:')) {
        pinned.push(`${file}: ${section}["${name}"] is "${specifier}"`);
      }
    }
  }
}

if (pinned.length > 0) {
  console.error('Internal dependencies must be "*" in committed manifests:\n');
  for (const line of pinned) console.error(`  ${line}`);
  console.error('\nThe exact version is stamped at publish (scripts/ci/stamp-internal-deps.mjs).');
  console.error('A stamped manifest was committed; restore "*" here and in package-lock.json.');
  process.exit(1);
}
console.log('✅ every internal dependency in a committed manifest is "*"');
