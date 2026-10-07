#!/usr/bin/env node
/**
 * lint:python-version — the Python the SDK supports is written once, in
 * `requires-python`, and every restatement of it says the same.
 *
 * `requires-python = ">=X.Y"` in packages/sdk-python/pyproject.toml is the
 * floor: the oldest Python the package runs on, which an installer enforces.
 * A person moves it, rarely, so the copies the tools force are kept and held
 * here to it. What can read it does, and writes nothing.
 *
 * 1. mypy's `python_version` and pyright's `pythonVersion` are the floor:
 *    neither reads `requires-python`, and each checks the package as that
 *    Python. ruff reads it, and states no `target-version`.
 * 2. The classifiers name the supported versions, the lowest of them the
 *    floor, and the CI matrix runs exactly those.
 * 3. A workflow's single `python-version`, and every leg a step is limited
 *    to (`matrix.python-version == '…'`), is the floor.
 * 4. No file writes a Python image's tag out (`python:` and a digit), and the
 *    model generator is not told its target by a literal.
 * 5. A sentence that states the floor ("Python X.Y or later") or the
 *    supported versions ("Python X.Y, X.Z and X.W") states these.
 * 6. `requires-python` is read in one place, scripts/ci/python-floor.sh.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs):
 * the files git tracks, and new ones it does not ignore.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PYPROJECT = 'packages/sdk-python/pyproject.toml';
const GENERATOR = 'packages/sdk-python/scripts/generate_models.py';
const READER = 'scripts/ci/python-floor.sh';
/** This file names what it refuses. */
const SELF = 'scripts/lint/check-python-version.mjs';

const failures = [];
const fail = (message) => failures.push(message);
const report = () => {
  console.error(`❌ lint:python-version — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`   ${f}`);
  process.exit(1);
};

const files = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
if (!files.includes(PYPROJECT)) fail(`${PYPROJECT} is not in the repository: the check has lost what it holds`);
if (!files.includes(READER)) fail(`${READER} is not in the repository: nothing reads the floor for what needs it`);
if (failures.length > 0) report();

let floor;
try {
  floor = execFileSync(join(ROOT, READER), [], { encoding: 'utf8' }).trim();
} catch (error) {
  // What the reader said of itself, or why it could not be run at all.
  fail(`${READER} gave no floor: ${String(error.stderr ?? '').trim() || error.message}`);
  report();
}
if (!/^\d+\.\d+$/.test(floor)) {
  fail(`${READER} says the floor is "${floor}", which is not a version X.Y`);
  report();
}

/** A version X.Y as numbers, to order by. */
const parts = (version) => version.split('.').map(Number);
const byVersion = (a, b) => parts(a)[0] - parts(b)[0] || parts(a)[1] - parts(b)[1];
const same = (a, b) => a.length === b.length && a.every((version, index) => version === b[index]);

// Rules 1 and 2, in the package's own manifest.
const project = parse(readFileSync(join(ROOT, PYPROJECT), 'utf8'));
const tool = project.tool ?? {};
if (tool.mypy?.python_version !== floor) fail(`${PYPROJECT}: mypy's python_version is ${JSON.stringify(tool.mypy?.python_version)}; the floor is ${floor}`);
if (tool.pyright?.pythonVersion !== floor) fail(`${PYPROJECT}: pyright's pythonVersion is ${JSON.stringify(tool.pyright?.pythonVersion)}; the floor is ${floor}`);
if (tool.ruff?.['target-version'] !== undefined) fail(`${PYPROJECT}: ruff states a target-version; with none it takes requires-python`);
const supported = (project.project?.classifiers ?? [])
  .map((classifier) => /^Programming Language :: Python :: (\d+\.\d+)$/.exec(classifier)?.[1])
  .filter(Boolean)
  .sort(byVersion);
if (supported.length === 0) fail(`${PYPROJECT}: no classifier names a Python version`);
else if (supported[0] !== floor) fail(`${PYPROJECT}: the lowest version its classifiers name is ${supported[0]}; the floor is ${floor}`);
const supportedSaid = supported.join(', ');

let read = 0;
let matrices = 0;
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
  const isWorkflow = /^\.github\/.*\.ya?ml$/.test(file);

  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;

    if (/\bpython:[0-9]/.test(line)) fail(`${at} writes a Python image's tag out; it is python:<floor>-<variant>, with the floor ${READER} prints`);
    if (file !== PYPROJECT && file !== READER && (/\^requires-python\b/.test(line) || /\[\s*["']requires-python["']\s*\]/.test(line))) {
      fail(`${at} reads requires-python itself; ${READER} is the one reader`);
    }
    if (file === GENERATOR && /^\s*["']\d+\.\d+["'],?\s*$/.test(line)) fail(`${at} gives the generator a version by a literal; it asks ${READER}`);

    for (const [, said] of line.matchAll(/\bPython (\d+\.\d+) or later\b/g)) {
      if (said !== floor) fail(`${at} says Python ${said} or later; the floor is ${floor}`);
    }
    for (const [, said] of line.matchAll(/\bPython ((?:\d+\.\d+, )*\d+\.\d+ and \d+\.\d+)\b/g)) {
      const listed = said.split(/, | and /).sort(byVersion);
      if (!same(listed, supported)) fail(`${at} says Python ${said}; the classifiers name ${supportedSaid}`);
    }

    if (!isWorkflow) return;
    const matrix = /\bpython-version\s*:\s*\[([^\]]*)\]/.exec(line)?.[1];
    if (matrix !== undefined) {
      matrices += 1;
      const legs = [...matrix.matchAll(/\d+\.\d+/g)].map(([version]) => version).sort(byVersion);
      if (!same(legs, supported)) fail(`${at} runs Python ${legs.join(', ')}; the classifiers name ${supportedSaid}`);
    }
    const single = /\bpython-version\s*:\s*["']?(\d+\.\d+)["']?\s*$/.exec(line)?.[1];
    if (single !== undefined && single !== floor) fail(`${at} installs Python ${single}; the floor is ${floor}`);
    for (const [, leg] of line.matchAll(/\bmatrix\.python-version\s*[!=]=\s*["'](\d+\.\d+)["']/g)) {
      if (leg !== floor) fail(`${at} limits a step to the Python ${leg} leg; the leg that runs once is the floor, ${floor}`);
    }
  });
}

if (matrices === 0) fail('no workflow runs a matrix of Python versions: the check has lost what it reads');

if (failures.length > 0) report();
console.log(`✅ lint:python-version — the floor is ${floor}, and the versions ${supportedSaid}; ${read} files read, and every restatement says the same`);
