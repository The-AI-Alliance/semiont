#!/usr/bin/env node
/**
 * lint:gateway-environment — the gateway reads exactly the environment
 * specs/src/gateway-environment/variables.json lists.
 *
 * 1. Reads, both directions, in each implementation. Every environment read
 *    in the code the gateway's process runs is a row with `readBy: gateway`,
 *    and every such row is read.
 *    - TypeScript: the gateway's source plus @semiont/core and
 *      @semiont/observability, less the modules named in NOT_RUN: each names
 *      the functions its reads run through, and holds only while the
 *      gateway's source names none of them. A read by a computed name is
 *      allowed only where DYNAMIC says why; taking the whole environment is
 *      never allowed.
 *    - Rust: the crate's source, read by literal name (`env::var`,
 *      `env::var_os`). A computed name is allowed only where RUST_DYNAMIC says
 *      why; `env::vars()` and `EnvFilter::from_default_env` never are.
 * 2. Provision. A `launcher` row is passed on the gateway's line of the
 *    launcher's default boot golden; an `image` row is set by the gateway's
 *    Dockerfile or exported by the supervisor.
 * 3. Exercise. The conformance suite's cases name every row.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = 'specs/src/gateway-environment/variables.json';
const SOURCES = ['apps/gateway/src', 'packages/core/src', 'packages/observability/src'];
const GATEWAY_SOURCE = 'apps/gateway/src';
const RUST_SOURCE = 'apps/gateway-rs/src';
const BOOT_GOLDEN = 'apps/launcher/testdata/golden/start-default-boot.argv';
const DOCKERFILE = 'apps/gateway/Dockerfile';
const SUPERVISOR = 'scripts/container/supervise.sh';
const CASES = 'tests/gateway-conformance/cases';

const READERS = new Set(['gateway', 'opentelemetry', 'runtime']);
const PROVIDERS = new Set(['launcher', 'image', 'runtime', 'operator']);

/** Modules the gateway loads or could, whose reads it never runs: file → the functions they run in. */
const NOT_RUN = {
  'packages/observability/src/process-logger.ts': ['createProcessLogger'],
  'packages/core/src/project.ts': ['SemiontProject', 'SemiontState', 'stateDirFor'],
  'packages/core/src/config/env-placeholders.ts': ['evaluateEnvPlaceholders'],
  'packages/core/src/config/toml-loader.ts': ['createTomlConfigLoader', 'resolveEnvVars'],
  'packages/core/src/config/node-config-loader.ts': ['loadEnvironmentConfig'],
};

/** Reads by a computed name, and why each is bounded. */
const DYNAMIC = {
  'apps/gateway/src/config.ts': 'fromEnvironment reads the broker variables the document names (signal.userEnv, signal.passwordEnv)',
};

/** Rust files that read by a computed name, and why each is bounded. */
const RUST_DYNAMIC = {
  'apps/gateway-rs/src/config.rs': 'from_environment reads the broker variables the document names (signal.userEnv, signal.passwordEnv)',
};

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

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
const gatewayText = sourceFiles(GATEWAY_SOURCE).map(read).join('\n');
for (const [file, symbols] of Object.entries(NOT_RUN)) {
  for (const symbol of symbols) {
    if (new RegExp(`\\b${symbol}\\b`).test(gatewayText)) {
      fail(`${GATEWAY_SOURCE} names ${symbol}, so the reads in ${file} are the gateway's: take ${file} out of NOT_RUN and list what it reads`);
    }
  }
}

const NAMED = /process\.env(?:\?\.|\.)([A-Z_][A-Z0-9_]*)|process\.env(?:\?\.)?\[\s*(['"])([A-Z_][A-Z0-9_]*)\2\s*\]/g;
const COMPUTED = /process\.env(?:\?\.)?\[\s*(?!['"])/g;
const WHOLE = /process\.env(?![\w.?[])/g;

const reads = new Map(); // name → files
for (const dir of SOURCES) {
  for (const file of sourceFiles(dir)) {
    if (file in NOT_RUN) continue;
    const text = read(file);
    for (const m of text.matchAll(NAMED)) {
      const name = m[1] ?? m[3];
      reads.set(name, [...(reads.get(name) ?? []), file]);
    }
    if (COMPUTED.test(text) && !(file in DYNAMIC)) fail(`${file} reads the environment by a computed name; the gateway reads only the variables ${TABLE} lists`);
    COMPUTED.lastIndex = 0;
    if (WHOLE.test(text)) fail(`${file} takes the whole environment; the gateway reads only the variables ${TABLE} lists`);
    WHOLE.lastIndex = 0;
  }
}
const readByGateway = new Set(rows.filter((r) => r.readBy === 'gateway').map((r) => r.name));
for (const [name, files] of reads) {
  if (!readByGateway.has(name)) fail(`${[...new Set(files)].join(', ')} read ${name}, which ${TABLE} does not list as read by the gateway`);
}
for (const name of readByGateway) {
  if (!reads.has(name)) fail(`${TABLE} lists ${name} as read by the gateway, and nothing it runs reads it`);
}

// ── 1, in Rust ──────────────────────────────────────────────────────────────
function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir))) {
    const path = join(dir, entry);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...rustFiles(path));
    else if (entry.endsWith('.rs')) out.push(path);
  }
  return out;
}
/** A line comment runs from `//` preceded by nothing or whitespace — never a URL's `://`. */
const withoutComments = (text) => text.split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

const RUST_NAMED = /\benv::var(?:_os)?\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g;
const RUST_COMPUTED = /\benv::var(?:_os)?\(\s*(?!")/g;
const RUST_WHOLE = /\benv::vars(?:_os)?\s*\(/g;
const RUST_IMPLICIT = /\bfrom_default_env\b/g;

const rustReads = new Map(); // name → files
for (const file of rustFiles(RUST_SOURCE)) {
  const text = withoutComments(read(file));
  for (const m of text.matchAll(RUST_NAMED)) rustReads.set(m[1], [...(rustReads.get(m[1]) ?? []), file]);
  if (RUST_COMPUTED.test(text) && !(file in RUST_DYNAMIC)) fail(`${file} reads the environment by a computed name; the gateway reads only the variables ${TABLE} lists`);
  RUST_COMPUTED.lastIndex = 0;
  if (RUST_WHOLE.test(text)) fail(`${file} takes the whole environment; the gateway reads only the variables ${TABLE} lists`);
  RUST_WHOLE.lastIndex = 0;
  if (RUST_IMPLICIT.test(text)) fail(`${file} lets a library read the environment for it (from_default_env); the gateway reads only the variables ${TABLE} lists`);
  RUST_IMPLICIT.lastIndex = 0;
}
for (const file of Object.keys(RUST_DYNAMIC)) {
  RUST_COMPUTED.lastIndex = 0;
  if (!RUST_COMPUTED.test(withoutComments(read(file)))) fail(`RUST_DYNAMIC names ${file}, which reads no variable by a computed name: remove it`);
}
RUST_COMPUTED.lastIndex = 0;
for (const [name, files] of rustReads) {
  if (!readByGateway.has(name)) fail(`${[...new Set(files)].join(', ')} read ${name}, which ${TABLE} does not list as read by the gateway`);
}
for (const name of readByGateway) {
  if (!rustReads.has(name)) fail(`${TABLE} lists ${name} as read by the gateway, and nothing in ${RUST_SOURCE} reads it`);
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
console.log(`✅ lint:gateway-environment — ${rows.length} variables: every read listed and every listed read, in TypeScript and in Rust; provided where the table says; exercised by the suite (${relative(ROOT, join(ROOT, TABLE))})`);
