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
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

const workflows = repositoryFiles(ROOT).filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));

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

  if (file === CI) stagesAndGate(workflow.jobs ?? {});
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

if (held === 0) failures.push('no workflow runs on pull_request: the check has lost what it reads');

if (failures.length > 0) {
  console.error(`❌ lint:workflows — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`   ${failure}`);
  process.exit(1);
}
console.log(`✅ lint:workflows — ${held} workflows run on pull requests, each cancelling the run before it, every job of each checking something; ci.yml runs in stages and ends in a gate`);
