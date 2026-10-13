#!/usr/bin/env node
/**
 * lint:workflows — a workflow that runs on a pull request cancels the run of
 * the push before it, and every job of it checks something.
 *
 * 1. Every workflow that triggers on `pull_request` declares, at the top
 *    level, the one `concurrency` the repository uses:
 *
 *        concurrency:
 *          group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}
 *          cancel-in-progress: ${{ github.event_name == 'pull_request' }}
 *
 *    The group is the pull request, so a push to it cancels the run of the
 *    push before it, which nobody is waiting for: the Smelter port pushed
 *    23 times with the previous run still going each time, on a pool of 20
 *    jobs shared by the whole organisation. A push to main gets its own group
 *    and is never cancelled: it is the run that sees the merged tree.
 *
 * 2. Every job of such a workflow has a step that is not preparation. A step
 *    is preparation when it is one of the setup actions, or a `run` whose
 *    every line installs or builds the packages (`npm ci`, `npm run
 *    build:packages`, `uv sync`), changes directory, or is a comment. A job
 *    of preparation alone takes a slot of the pool and verifies nothing: the
 *    "Configuration Validation" job did that for months, checking out,
 *    installing and building, and then ending.
 *
 * 3. ci.yml runs in two stages and ends in one gate. A job with no `needs`
 *    is the first stage: the censuses, the lints and the drift checks, which
 *    need no build. Every other job waits, directly or through what it
 *    needs, for every first-stage job, so a tree that fails a census starts
 *    none of the forty-odd matrix legs behind it. The job `gate` runs `always()`, needs
 *    every other job, and is the one check the merge ruleset requires: it
 *    fails when any job failed or was cancelled, and passes a job skipped
 *    by a condition, which GitHub reports as Success.
 *
 * 4. Every job of ci.yml behind the first stage is in the map of changed
 *    areas: its `if` is `needs.changes.outputs.<area> == 'true'` terms joined
 *    by `||`, each area one the `changes` job's filter defines and its
 *    `outputs` carry, and it needs `changes`. A job that is in no area would
 *    run on every push, which is the cost the map exists to end; an area the
 *    filter does not define would read as false and skip the job forever,
 *    and the gate would pass it.
 *
 * 5. Every directory under apps/ or packages/ that holds a manifest
 *    (package.json, Cargo.toml, pyproject.toml, go.mod) is a pattern
 *    `<dir>/**` of some filter of the map. A package nobody mapped would be
 *    tested by no job on a pull request that changed it alone.
 *
 * 6. `cargo build` is run by one job of ci.yml, build-rust, which publishes
 *    the release binaries the conformance suites start. A suite that built
 *    its own would spend the two to three minutes the shared build exists to
 *    spend once, nine times.
 *
 * 7. A job's areas are a subset of the areas of every job it needs that has
 *    areas of its own. `needs` wants success, so a need skipped for its areas
 *    skips the job whatever the job's own `if` said, and the gate passes a
 *    skipped job: a suite whose area build-rust does not list would never
 *    run on that area, and nothing would say so.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs).
 */
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The workflow that runs in stages and ends in a gate. */
const CI = '.github/workflows/ci.yml';

const GROUP = '${{ github.workflow }}-${{ github.event.pull_request.number || github.sha }}';
const CANCEL = "${{ github.event_name == 'pull_request' }}";

/** Actions that make a runner ready and check nothing. */
const SETUP_ACTIONS = ['actions/checkout', 'actions/setup-node', 'actions/setup-python', 'actions/setup-go', 'actions/cache', 'astral-sh/setup-uv'];

/** A `run` line that installs or builds the packages, goes somewhere, or is a comment. A line that
 * writes anything, a summary included, is a check's. */
const PREPARATION_LINE = /^(npm ci\b|npm run build:packages$|uv sync\b|cd\b|#)/;

/** Whether a step readies the runner and checks nothing. */
function isPreparation(step) {
  if (typeof step.uses === 'string') return SETUP_ACTIONS.includes(step.uses.replace(/@.*$/, ''));
  if (typeof step.run !== 'string') return false;
  return step.run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every((line) => PREPARATION_LINE.test(line));
}

const repository = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
const workflows = repository.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));

const failures = [];
if (workflows.length === 0) failures.push('no workflow was found under .github/workflows: the check has lost what it reads');

let held = 0;
for (const file of workflows) {
  const workflow = yaml.load(readFileSync(join(ROOT, file), 'utf8'));
  const triggers = workflow.on;
  const onPullRequest = Array.isArray(triggers) ? triggers.includes('pull_request') : triggers != null && typeof triggers === 'object' && 'pull_request' in triggers;
  if (!onPullRequest) continue;
  held += 1;

  const concurrency = workflow.concurrency;
  if (concurrency == null || typeof concurrency !== 'object') {
    failures.push(`${file} runs on pull requests and declares no concurrency: a push to the pull request leaves the run before it going`);
  } else {
    if (concurrency.group !== GROUP) failures.push(`${file}: concurrency.group is ${JSON.stringify(concurrency.group ?? null)}, not ${GROUP}`);
    if (String(concurrency['cancel-in-progress']) !== CANCEL) {
      failures.push(`${file}: concurrency.cancel-in-progress is ${JSON.stringify(concurrency['cancel-in-progress'] ?? null)}, not ${CANCEL}: a pull request's superseded run is cancelled, a push to main never is`);
    }
  }

  for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
    if (!Array.isArray(job.steps)) continue; // a job that calls a reusable workflow has no steps of its own
    if (job.steps.every(isPreparation)) {
      failures.push(`${file}: job ${name} checks out, installs or builds, and checks nothing: give it a check or delete it`);
    }
  }

  if (file === CI) {
    stagesAndGate(workflow.jobs ?? {});
    changedAreas(workflow.jobs ?? {});
    oneRustBuild(workflow.jobs ?? {});
  }
}

/** Rule 3: a first stage every job waits for, and a gate that needs them all. */
function stagesAndGate(jobs) {
  const needsOf = (id) => [].concat(jobs[id]?.needs ?? []);
  const ids = Object.keys(jobs).filter((id) => id !== 'gate');
  const firstStage = ids.filter((id) => needsOf(id).length === 0);
  if (firstStage.length === 0) failures.push(`${CI}: no job is without needs, so there is no first stage`);

  const gate = jobs.gate;
  if (gate == null) {
    failures.push(`${CI}: no job gate: the one check the merge ruleset requires is missing`);
    return;
  }
  if (String(gate.if ?? '').trim() !== 'always()') failures.push(`${CI}: job gate runs on ${JSON.stringify(gate.if ?? null)}, not always(): a failed job would skip the gate, and a skipped required check is Success`);
  const gateNeeds = new Set(needsOf('gate'));
  for (const id of ids) if (!gateNeeds.has(id)) failures.push(`${CI}: job gate does not need ${id}, so ${id} cannot fail the gate`);
  for (const id of gateNeeds) if (!(id in jobs)) failures.push(`${CI}: job gate needs ${id}, which is no job`);

  /** Every job `id` waits for, directly or through what it needs. */
  const waitsFor = (id, seen = new Set()) => {
    for (const need of needsOf(id)) if (!seen.has(need)) { seen.add(need); waitsFor(need, seen); }
    return seen;
  };
  for (const id of ids) {
    if (firstStage.includes(id)) continue;
    const reached = waitsFor(id);
    for (const first of firstStage) if (!reached.has(first)) failures.push(`${CI}: job ${id} does not wait for first-stage job ${first}`);
  }
}

/** Rule 4: every job behind the first stage is in the map of changed areas. */
function changedAreas(jobs) {
  const changes = jobs.changes;
  if (changes == null) {
    failures.push(`${CI}: no job changes: nothing maps a push to the areas it touched`);
    return;
  }
  const filterStep = (changes.steps ?? []).find((step) => typeof step.uses === 'string' && step.uses.startsWith('dorny/paths-filter@'));
  const filters = typeof filterStep?.with?.filters === 'string' ? yaml.load(filterStep.with.filters) : null;
  if (filters == null || typeof filters !== 'object') {
    failures.push(`${CI}: job changes has no dorny/paths-filter step with a filters string`);
    return;
  }
  const areas = Object.keys(filters).filter((name) => name !== 'all');
  const outputs = Object.keys(changes.outputs ?? {});
  for (const area of areas) if (!outputs.includes(area)) failures.push(`${CI}: job changes defines the area ${area} and does not output it`);
  for (const output of outputs) if (!areas.includes(output)) failures.push(`${CI}: job changes outputs ${output}, which no filter defines`);

  const term = /^needs\.changes\.outputs\.([a-z][a-z0-9-]*) == 'true'$/;
  /** The areas a job's `if` reads, by job id; a job with no area condition is absent. */
  const areasOf = new Map();
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'gate' || [].concat(job.needs ?? []).length === 0) continue; // the gate and the first stage run always
    if (![].concat(job.needs ?? []).includes('changes')) failures.push(`${CI}: job ${id} does not need changes, so it cannot read the areas`);
    const condition = typeof job.if === 'string' ? job.if.trim() : '';
    if (condition === '') {
      failures.push(`${CI}: job ${id} has no if over the changed areas, so it runs on every push`);
      continue;
    }
    const read = new Set();
    for (const part of condition.split(' || ')) {
      const area = term.exec(part.trim())?.[1];
      if (area == null) failures.push(`${CI}: job ${id}: the condition ${JSON.stringify(part.trim())} is not needs.changes.outputs.<area> == 'true'`);
      else if (!areas.includes(area)) failures.push(`${CI}: job ${id} reads the area ${area}, which the changes job does not define: it would never run`);
      else read.add(area);
    }
    areasOf.set(id, read);
  }

  // Rule 7: a job's areas are within those of every need that has areas.
  for (const [id, read] of areasOf) {
    for (const need of [].concat(jobs[id].needs ?? [])) {
      const needReads = areasOf.get(need);
      if (needReads == null) continue;
      for (const area of read) {
        if (!needReads.has(area)) failures.push(`${CI}: job ${id} runs on the area ${area} and needs ${need}, which does not: on a change to ${area} alone ${need} is skipped, so ${id} is skipped whatever its if says, and the gate passes it`);
      }
    }
  }

  // Rule 5: every package of the repository is under some filter.
  const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
  const patterns = new Set(Object.values(filters).flat());
  const packages = repository
    .filter((file) => /^(apps|packages)\/[^/]+\/[^/]+$/.test(file) && MANIFESTS.includes(basename(file)))
    .map((file) => dirname(file));
  for (const dir of new Set(packages)) {
    if (!patterns.has(`${dir}/**`)) failures.push(`${CI}: ${dir} has a manifest and no filter of the changes job names ${dir}/**: a change to it alone would run no job`);
  }
}

/** Rule 6: the release binaries are built once. */
function oneRustBuild(jobs) {
  if (!('build-rust' in jobs)) failures.push(`${CI}: no job build-rust: nothing builds the binaries the conformance suites start`);
  for (const [id, job] of Object.entries(jobs)) {
    if (id === 'build-rust') continue;
    for (const step of job.steps ?? []) {
      if (typeof step.run === 'string' && /\bcargo build\b/.test(step.run)) {
        failures.push(`${CI}: job ${id} runs cargo build; build-rust builds the binaries once, fetch them from its artifact`);
      }
    }
  }
}

if (held === 0) failures.push('no workflow runs on pull_request: the check has lost what it reads');

if (failures.length > 0) {
  console.error(`❌ lint:workflows — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`   ${failure}`);
  process.exit(1);
}
console.log(`✅ lint:workflows — ${held} workflows run on pull requests, each cancelling the run before it, every job of each checking something; ci.yml runs in stages, maps each push to its areas, builds its Rust once, and ends in a gate`);
