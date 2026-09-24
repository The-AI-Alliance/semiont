#!/usr/bin/env node
/**
 * Coverage reporters, excludes and provider are one decision, and fifteen
 * files used to restate a subset of it.
 *
 * `vitest.shared.config.ts` says what a coverage run emits. A package that
 * does not derive from it inherits vitest's defaults instead — `text, html,
 * clover, json`, none of which the CI upload reads. The result is not an
 * error: `test:coverage` passes, the upload finds no `lcov.info`, the step
 * swallows it, and the package is simply absent from the coverage everyone
 * reads. Twelve of sixteen packages were in that state until this gate.
 *
 * So: every workspace that declares `test:coverage` must have a vitest config,
 * and that config must derive from the shared one. Nothing here checks what a
 * package's coverage IS — only that it is measured the way the repo decided to
 * measure it.
 *
 * A config that re-declares `coverage.reporter` fails too, and that rule has
 * teeth beyond tidiness: `mergeConfig` CONCATENATES arrays, so a local
 * reporter list does not override the shared one, it appends to it. The
 * reporters silently run twice. Re-declaring the list is also precisely the
 * mirror this gate exists to collapse — it would be the drift coming back
 * wearing a merge.
 *
 * A workspace that cannot be read is a FAILURE, not a pass.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { basename, dirname } from 'path';

const SHARED = 'vitest.shared.config';

/** Expand `workspaces` globs against the filesystem — no install required. */
function workspaceDirectories() {
  const globs = JSON.parse(readFileSync('package.json', 'utf8')).workspaces ?? [];
  const dirs = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (existsSync(`${glob}/package.json`)) dirs.push(glob);
      continue;
    }
    const parent = dirname(glob);
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && existsSync(`${parent}/${e.name}/package.json`)) dirs.push(`${parent}/${e.name}`);
    }
  }
  return dirs;
}

/** The package's own vitest config, excluding purpose-built extra configs. */
function configFor(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = entries.filter(
    (f) => /^vitest\.config\.(ts|mts|js|mjs|cts|cjs)$/.test(f),
  );
  return candidates.length > 0 ? `${dir}/${candidates[0]}` : null;
}

const problems = [];
let checked = 0;

for (const dir of workspaceDirectories()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  } catch {
    problems.push(`${dir}/package.json could not be read — this gate cannot answer its question without it.`);
    continue;
  }
  if (!pkg.scripts?.['test:coverage']) continue;
  checked += 1;

  const config = configFor(dir);
  if (config === null) {
    problems.push(
      `${basename(dir)} declares "test:coverage" and has no vitest config, so it runs on vitest's\n` +
        `    defaults (text, html, clover, json) and emits no lcov.info for the upload to find.`,
    );
    continue;
  }

  let source;
  try {
    source = readFileSync(config, 'utf8');
  } catch {
    problems.push(`${config} could not be read.`);
    continue;
  }

  if (!source.includes(SHARED)) {
    problems.push(
      `${config} does not derive from ${SHARED}. Whatever it emits, it emits by accident —\n` +
        `    merge the shared config and keep only what is genuinely local to this package.`,
    );
    continue;
  }

  if (/coverage:\s*\{[^}]*reporter\s*:/s.test(source)) {
    problems.push(
      `${config} re-declares coverage.reporter. mergeConfig CONCATENATES arrays, so this appends\n` +
        `    to the shared list rather than replacing it — every reporter runs twice. Delete it and\n` +
        `    let the shared config decide; if this package genuinely needs a different set, change\n` +
        `    the shared one so the decision stays in one place.`,
    );
  }
}

if (checked === 0) {
  console.error(`\n✖ found no workspace declaring "test:coverage". That cannot be right — fix this gate\n  rather than deleting the question.\n`);
  process.exit(1);
}

if (problems.length > 0) {
  console.error('\n✖ coverage configuration is not derived:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    `\n  ${SHARED}.ts decides what a coverage run emits. A package that does not\n` +
      '  derive from it silently emits something else, and the pipeline stays green\n' +
      '  because a missing lcov.info is swallowed by every step that wants one.\n',
  );
  process.exit(1);
}

console.log(`✅ vitest coverage config: ${checked} workspaces derive from ${SHARED}`);
