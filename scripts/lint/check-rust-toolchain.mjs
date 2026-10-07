#!/usr/bin/env node
/**
 * lint:rust-toolchain — the Rust version is written in rust-toolchain.toml and
 * nowhere else.
 *
 * Every Rust build takes its compiler from that file. rustup reads it, and a
 * Rust image's tag is its `channel`, handed to the Dockerfile as
 * RUST_TOOLCHAIN. Dependabot moves the file and runs no script of this
 * repository, so a second copy of the version is a copy nothing moves: it is
 * refused here, not kept in step.
 *
 * 1. No file writes a Rust image's tag out (`rust:` and a digit).
 * 2. A Dockerfile's `FROM rust:` is `rust:${RUST_TOOLCHAIN}-<variant>`, and the
 *    file declares `ARG RUST_TOOLCHAIN` with no default, so a build that is
 *    not told the toolchain stops at the FROM.
 * 3. Nothing but a document picks a toolchain another way: rustup's default
 *    or override, a toolchain named to `rustup toolchain install`, the
 *    RUSTUP_TOOLCHAIN variable, `cargo +<toolchain>`, or an action that
 *    installs one.
 * 4. `channel` is read out of the file in one place, scripts/ci/rust-toolchain.sh.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OWNER = 'rust-toolchain.toml';
const READER = 'scripts/ci/rust-toolchain.sh';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-rust-toolchain.mjs';

/** Rule 3: each way of picking a toolchain that is not the file. */
const OTHER_WAYS = [
  [/\brustup\s+default\b/, '`rustup default`'],
  [/\brustup\s+override\b/, '`rustup override`'],
  [/\brustup\s+toolchain\s+install\s+[A-Za-z0-9]/, 'a toolchain named to `rustup toolchain install`'],
  [/\bRUSTUP_TOOLCHAIN\b/, 'RUSTUP_TOOLCHAIN'],
  [/\bcargo\s+\+[A-Za-z0-9]/, '`cargo +<toolchain>`'],
  [/\b(?:dtolnay\/rust-toolchain|actions-rs\/toolchain|actions-rust-lang\/setup-rust-toolchain)\b/, 'an action that installs a toolchain'],
];

/** Rule 4: a pattern that reads `channel`, as sed or a regular expression anchors it, or as a parser names it. */
const READS_CHANNEL = [/\^channel\s*=/, /\btoolchain\W{1,4}channel\b/];

const failures = [];
const fail = (message) => failures.push(message);

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
if (!files.includes(OWNER)) fail(`${OWNER} is not in the repository: the check has lost what it holds`);
if (!files.includes(READER)) fail(`${READER} is not in the repository: nothing reads ${OWNER}'s channel for the images`);

let read = 0;
let dockerfiles = 0;
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
  const lines = text.split('\n');
  const isDocument = file.endsWith('.md');
  const isDockerfile = /dockerfile/i.test(basename(file));

  lines.forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    if (/\brust:[0-9]/.test(line)) fail(`${at} writes a Rust image's tag out; it is rust:<channel>-<variant>, with the channel ${OWNER} names`);
    if (!isDocument) {
      for (const [pattern, what] of OTHER_WAYS) {
        if (pattern.test(line)) fail(`${at} picks a toolchain with ${what}; every build takes the one ${OWNER} names`);
      }
    }
    if (file !== OWNER && file !== READER && READS_CHANNEL.some((pattern) => pattern.test(line))) {
      fail(`${at} reads the channel itself; ${READER} is the one reader`);
    }
  });

  if (!isDockerfile) continue;
  const rustStages = lines
    .map((line, index) => ({ index, image: /^FROM\s+(?:--\S+\s+)*(\S+)/.exec(line)?.[1] }))
    .filter(({ image }) => image && /(?:^|\/)rust(?::|@|$)/.test(image));
  if (rustStages.length === 0) continue;
  dockerfiles += 1;
  for (const { index, image } of rustStages) {
    if (!/^rust:\$\{RUST_TOOLCHAIN\}-[a-z0-9.]+$/.test(image)) {
      fail(`${file}:${index + 1} builds from ${image}; a Rust image is rust:\${RUST_TOOLCHAIN}-<variant>`);
    }
  }
  const declared = lines.findIndex((line) => /^ARG\s+RUST_TOOLCHAIN\s*$/.test(line));
  if (declared < 0 || declared > rustStages[0].index) fail(`${file} does not declare \`ARG RUST_TOOLCHAIN\` before its first Rust stage`);
  lines.forEach((line, index) => {
    if (/^ARG\s+RUST_TOOLCHAIN\s*=/.test(line)) fail(`${file}:${index + 1} gives RUST_TOOLCHAIN a default; with none, a build that is not told the toolchain stops`);
  });
}

if (dockerfiles === 0) fail('no Dockerfile builds from a Rust image: the check has lost what it reads');

if (failures.length > 0) {
  console.error(`❌ lint:rust-toolchain — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(`✅ lint:rust-toolchain — ${read} files read; ${dockerfiles} Dockerfiles build from rust:\${RUST_TOOLCHAIN}, and nothing but ${OWNER} writes the version or picks another`);
