#!/usr/bin/env node
/**
 * lint:kotlin-toolchain — the JDK, Gradle and Kotlin a Kotlin build runs on
 * are each written once, in the file its own tool reads.
 *
 * The JDK is the one line of a Gradle build's `.java-version`: actions/setup-java
 * reads it (`java-version-file`), the build takes it as its toolchain, and a
 * JDK image's tag is eclipse-temurin:<version>-jdk, which
 * scripts/ci/jdk-version.sh prints. Gradle is the distribution its wrapper
 * names, with the distribution's checksum, and the wrapper fetches it. Kotlin
 * is the `kotlin` version of its version catalog, and its plugins are applied
 * from the catalog.
 *
 * 1. Every Gradle build (a directory with a settings.gradle.kts) has a
 *    `.java-version` stating a major version, a wrapper whose
 *    `distributionUrl` names a Gradle distribution and whose
 *    `distributionSha256Sum` is stated, and a version catalog stating
 *    `kotlin`; and each is the same in every build.
 * 2. No file writes a JDK image's tag out (`eclipse-temurin:` and a digit),
 *    nor a Gradle image's (`gradle:` and a digit).
 * 3. A workflow names a `.java-version` (`java-version-file:`), never a JDK
 *    version (`java-version:`), and never a Gradle version (`gradle-version:`).
 * 4. A build script states no version of a plugin or a library: each is the
 *    catalog's (`alias(libs.plugins.…)`, `libs.…`).
 * 5. A `.java-version` is read by a script in one place,
 *    scripts/ci/jdk-version.sh.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const READER = 'scripts/ci/jdk-version.sh';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-kotlin-toolchain.mjs';

const failures = [];
const fail = (message) => failures.push(message);
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
const builds = files.filter((file) => basename(file) === 'settings.gradle.kts').map(dirname);
if (builds.length === 0) fail('the repository holds no settings.gradle.kts: the check has lost what it holds');
if (!files.includes(READER)) fail(`${READER} is not in the repository: nothing reads the JDK for the images`);

/** Rule 1: what each build states. */
const stated = builds.map((build) => {
  const owned = (path) => (files.includes(`${build}/${path}`) ? read(`${build}/${path}`) : undefined);
  const javaVersion = owned('.java-version');
  const wrapper = owned('gradle/wrapper/gradle-wrapper.properties');
  const catalog = owned('gradle/libs.versions.toml');
  if (javaVersion === undefined) fail(`${build} has no .java-version: nothing states the JDK it is built on`);
  else if (!/^\d+\n?$/.test(javaVersion)) fail(`${build}/.java-version states ${JSON.stringify(javaVersion.trim())}, and states a JDK's major version alone`);
  if (wrapper === undefined) fail(`${build} has no gradle/wrapper/gradle-wrapper.properties: nothing names the Gradle it is built with`);
  const gradle = wrapper && /^distributionUrl=https\\:\/\/services\.gradle\.org\/distributions\/gradle-([\d.]+)-bin\.zip$/m.exec(wrapper)?.[1];
  if (wrapper !== undefined && !gradle) fail(`${build}'s wrapper names no Gradle distribution (distributionUrl=…/gradle-<version>-bin.zip)`);
  if (wrapper !== undefined && !/^distributionSha256Sum=[0-9a-f]{64}$/m.test(wrapper)) fail(`${build}'s wrapper states no distributionSha256Sum: a distribution it fetches is not checked`);
  if (catalog === undefined) fail(`${build} has no gradle/libs.versions.toml: nothing states the Kotlin it is built with`);
  const kotlin = catalog && /^kotlin = "([^"]+)"$/m.exec(catalog)?.[1];
  if (catalog !== undefined && !kotlin) fail(`${build}/gradle/libs.versions.toml states no \`kotlin = "<version>"\``);
  return { build, jdk: javaVersion?.trim(), gradle, kotlin };
});
const [first, ...rest] = stated;
for (const other of rest) {
  for (const [what, key] of [['the JDK', 'jdk'], ['Gradle', 'gradle'], ['Kotlin', 'kotlin']]) {
    if (other[key] && first[key] && other[key] !== first[key]) fail(`${other.build} is built with ${what} ${other[key]} and ${first.build} with ${first[key]}; every build states one`);
  }
}

let read_ = 0;
for (const file of files) {
  if (file === SELF) continue;
  let text;
  try {
    text = read(file);
  } catch {
    continue; // a directory git lists (a submodule), or a link to nothing
  }
  if (text.includes('\u0000')) continue; // not text
  read_ += 1;
  const isWorkflow = /^\.github\/.*\.ya?ml$/.test(file);
  const isBuildScript = file.endsWith('.gradle.kts');
  const isScript = /\.(?:sh|mjs|js|py|kts)$/.test(file) || isWorkflow;

  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    if (/\beclipse-temurin:[0-9]/.test(line)) fail(`${at} writes a JDK image's tag out; it is eclipse-temurin:<version>-jdk, with the version .java-version states (${READER})`);
    if (/(?:^|[\s"'=])gradle:[0-9]/.test(line)) fail(`${at} writes a Gradle image's tag out; a build runs the Gradle its wrapper names`);
    if (isWorkflow) {
      if (/\bjava-version\s*:/.test(line)) fail(`${at} names a JDK version; a workflow names a .java-version (java-version-file)`);
      if (/\bgradle-version\s*:/.test(line)) fail(`${at} names a Gradle version; a build runs the Gradle its wrapper names`);
      const named = /\bjava-version-file\s*:\s*["']?([^"'\s]+)/.exec(line)?.[1];
      if (named && !(basename(named) === '.java-version' && builds.includes(dirname(named)))) fail(`${at} takes its JDK from ${named}, which is no Gradle build's .java-version`);
      if (named) return;
    }
    if (isBuildScript) {
      if (/\)\s*version\s*["(]/.test(line) || /\bversion\s*=\s*"[\d.]+"/.test(line)) fail(`${at} states a version; a build script takes every version from its catalog (alias(libs.plugins.…), libs.…)`);
      if (/"[\w.-]+:[\w.-]+:[\d][^"]*"/.test(line)) fail(`${at} names a library with its version; a build script takes it from its catalog (libs.…)`);
    }
    if (isScript && !isBuildScript && file !== READER && /\b(?:cat|sed|awk|head|tail|grep|read|readFileSync|readText|open)\b.*\.java-version\b/.test(line)) {
      fail(`${at} reads a .java-version itself; ${READER} is the one script that reads it`);
    }
  });
}

if (failures.length > 0) {
  console.error(`❌ lint:kotlin-toolchain — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
}
console.log(
  `✅ lint:kotlin-toolchain — ${builds.join(' and ')} ${builds.length === 1 ? 'is' : 'are'} built on JDK ${first.jdk}, Gradle ${first.gradle} and Kotlin ${first.kotlin}; ${read_} files read, and none writes one of them out or reads .java-version but ${READER}`,
);
