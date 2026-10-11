#!/usr/bin/env node
/**
 * Every audit under scripts/compliance is run by a workflow.
 *
 * An audit is a shell script that exits 1 when the tree breaks its rule.
 * Writing one does not run it: a workflow step has to name it. Five were
 * once named by no workflow, and reached only through
 * scripts/compliance/audit-all-compliance.sh, which a developer runs by hand
 * and no workflow runs. One of the five had been failing for months, since
 * the Worker became a Python service, and nothing said so.
 *
 * So: each `scripts/compliance/audit-*.sh` is named on a line of a workflow
 * that is not a comment. The one script of that name that is no audit is
 * listed below, with what it is.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Scripts named like an audit that are not one, each with why no workflow runs it. */
const NOT_AN_AUDIT = {
  'scripts/compliance/audit-all-compliance.sh': 'runs the audits, one after another, for a developer at a checkout',
};

const files = repositoryFiles(ROOT);
const audits = files.filter((file) => /^scripts\/compliance\/audit-[^/]+\.sh$/.test(file));
const workflows = files.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));

const failures = [];
if (audits.length === 0) failures.push('no scripts/compliance/audit-*.sh was found: the check has lost what it reads');
if (workflows.length === 0) failures.push('no workflow was found under .github/workflows: the check has lost what it reads');

// What a workflow runs: its lines, without the ones that are comments. An audit named only in a comment is not run.
const run = workflows
  .flatMap((file) => readFileSync(join(ROOT, file), 'utf8').split('\n'))
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

for (const [script, why] of Object.entries(NOT_AN_AUDIT)) {
  if (!audits.includes(script)) failures.push(`${script} is listed as no audit (${why}) and does not exist: take it off the list`);
  else if (run.includes(script)) failures.push(`${script} is listed as no audit (${why}) and a workflow runs it: take it off the list`);
}

let held = 0;
for (const audit of audits) {
  if (audit in NOT_AN_AUDIT) continue;
  if (run.includes(audit)) held += 1;
  else failures.push(`${audit} is run by no workflow: name it in a step of .github/workflows/architecture-compliance.yml`);
}

if (failures.length > 0) {
  console.error(`❌ lint:compliance-audits — ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`   ${failure}`);
  console.error('   An audit nothing runs holds nothing, and fails where nobody sees it.');
  process.exit(1);
}
console.log(`✅ lint:compliance-audits — all ${held} audits under scripts/compliance are run by a workflow`);
