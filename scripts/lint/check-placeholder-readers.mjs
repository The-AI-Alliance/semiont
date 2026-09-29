#!/usr/bin/env node
/**
 * A `${VAR}` in a KB's config has one meaning, and two resolvers hold it: the
 * TypeScript loader (`resolveEnvVars`) and the Go launcher (`resolveRefs`),
 * both bound to specs/src/config-placeholders/cases.json. A third reader is how
 * the rule forks: `evaluateEnvPlaceholders` ran a second pass over values the
 * loader had already resolved, and threw on a password containing `${…}`
 * (SECRET-DELIVERY F4). It had itself been hoisted from a private copy, so a
 * reader outside the table had appeared twice.
 *
 * This census finds every place source code spells the syntax — a regex
 * escape `\$\{`, a class `[$]`, or the literal string `"${"` — and fails on any
 * site not listed below with its role. A listed site that is no longer there
 * fails too: an allowlist that outlives its sites stops describing the tree.
 *
 * Scanned: every tracked TypeScript, JavaScript, Go and Rust file, comments
 * blanked. Not scanned: tests (they spell placeholders to exercise the
 * readers), and this file.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { withoutComments } from './source-text.mjs';

const SELF = 'scripts/lint/check-placeholder-readers.mjs';

const ALLOWED = {
  'packages/core/src/config/toml-loader.ts': [
    'the TypeScript resolver (resolveEnvVars), held to the case table',
  ],
  'apps/launcher/internal/launcher/gatewaydoc.go': [
    "the Go pattern: resolveRefs resolves the gateway's document by it, and the extractor (placeholderRefs) reads a config's references by it; both held to the case table",
  ],
  'apps/launcher/internal/launcher/config.go': [
    'renders exactly one reference, ${NAME} (referenceTo), for what the launcher stages into a service config',
    'a value that is exactly one reference, ${NAME} (referenceName)',
  ],
  'apps/launcher/internal/launcher/identity.go': [
    "writes Keycloak's own ${key} message syntax into the realm — not a config placeholder",
  ],
  'scripts/lint/check-css-classes-live.js': [
    'finds interpolations in JavaScript template literals — not a config placeholder',
  ],
  'scripts/diag/sonnet5-temperature-spike.mjs': [
    'a diagnostic spike refusing an unresolved apiKey — never runs in a service',
  ],
};

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|go|rs)$/;
const TEST = /(^|\/)(__tests__|testdata)\/|_test\.go$|\.(test|spec)\.[cm]?[jt]sx?$/;
const SPELLINGS = [
  { name: 'regex escape \\$\\{', re: /\\\$\\\{/g },
  { name: 'regex class [$]', re: /\[\$\]/g },
  { name: 'literal "${"', re: /(["'`])\$\{\1/g },
];

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((f) => SOURCE.test(f) && !TEST.test(f) && f !== SELF);

const found = new Map();
for (const file of files) {
  let text;
  try {
    text = withoutComments(readFileSync(file, 'utf8'));
  } catch {
    continue; // tracked but deleted in the working tree
  }
  const sites = [];
  for (const { name, re } of SPELLINGS) {
    for (const m of text.matchAll(re)) {
      sites.push({ line: text.slice(0, m.index).split('\n').length, name });
    }
  }
  if (sites.length > 0) found.set(file, sites.sort((a, b) => a.line - b.line));
}

let failed = false;
for (const [file, sites] of found) {
  const roles = ALLOWED[file];
  if (!roles) {
    failed = true;
    console.error(`\n✖ ${file} reads the placeholder syntax outside the census:`);
    for (const s of sites) console.error(`    line ${s.line}: ${s.name}`);
  } else if (sites.length !== roles.length) {
    failed = true;
    console.error(`\n✖ ${file} spells the syntax ${sites.length} time(s); the census lists ${roles.length}:`);
    for (const s of sites) console.error(`    line ${s.line}: ${s.name}`);
    for (const r of roles) console.error(`    listed: ${r}`);
  }
}
for (const [file, roles] of Object.entries(ALLOWED)) {
  if (!found.has(file)) {
    failed = true;
    console.error(`\n✖ ${file} is listed (${roles.join('; ')}) but no longer spells the syntax — remove it from the census.`);
  }
}

if (failed) {
  console.error(
    '\n  A config placeholder has one rule, run by two resolvers and the launcher\'s\n' +
      '  extractor. Use the value the loader resolved; never resolve it again. A new\n' +
      '  site that is genuinely not a config reader goes in ALLOWED with its role.\n',
  );
  process.exit(1);
}
const total = [...found.values()].reduce((n, s) => n + s.length, 0);
console.log(`✅ placeholder readers: ${total} sites in ${found.size} files, each with its role`);
