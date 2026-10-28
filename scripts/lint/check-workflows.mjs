#!/usr/bin/env node
/**
 * lint:workflows — a workflow that runs on a pull request cancels the run of
 * the push before it, and every job of it checks something.
 *
 * 1. Every workflow that triggers on `pull_request` declares, at the top
 *    level, the one `concurrency` the repository uses, its group led by the
 *    workflow's file name:
 *
 *        concurrency:
 *          group: <file name, less .yml>-${{ github.event.pull_request.number || github.sha }}
 *          cancel-in-progress: ${{ github.event_name == 'pull_request' }}
 *
 *    The group is the pull request, so a push to it cancels the run of the
 *    push before it, which nobody is waiting for: the Smelter port pushed
 *    23 times with the previous run still going each time, on a pool of 20
 *    jobs shared by the whole organisation. A push to main gets its own group
 *    and is never cancelled: it is the run that sees the merged tree. The
 *    file name, not `github.workflow`: in a workflow another one calls,
 *    `github.workflow` is the caller's name, so the workflows a release calls
 *    would share one group and wait on each other.
 *
 *    A workflow that triggers on `pull_request_target` and not `pull_request`
 *    runs for a pull request each time, so its group is the pull request and
 *    it always cancels:
 *
 *        concurrency:
 *          group: <file name, less .yml>-${{ github.event.pull_request.number }}
 *          cancel-in-progress: true
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
 *    and the gate would pass it. One more term is allowed, and only alone:
 *    `needs.changes.outputs.tier == 'full'`, for a job that runs at night and
 *    for a release and never on a pull request. `changes` outputs `tier`,
 *    which no filter defines.
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
 * 8. Stack Smoke keeps the Rust images' layers between runs under a cache key
 *    that hashes what their builder stage reads. Every path a Rust image's
 *    Dockerfile copies into that stage, and the file itself, is under a
 *    pattern of that key: a copied file the key does not hash would restore
 *    a stage built from its old contents, and the image would be stale and
 *    green.
 *
 * 9. One workflow runs on every pull request: ci.yml. Any other workflow that
 *    triggers on `pull_request` names the `paths` it checks. Six workflows
 *    once ran whole on every push, each with its own summary for the ruleset
 *    to require, and only ci.yml's jobs could read the map of changed areas:
 *    a pull request that touched one Go file ran every npm package's suite.
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
/** The workflow that keeps the Rust images' layers between runs. */
const SMOKE = '.github/workflows/stack-smoke.yml';
/** The Dockerfiles whose builder stage those layers are; their COPY lines are read. */
const RUST_IMAGES = ['apps/gateway/Dockerfile', 'apps/dispatcher/Dockerfile', 'apps/archivist/Dockerfile'];

/** A workflow's concurrency group, led by its file name. */
const groupOf = (file) => `${basename(file).replace(/\.ya?ml$/, '')}-\${{ github.event.pull_request.number || github.sha }}`;
const CANCEL = "${{ github.event_name == 'pull_request' }}";
/** The concurrency of a workflow that runs on `pull_request_target` and not `pull_request`. */
const targetGroupOf = (file) => `${basename(file).replace(/\.ya?ml$/, '')}-\${{ github.event.pull_request.number }}`;
const TARGET_CANCEL = 'true';
/** The one term of a job's `if` that is no area: the tier the run is in. */
const FULL_TIER = "needs.changes.outputs.tier == 'full'";

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
  const triggeredBy = (event) => (Array.isArray(triggers) ? triggers.includes(event) : triggers != null && typeof triggers === 'object' && event in triggers);
  const onPullRequest = triggeredBy('pull_request');
  if (!onPullRequest && !triggeredBy('pull_request_target')) continue;
  held += 1;

  const [group, cancel, why] = onPullRequest
    ? [groupOf(file), CANCEL, "a pull request's superseded run is cancelled, a push to main never is"]
    : [targetGroupOf(file), TARGET_CANCEL, "every run is a pull request's, so a superseded one is cancelled"];

  // Rule 9: ci.yml alone runs whole on every pull request.
  if (onPullRequest && file !== CI) {
    const pullRequest = Array.isArray(triggers) ? null : triggers.pull_request;
    if (pullRequest == null || !Array.isArray(pullRequest.paths) || pullRequest.paths.length === 0) {
      failures.push(`${file} runs on every pull request: make its jobs jobs of ${CI}, behind the map of changed areas, or name the paths it checks`);
    }
  }
  const concurrency = workflow.concurrency;
  if (concurrency == null || typeof concurrency !== 'object') {
    failures.push(`${file} runs on pull requests and declares no concurrency: a push to the pull request leaves the run before it going`);
  } else {
    if (concurrency.group !== group) failures.push(`${file}: concurrency.group is ${JSON.stringify(concurrency.group ?? null)}, not ${group}`);
    if (String(concurrency['cancel-in-progress']) !== cancel) {
      failures.push(`${file}: concurrency.cancel-in-progress is ${JSON.stringify(concurrency['cancel-in-progress'] ?? null)}, not ${cancel}: ${why}`);
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
  if (file === SMOKE) layerCacheKey(workflow.jobs ?? {});
}

/** A hashFiles pattern as a test of a repository path: `**` crosses directories, `*` does not. */
function patternTest(pattern) {
  const literal = (piece) => piece.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  const source = pattern
    .split('**/')
    .map((part) => part.split('**').map(literal).join('.*'))
    .join('(?:.*/)?');
  return new RegExp(`^${source}$`);
}

/** Rule 8: every file a Rust image's builder stage copies is hashed into the layer cache's key. */
function layerCacheKey(jobs) {
  const steps = Object.values(jobs).flatMap((job) => job.steps ?? []);
  const cache = steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/cache@') && String(step.with?.key ?? '').includes('rust-image-layers'));
  if (cache == null) {
    failures.push(`${SMOKE}: no actions/cache step keys the Rust images' layers (rust-image-layers)`);
    return;
  }
  const patterns = [...String(cache.with.key).matchAll(/'([^']+)'/g)].map((m) => patternTest(m[1]));
  if (patterns.length === 0) {
    failures.push(`${SMOKE}: the rust-image-layers key hashes no files`);
    return;
  }
  const hashed = (path) => patterns.some((test) => test.test(path));
  for (const dockerfile of RUST_IMAGES) {
    if (!repository.includes(dockerfile)) {
      failures.push(`${dockerfile} is not in the repository: rule 8 has lost what it reads`);
      continue;
    }
    if (!hashed(dockerfile)) failures.push(`${SMOKE}: the rust-image-layers key does not hash ${dockerfile}`);
    const builder = readFileSync(join(ROOT, dockerfile), 'utf8').split(/^FROM .* AS builder$/m)[1]?.split(/^FROM /m)[0] ?? '';
    for (const line of builder.split('\n')) {
      const copy = /^COPY\s+((?:--\S+\s+)*)(.+)$/.exec(line.trim());
      if (copy == null || copy[1].includes('--from')) continue;
      const sources = copy[2].trim().split(/\s+/).slice(0, -1);
      for (const source of sources) {
        const files = repository.filter((file) => file === source || file.startsWith(`${source}/`));
        if (files.length === 0) failures.push(`${dockerfile} copies ${source}, which the repository does not hold`);
        for (const file of files) {
          if (!hashed(file)) failures.push(`${SMOKE}: the rust-image-layers key does not hash ${file}, which ${dockerfile} copies into the builder stage: a change to it would restore a stale stage`);
        }
      }
    }
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
  for (const output of outputs) if (output !== 'tier' && !areas.includes(output)) failures.push(`${CI}: job changes outputs ${output}, which no filter defines`);
  if (!outputs.includes('tier')) failures.push(`${CI}: job changes does not output tier, which a job that runs at night alone reads`);

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
    if (condition === FULL_TIER) {
      areasOf.set(id, read);
      continue;
    }
    for (const part of condition.split(' || ')) {
      const area = term.exec(part.trim())?.[1];
      if (area == null) failures.push(`${CI}: job ${id}: the condition ${JSON.stringify(part.trim())} is not needs.changes.outputs.<area> == 'true' (the tier is read alone: ${FULL_TIER})`);
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
console.log(`✅ lint:workflows — ${held} workflows run on pull requests, each cancelling the run before it, every job of each checking something, and only ci.yml whole; ci.yml runs in stages, maps each push to its areas and tier, builds its Rust once, and ends in a gate; Stack Smoke's layer cache hashes every file the Rust images copy`);
