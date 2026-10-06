#!/usr/bin/env node
/**
 * lint:service-environment — each Rust service reads exactly the environment
 * specs/src/service-environment/variables.json lists for it.
 *
 * For each service in SERVICES:
 *
 * 1. Reads, both directions. Every environment read in the service's source —
 *    its crate's, and every workspace crate's it links — is a row listing the
 *    service with `readBy: service`, and every such row is read — by literal
 *    name (`env::var`, `env::var_os`). A computed name is allowed only where
 *    DYNAMIC says why; `env::vars()` and `EnvFilter::from_default_env` never
 *    are.
 * 2. Provision. A `launcher` row is passed on the service's line of the
 *    launcher's default boot golden; an `image` row is set by the service's
 *    Dockerfile or exported by the supervisor.
 * 3. Exercise. The service's conformance suite names every row that lists it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TABLE = 'specs/src/service-environment/variables.json';
const BOOT_GOLDEN = 'apps/launcher/testdata/golden/start-default-boot.argv';
const SUPERVISOR = 'scripts/container/supervise.sh';

/** Each service the table covers: its crate, its image, and its suite. */
const SERVICES = [
  { name: 'gateway', crate: 'apps/gateway', container: 'semiont-gateway', dockerfile: 'apps/gateway/Dockerfile', cases: 'tests/conformance/gateway' },
  { name: 'dispatcher', crate: 'apps/dispatcher', container: 'semiont-dispatcher', dockerfile: 'apps/dispatcher/Dockerfile', cases: 'tests/conformance/dispatcher' },
  { name: 'archivist', crate: 'apps/archivist', container: 'semiont-archivist', dockerfile: 'apps/archivist/Dockerfile', cases: 'tests/conformance/archivist' },
];

const READERS = new Set(['service', 'opentelemetry']);
const PROVIDERS = new Set(['launcher', 'image', 'operator']);

/** Files that read by a computed name, and why each is bounded. */
const DYNAMIC = {
  'packages/core-rust/src/config.rs': 'from_environment reads the variables a document names (the gateway\'s signal.userEnv and signal.passwordEnv, the dispatcher\'s queue.userEnv and queue.passwordEnv)',
};

const failures = [];
const fail = (message) => failures.push(message);
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const serviceNames = new Set(SERVICES.map((s) => s.name));

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
  if (!Array.isArray(row.services) || row.services.length === 0) fail(`${where}: services names none`);
  else for (const s of row.services) if (!serviceNames.has(s)) fail(`${where}: services names ${s}, which is not one of ${[...serviceNames].join(', ')}`);
  if (!READERS.has(row.readBy)) fail(`${where}: readBy is not one of ${[...READERS].join(', ')}`);
  if (!PROVIDERS.has(row.providedBy)) fail(`${where}: providedBy is not one of ${[...PROVIDERS].join(', ')}`);
  if (typeof row.required !== 'boolean') fail(`${where}: required is not true or false`);
  if (typeof row.effect !== 'string' || row.effect.trim() === '') fail(`${where}: no effect`);
}
const rowsOf = (service) => rows.filter((r) => Array.isArray(r.services) && r.services.includes(service));

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

/**
 * The workspace's crates by package name: their directories (Cargo.toml at the
 * root). A published crate's entry names its version beside its path.
 */
const WORKSPACE = new Map(
  [...read('Cargo.toml').matchAll(/^([a-z][a-z0-9-]*) = \{ path = "([^"]+)"(?:, version = "[^"]+")? \}$/gm)].map(([, name, path]) => [name, path]),
);
// An entry written any other way would be a crate whose source is never read,
// and a variable read there would look like one nothing reads.
const BY_PATH = read('Cargo.toml').split('\n').filter((line) => line.includes('path = "')).length;
if (WORKSPACE.size !== BY_PATH) fail(`Cargo.toml names ${BY_PATH} crates by path, and ${WORKSPACE.size} of them were read: an entry is written in a shape this lint does not know`);

/**
 * The source a service's binary is built from: its crate's, and each workspace
 * crate's it reaches through its manifests' dependencies — never a build
 * script's (`src/` only).
 */
function crateSources(crate) {
  const crates = new Set([crate]);
  const pending = [crate];
  while (pending.length > 0) {
    const dir = pending.pop();
    const manifest = read(`${dir}/Cargo.toml`);
    const dependencies = manifest.split(/^\[build-dependencies\]$/m)[0];
    for (const [, name] of dependencies.matchAll(/^([a-z][a-z0-9-]*)(?:\.workspace = true| = \{ workspace = true)/gm)) {
      const path = WORKSPACE.get(name);
      if (path && !crates.has(path)) {
        crates.add(path);
        pending.push(path);
      }
    }
  }
  return [...crates].map((c) => `${c}/src`);
}

for (const file of Object.keys(DYNAMIC)) {
  if (!COMPUTED.test(withoutComments(read(file)))) fail(`DYNAMIC names ${file}, which reads no variable by a computed name: remove it`);
  COMPUTED.lastIndex = 0;
}

const supervisorExports = [...read(SUPERVISOR).matchAll(/^\s*export ([A-Z_][A-Z0-9_]*)=/gm)].map((m) => m[1]);
const goldenLines = read(BOOT_GOLDEN).split('\n');

for (const service of SERVICES) {
  const sources = crateSources(service.crate);
  const reads = new Map(); // name → files
  for (const file of sources.flatMap(sourceFiles)) {
    const text = withoutComments(read(file));
    for (const m of text.matchAll(NAMED)) reads.set(m[1], [...(reads.get(m[1]) ?? []), file]);
    if (COMPUTED.test(text) && !(file in DYNAMIC)) fail(`${file} reads the environment by a computed name; the ${service.name} reads only the variables ${TABLE} lists for it`);
    COMPUTED.lastIndex = 0;
    if (WHOLE.test(text)) fail(`${file} takes the whole environment; the ${service.name} reads only the variables ${TABLE} lists for it`);
    WHOLE.lastIndex = 0;
    if (IMPLICIT.test(text)) fail(`${file} lets a library read the environment for it (from_default_env); the ${service.name} reads only the variables ${TABLE} lists for it`);
    IMPLICIT.lastIndex = 0;
  }
  const listed = rowsOf(service.name);
  const readByService = new Set(listed.filter((r) => r.readBy === 'service').map((r) => r.name));
  for (const [name, files] of reads) {
    if (!readByService.has(name)) fail(`${[...new Set(files)].join(', ')} read ${name}, which ${TABLE} does not list as read by the ${service.name}`);
  }
  for (const name of readByService) {
    if (!reads.has(name)) fail(`${TABLE} lists ${name} as read by the ${service.name}, and nothing in ${sources.join(', ')} reads it`);
  }

  // ── 2. provision ──────────────────────────────────────────────────────────
  const line = goldenLines.find((l) => l.includes(`--name ${service.container} `));
  if (!line) fail(`${BOOT_GOLDEN} has no ${service.container} line`);
  // Passed either with its value (`--env NAME=value`) or, for a secret, by name alone: the value
  // crosses through the runtime command's own environment, never the command line, so the
  // golden shows `--env NAME`.
  const passed = new Set([...(line ?? '').matchAll(/(?:--env|-e) ([A-Z_][A-Z0-9_]*)(?=[=\s]|$)/g)].map((m) => m[1]));
  const imageSet = new Set(supervisorExports);
  let inEnv = false;
  for (const l of read(service.dockerfile).split('\n')) {
    if (/^ENV\s/.test(l)) inEnv = true;
    if (inEnv) for (const m of l.matchAll(/(?:^ENV\s+|\s)([A-Z_][A-Z0-9_]*)=/g)) imageSet.add(m[1]);
    if (!l.trimEnd().endsWith('\\')) inEnv = false;
  }
  for (const row of listed) {
    if (row.providedBy === 'launcher' && !passed.has(row.name)) fail(`${TABLE} says the launcher provides ${row.name}, and the ${service.name}'s line in ${BOOT_GOLDEN} does not pass it`);
    if (row.providedBy === 'image' && !imageSet.has(row.name)) fail(`${TABLE} says the image provides ${row.name}, and neither ${service.dockerfile} nor ${SUPERVISOR} sets it`);
  }

  // ── 3. exercise ───────────────────────────────────────────────────────────
  const casesText = readdirSync(join(ROOT, service.cases)).filter((f) => f.endsWith('.ts')).map((f) => read(join(service.cases, f))).join('\n');
  for (const row of listed) {
    if (!new RegExp(`\\b${row.name}\\b`).test(casesText)) fail(`no case in ${service.cases} names ${row.name}`);
  }
}

if (failures.length > 0) {
  console.error(`❌ lint:service-environment — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:service-environment — ${rows.length} variables over ${SERVICES.map((s) => `the ${s.name} (${rowsOf(s.name).length})`).join(' and ')}: every read listed, every listed read, provided where the table says, and exercised by each suite (${relative(ROOT, join(ROOT, TABLE))})`);
