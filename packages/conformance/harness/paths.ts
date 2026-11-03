import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// What the kit reads of this repository. What it tests is not named here: a
// run names its implementations file (implementations.ts).

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * What a process a suite starts is given of the suite's own environment,
 * beside what its service's table lists: the PATH it is found on, and, when
 * the run measures coverage, how each kind of program is measured: the
 * LLVM_PROFILE_FILE an instrumented binary writes what it ran to as it exits,
 * which ci.yml sets in every job that starts one of the Rust binaries, and
 * the JAVA_OPTS a JVM driver's start script runs it with, which carry JaCoCo's
 * agent where ci.yml measures the Kotlin drivers.
 */
export function runEnvironment(): Record<string, string> {
  const measured = Object.fromEntries(
    ['LLVM_PROFILE_FILE', 'JAVA_OPTS'].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  return { PATH: process.env['PATH'] ?? '', ...measured };
}

/** The Python SDK, whose locked environment the SDK and worker suites' setups make for its drivers. */
export const PYTHON_SDK = join(REPO_ROOT, 'packages/python/sdk');

/**
 * The model catalogue file a worker's document and a Librarian's each name:
 * the repository's one generated copy, which their images carry. A service
 * reads it only for a provider whose own API does not state a model's facts,
 * and no suite here runs one.
 */
export const MODEL_CATALOGUE = join(REPO_ROOT, 'packages/python/inference/tests/catalogue/model-catalogue.json');

export const SPEC_SOURCE = join(REPO_ROOT, 'specs/src');
