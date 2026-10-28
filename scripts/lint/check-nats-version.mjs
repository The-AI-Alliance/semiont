#!/usr/bin/env node
/**
 * lint:nats-version — the broker's version is written in the launcher's
 * go.mod and nowhere else.
 *
 * The launcher requires github.com/nats-io/nats-server/v2 for its tests, which
 * read the broker's config with that module's parser. Dependabot moves the
 * line. CI runs every conformance suite against a real broker, and installs
 * the release of that same version: scripts/ci/install-nats-server.sh, which
 * asks scripts/ci/nats-version.sh. So one bump moves the parser and the broker
 * the suites run against, and a second copy of the version is a copy nothing
 * moves: it is refused here, not kept in step.
 *
 * 1. packages/go/launcher/go.mod requires the module, once.
 * 2. No file writes the broker's version out: a `nats` image's tag, a release
 *    asset's name, a variable given a version, or the module's line.
 * 3. A nats-server release is fetched in one place,
 *    scripts/ci/install-nats-server.sh.
 * 4. The line is read out of go.mod in one place, scripts/ci/nats-version.sh.
 *
 * Four places state the version beside go.mod, and each is held to it by
 * something that is not this check:
 *
 * - packages/go/launcher/go.sum and apps/launcher/go.sum, which Go writes from
 *   the module graph;
 * - the launcher's descriptor of the broker, whose image tag
 *   TestBrokerPairIsReadByTheLaunchedBrokersParser holds to the module;
 * - the launcher's golden files, which its tests compare with what the
 *   descriptor makes it print;
 * - the stack documents of the launcher's fixture knowledge base, which name
 *   the broker's image as every knowledge base's documents do, and which
 *   TestTheFixtureStackNamesTheDescriptorsImages holds to the descriptor.
 *
 * A document may state the oldest broker a suite runs on ("2.10 or later").
 * That is a floor and not the version, and nothing here reads it.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OWNER = 'packages/go/launcher/go.mod';
const MODULE = 'github.com/nats-io/nats-server/v2';
const READER = 'scripts/ci/nats-version.sh';
const INSTALLER = 'scripts/ci/install-nats-server.sh';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-nats-version.mjs';

/** What Go writes from the owner: its own go.sum, and the program's, whose module graph holds the module. */
const DERIVED = ['packages/go/launcher/go.sum', 'apps/launcher/go.sum'];
/** Where the launcher states the image it runs, and where its tests keep what that prints: the launcher's tests hold both. */
const DESCRIPTOR = 'packages/go/launcher/descriptors.go';
const GOLDEN = 'packages/go/launcher/testdata/golden/';
/** The fixture knowledge base's stack documents: the launcher's tests hold their images to the descriptor. */
const FIXTURE_STACK = 'packages/go/launcher/testdata/kb/.semiont/stack/';

/** Rule 2: a `nats` image's tag. A host and its port (`nats:4222`) is not one: a tag has a dot or a variant. */
const IMAGE_TAG = /\bnats:[0-9]+(?:\.[0-9]|-[a-z])/;
/** Rule 2: each other way of writing the version out. */
const WRITTEN_OUT = [
  [/nats-server[-_]v?[0-9]/, "a release asset's name"],
  [/\bnats[a-z_-]*version\w*\s*[=:]\s*["']?v?[0-9]/i, 'a variable given a version'],
];
const MODULE_LINE = /nats-io\/nats-server\/v2\s+v[0-9]/;
/** Rule 3: the address a release is fetched from. */
const RELEASES = /nats-io\/nats-server\/releases/;
/** Rule 4: a pattern that reads the module's line, as sed or a regular expression writes it. */
const READS_LINE = [/nats-server\\?\/v2\S*\s+v\\?\(/, /nats-server\\?\/v2(?:\[\[:space:\]\]|\\s)/];

const failures = [];
const fail = (message) => failures.push(message);

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
for (const [file, what] of [
  [OWNER, 'the check has lost what it holds'],
  [READER, 'nothing reads the version for CI'],
  [INSTALLER, 'nothing installs the broker CI runs'],
]) {
  if (!files.includes(file)) fail(`${file} is not in the repository: ${what}`);
}

/** Rule 1: the module's line in the owner. */
let pinned;
if (files.includes(OWNER)) {
  const lines = readFileSync(join(ROOT, OWNER), 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith(`${MODULE} `));
  if (lines.length !== 1) fail(`${OWNER} requires ${MODULE} ${lines.length} times; the broker's version is one line`);
  pinned = /\sv(\d+\.\d+\.\d+)$/.exec(lines[0] ?? '')?.[1];
  if (lines.length === 1 && !pinned) fail(`${OWNER} requires ${MODULE} at "${lines[0].trim()}", which is no released version`);
}

let read = 0;
for (const file of files) {
  if (file === SELF) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue; // a directory git lists (a submodule), or a link to nothing
  }
  if (text.includes('\u0000')) continue; // not text
  read += 1;
  const statesTheImage = file === DESCRIPTOR || file.startsWith(GOLDEN) || file.startsWith(FIXTURE_STACK);
  const statesTheModule = file === OWNER || DERIVED.includes(file);

  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    if (!statesTheImage && IMAGE_TAG.test(line)) fail(`${at} writes a nats image's tag out; the broker's version is the one ${OWNER} requires (${READER})`);
    for (const [pattern, what] of WRITTEN_OUT) {
      if (pattern.test(line)) fail(`${at} writes the broker's version out as ${what}; it is the one ${OWNER} requires (${READER})`);
    }
    if (!statesTheModule && MODULE_LINE.test(line)) fail(`${at} writes the module's version out; ${OWNER} is where it is written`);
    if (file !== INSTALLER && RELEASES.test(line)) fail(`${at} fetches a nats-server release itself; ${INSTALLER} is the one place that does`);
    if (file !== READER && READS_LINE.some((pattern) => pattern.test(line))) fail(`${at} reads the module's line itself; ${READER} is the one reader`);
  });
}

if (failures.length > 0) {
  console.error(`❌ lint:nats-version — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:nats-version — ${OWNER} requires nats-server ${pinned}; ${read} files read, and none writes the broker's version, fetches a release but ${INSTALLER}, or reads the line but ${READER}`);
