#!/usr/bin/env node
/**
 * lint:gateway-environment — the gateway reads exactly the environment
 * specs/src/gateway-environment/variables.json lists.
 *
 * 1. Reads, both directions. Every environment read in the gateway's source
 *    is a row with `readBy: gateway`, and every such row is read — by literal
 *    name (`env::var`, `env::var_os`). A computed name is allowed only where
 *    DYNAMIC says why; `env::vars()` and `EnvFilter::from_default_env` never
 *    are.
 * 2. Provision. A `launcher` row is passed on the gateway's line of the
 *    launcher's default boot golden; an `image` row is set by the gateway's
 *    Dockerfile or exported by the supervisor.
 * 3. Exercise. The conformance suite's cases name every row.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = 'specs/src/gateway-environment/variables.json';
const SOURCE = 'apps/gateway/src';
const BOOT_GOLDEN = 'apps/launcher/testdata/golden/start-default-boot.argv';
const DOCKERFILE = 'apps/gateway/Dockerfile';
const SUPERVISOR = 'scripts/container/supervise.sh';
const CASES = 'tests/gateway-conformance/cases';

const READERS = new Set(['gateway', 'opentelemetry', 'runtime']);
const PROVIDERS = new Set(['launcher', 'image', 'runtime', 'operator']);

/** Files that read by a computed name, and why each is bounded. */
const DYNAMIC = {
  'apps/gateway/src/config.rs': 'from_environment reads the broker variables the document names (signal.userEnv, signal.passwordEnv)',
};

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// ── the table ───────────────────────────────────────────────────────────────
const table = JSON.parse(read(TABLE));
const rows = Array.isArray(table.variables) ? table.variables : [];
if (rows.length === 0) fail(`${TABLE} lists no variables`);
const seen = new Set();
for (const row of rows) {
  const where = `${TABLE}: ${row?.name ?? JSON.stringify(row)}`;
  if (typeof row?.name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(row.name)) fail(`${where}: name is not an environment variable name`);
  if (seen.has(row.name)) fail(`${where}: listed twice`);
  seen.add(row.name);
  if (!READERS.has(row.readBy)) fail(`${where}: readBy is not one of ${[...READERS].join(', ')}`);
  if (!PROVIDERS.has(row.providedBy)) fail(`${where}: providedBy is not one of ${[...PROVIDERS].join(', ')}`);
  if (typeof row.required !== 'boolean') fail(`${where}: required is not true or false`);
  if (typeof row.effect !== 'string' || row.effect.trim() === '') fail(`${where}: no effect`);
}

// ── 1. reads, both directions ───────────────────────────────────────────────
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith('.rs')) out.push(path);
  }
  return out;
}

const NAMED = /\benv::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g;
const COMPUTED = /\benv::var(?:_os)?\(\s*(?!")/g;
const WHOLE = /\benv::vars(?:_os)?\s*\(/g;
const IMPLICIT = /\bfrom_default_env\b/g;

const reads = new Map(); // name → files
for (const file of sourceFiles(SOURCE)) {
  const text = withoutComments(read(file));
  for (const m of text.matchAll(NAMED)) reads.set(m[1], [...(reads.get(m[1]) ?? []), file]);
  if (COMPUTED.test(text) && !(file in DYNAMIC)) fail(`${file} reads the environment by a computed name; the gateway reads only the variables ${TABLE} lists`);
  COMPUTED.lastIndex = 0;
  if (WHOLE.test(text)) fail(`${file} takes the whole environment; the gateway reads only the variables ${TABLE} lists`);
  WHOLE.lastIndex = 0;
  if (IMPLICIT.test(text)) fail(`${file} lets a library read the environment for it (from_default_env); the gateway reads only the variables ${TABLE} lists`);
  IMPLICIT.lastIndex = 0;
}
for (const file of Object.keys(DYNAMIC)) {
  COMPUTED.lastIndex = 0;
  if (!COMPUTED.test(withoutComments(read(file)))) fail(`DYNAMIC names ${file}, which reads no variable by a computed name: remove it`);
}
COMPUTED.lastIndex = 0;
const readByGateway = new Set(rows.filter((r) => r.readBy === 'gateway').map((r) => r.name));
for (const [name, files] of reads) {
  if (!readByGateway.has(name)) fail(`${[...new Set(files)].join(', ')} read ${name}, which ${TABLE} does not list as read by the gateway`);
}
for (const name of readByGateway) {
  if (!reads.has(name)) fail(`${TABLE} lists ${name} as read by the gateway, and nothing in ${SOURCE} reads it`);
}

// ── 2. provision ────────────────────────────────────────────────────────────
const gatewayLine = read(BOOT_GOLDEN).split('\n').find((line) => line.includes('--name semiont-gateway'));
if (!gatewayLine) fail(`${BOOT_GOLDEN} has no semiont-gateway line`);
const passed = new Set([...(gatewayLine ?? '').matchAll(/(?:--env|-e) ([A-Z_][A-Z0-9_]*)=/g)].map((m) => m[1]));

const imageSet = new Set();
let inEnv = false;
for (const line of read(DOCKERFILE).split('\n')) {
  if (/^ENV\s/.test(line)) inEnv = true;
  if (inEnv) for (const m of line.matchAll(/(?:^ENV\s+|\s)([A-Z_][A-Z0-9_]*)=/g)) imageSet.add(m[1]);
  if (!line.trimEnd().endsWith('\\')) inEnv = false;
}
for (const m of read(SUPERVISOR).matchAll(/^\s*export ([A-Z_][A-Z0-9_]*)=/gm)) imageSet.add(m[1]);

for (const row of rows) {
  if (row.providedBy === 'launcher' && !passed.has(row.name)) fail(`${TABLE} says the launcher provides ${row.name}, and the gateway's line in ${BOOT_GOLDEN} does not pass it`);
  if (row.providedBy === 'image' && !imageSet.has(row.name)) fail(`${TABLE} says the image provides ${row.name}, and neither ${DOCKERFILE} nor ${SUPERVISOR} sets it`);
}

// ── 3. exercise ─────────────────────────────────────────────────────────────
const casesText = readdirSync(join(ROOT, CASES)).filter((f) => f.endsWith('.ts')).map((f) => read(join(CASES, f))).join('\n');
for (const row of rows) {
  if (!new RegExp(`\\b${row.name}\\b`).test(casesText)) fail(`no case in ${CASES} names ${row.name}`);
}

if (failures.length > 0) {
  console.error(`❌ lint:gateway-environment — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:gateway-environment — ${rows.length} variables: every read listed, every listed read, provided where the table says, and exercised by the suite (${relative(ROOT, join(ROOT, TABLE))})`);
