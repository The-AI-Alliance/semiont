#!/usr/bin/env node
/**
 * lint:go-toolchain — the Go version is written in go.mod and nowhere else.
 *
 * A go.mod states the toolchain its module is built with, pinned to the patch.
 * Go reads no other module's, so each module states its own, and they are
 * held here to one version. Everything else takes it from there:
 * actions/setup-go reads the file (`go-version-file`), and a Go image's tag
 * is the toolchain, golang:<toolchain>, which scripts/ci/go-toolchain.sh
 * prints.
 *
 * 1. Every go.mod states a `go` line and a `toolchain` line, and each is the
 *    same in every module.
 * 2. No file writes a Go image's tag out (`golang:` and a digit).
 * 3. A workflow names a go.mod (`go-version-file:`), never a Go version
 *    (`go-version:`), and nothing sets GOTOOLCHAIN to one.
 * 4. The toolchain is read out of a go.mod in one place,
 *    scripts/ci/go-toolchain.sh.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const READER = 'scripts/ci/go-toolchain.sh';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-go-toolchain.mjs';

const failures = [];
const fail = (message) => failures.push(message);

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
const modules = files.filter((file) => basename(file) === 'go.mod');
if (modules.length === 0) fail('the repository holds no go.mod: the check has lost what it holds');
if (!files.includes(READER)) fail(`${READER} is not in the repository: nothing reads the toolchain for the images`);

/** Rule 1: the `go` and `toolchain` lines of each module. */
const stated = modules.map((file) => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  return { file, go: /^go (\S+)$/m.exec(text)?.[1], toolchain: /^toolchain (\S+)$/m.exec(text)?.[1] };
});
for (const { file, go, toolchain } of stated) {
  if (!go) fail(`${file} has no \`go\` line`);
  if (!toolchain) fail(`${file} has no \`toolchain\` line; without one the patch is whatever a machine has`);
}
const [first, ...rest] = stated;
for (const other of rest) {
  if (other.go && first.go && other.go !== first.go) fail(`${other.file} says go ${other.go} and ${first.file} says go ${first.go}; the modules state one version`);
  if (other.toolchain && first.toolchain && other.toolchain !== first.toolchain) {
    fail(`${other.file} pins ${other.toolchain} and ${first.file} pins ${first.toolchain}; the modules pin one toolchain`);
  }
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
  const isModule = modules.includes(file);
  const isWorkflow = /^\.github\/.*\.ya?ml$/.test(file);

  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    if (/\bgolang:[0-9]/.test(line)) fail(`${at} writes a Go image's tag out; it is golang:<toolchain>, with the toolchain go.mod pins (${READER})`);
    if (/\bGOTOOLCHAIN\s*[=:]\s*["']?go[0-9]/.test(line)) fail(`${at} sets GOTOOLCHAIN to a version; every build takes the one go.mod pins`);
    if (!isModule && file !== READER && /\^toolchain\b/.test(line)) fail(`${at} reads the toolchain itself; ${READER} is the one reader`);
    if (!isWorkflow) return;
    if (/\bgo-version\s*:/.test(line)) fail(`${at} names a Go version; a workflow names a go.mod (go-version-file)`);
    const named = /\bgo-version-file\s*:\s*["']?([^"'\s]+)/.exec(line)?.[1];
    if (named && !modules.includes(named)) fail(`${at} takes its Go version from ${named}, which is no go.mod of the repository`);
  });
}

if (failures.length > 0) {
  console.error(`❌ lint:go-toolchain — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:go-toolchain — ${modules.join(' and ')} pin ${first.toolchain}; ${read} files read, and none writes a Go version or reads the pin but ${READER}`);
