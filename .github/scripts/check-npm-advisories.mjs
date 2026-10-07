#!/usr/bin/env node
/**
 * The npm packages the repository's lockfiles resolve outside development
 * dependencies, held to GitHub's advisory database: no advisory of high or
 * critical severity stands against one.
 *
 * Which packages those are is npm's own answer, `npm audit --omit=dev` over
 * each lockfile git tracks: what a workspace names under `dependencies`, and
 * all that brings. The audit reads the lockfile and asks the registry, so
 * nothing is installed.
 *
 * A lockfile decides the versions built here: what the Browser and the
 * desktop app bundle, and what CI tests. It does not decide what installing a
 * published package brings, or what a service image installs: both resolve
 * the packages' ranges on the day. So a failure names a version this
 * repository builds with, and moving the lockfile is the fix.
 *
 * Two kinds of package are another check's:
 *
 * - A development dependency reaches nobody who installs or runs a release.
 *   Dependabot's alerts report advisories against those.
 * - An optional peer a package loads when its consumer installed it
 *   (neo4j-driver, for @semiont/graph) is a development dependency to the
 *   lockfile. The image that installs one is scanned with it, when the image
 *   is published.
 *
 * An advisory read and judged not to reach what ships is recorded in
 * .github/npm-advisories.json with why. One that stops matching fails the
 * run, so none outlives the package it was about.
 *
 * npm exits 1 for a report that holds findings and for a registry it could
 * not reach, so the exit status says nothing: a report is read only when it
 * is one, and anything else fails as an audit that did not happen.
 *
 * Usage (the npm Advisories workflow runs it; it needs the registry):
 *   node .github/scripts/check-npm-advisories.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from '../../scripts/lint/repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const IGNORES = '.github/npm-advisories.json';
/** npm's severities, least to most. */
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const HELD = new Set(['high', 'critical']);
const GHSA = /^GHSA(-[0-9a-z]{4}){3}$/;

const problems = [];

/** The report `npm audit` prints for one lockfile, or a thrown account of why there is none. */
function audit(lockfile) {
  const ran = spawnSync('npm', ['audit', '--json', '--package-lock-only', '--omit=dev'], {
    cwd: join(ROOT, dirname(lockfile)),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (ran.error) throw ran.error;
  let report;
  try {
    report = JSON.parse(ran.stdout);
  } catch {
    report = undefined;
  }
  if (report?.auditReportVersion !== 2 || report.vulnerabilities === null || typeof report.vulnerabilities !== 'object') {
    const said = ran.stderr.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('npm notice'));
    throw new Error(`npm audit (exit ${ran.status}) printed no report: ${(said.join(' | ') || ran.stdout.trim() || '(nothing)').slice(0, 400)}`);
  }
  return report;
}

/**
 * The advisories a report holds. A package's `via` names each advisory
 * against it, and names by a bare string each package it is only vulnerable
 * through, whose own entry carries the advisory.
 */
function advisoriesOf(report, lockfile) {
  const found = [];
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    for (const via of entry.via) {
      if (typeof via === 'string') continue;
      const id = String(via.url).split('/').pop();
      if (!GHSA.test(id)) throw new Error(`an advisory against ${name} has no GHSA id: ${JSON.stringify(via).slice(0, 300)}`);
      if (!SEVERITIES.includes(via.severity)) throw new Error(`${id} has a severity npm does not define: ${JSON.stringify(via.severity)}`);
      found.push({ id, severity: via.severity, name, range: via.range, title: via.title, lockfile, nodes: entry.nodes });
    }
  }
  return found;
}

/** The recorded ignores, each an advisory id and why it does not reach what ships. */
function ignores() {
  const recorded = JSON.parse(readFileSync(join(ROOT, IGNORES), 'utf8'));
  if (!Array.isArray(recorded.ignore) || Object.keys(recorded).length !== 1) {
    throw new Error(`${IGNORES} holds one key, "ignore", a list`);
  }
  const seen = new Set();
  for (const entry of recorded.ignore) {
    const keys = entry === null || typeof entry !== 'object' ? [] : Object.keys(entry).sort();
    if (keys.join() !== 'id,reason' || !GHSA.test(entry.id) || typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`${IGNORES}: each ignore is { "id": "GHSA-…", "reason": "…" }, and this is not one: ${JSON.stringify(entry)}`);
    }
    if (seen.has(entry.id)) throw new Error(`${IGNORES} ignores ${entry.id} twice`);
    seen.add(entry.id);
  }
  return recorded.ignore;
}

const lockfiles = repositoryFiles(ROOT).filter((file) => basename(file) === 'package-lock.json');
if (lockfiles.length === 0) problems.push('git tracks no package-lock.json: there is nothing to audit, which is not the same as nothing found');

const advisories = [];
for (const lockfile of lockfiles) {
  try {
    advisories.push(...advisoriesOf(audit(lockfile), lockfile));
  } catch (error) {
    problems.push(`${lockfile} was not audited. ${error.message}`);
  }
}

let ignored = [];
try {
  ignored = ignores();
} catch (error) {
  problems.push(error.message);
}

const held = advisories.filter((advisory) => HELD.has(advisory.severity));
const ignoredIds = new Set(ignored.map((entry) => entry.id));

for (const advisory of held) {
  if (ignoredIds.has(advisory.id)) continue;
  problems.push(
    `${advisory.id} (${advisory.severity}) ${advisory.name} ${advisory.range}: ${advisory.title}\n` +
      `    ${advisory.lockfile}: ${advisory.nodes.join(', ')}\n` +
      `    https://github.com/advisories/${advisory.id}`,
  );
}
for (const entry of ignored) {
  if (!held.some((advisory) => advisory.id === entry.id)) {
    problems.push(`${IGNORES} ignores ${entry.id}, which no lockfile's shipped packages are subject to any longer: delete the entry`);
  }
}

if (problems.length > 0) {
  console.error(`✗ npm advisories: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const lower = advisories.filter((advisory) => !HELD.has(advisory.severity));
console.log(`✓ npm advisories: ${lockfiles.length} lockfile(s), no high or critical advisory against a shipped package`);
for (const entry of ignored) console.log(`  ignored: ${entry.id} — ${entry.reason}`);
if (lower.length > 0) console.log(`  below high, not held here: ${[...new Set(lower.map((advisory) => advisory.id))].join(', ')}`);
