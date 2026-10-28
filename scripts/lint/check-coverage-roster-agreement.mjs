#!/usr/bin/env node
/**
 * Every package's coverage is measured, and every place that names it agrees.
 *
 * The packages are the directories packages/<language>/<name> that hold a
 * manifest, and the Browser is images/browser. A package's flag is
 * `<language>-<name>`; the Browser's is `browser`. Each one's coverage is
 * named in five places by hand:
 *
 *   - an upload in ci.yml whose `flags:` give its flag;
 *   - a flag of that name in codecov.yml, scoped to its directory and carried
 *     forward, so it does not read as no data whenever its job does not run;
 *   - a component of that name in codecov.yml, scoped to its directory, which
 *     puts it in the component breakdown;
 *   - for a package, a Codecov badge for that flag in its README;
 *   - for a package, its row in its language's README,
 *     packages/<language>/README.md, with the same badge.
 *
 * And the npm workspaces' coverage is what their `test:coverage` scripts
 * write: each npm package declares one, the test-package matrix of ci.yml
 * names it, and a workspace that declares one is measured.
 *
 * Add a package and none of these notice. The upload is accepted under a flag
 * Codecov was never told about, a badge reads "unknown", and the package is
 * absent from the coverage everyone reads, while every check stays green. So
 * each is held both ways: a declaration that outlives its package fails too.
 *
 * A file that cannot be read is a FAILURE, not a pass.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import { repositoryFiles } from './repository-files.mjs';
import { workspaceDirectories } from './workspaces.mjs';

const ROOT = process.cwd();
const CODECOV = '.github/codecov.yml';
const WORKFLOW = '.github/workflows/ci.yml';
const MANIFESTS = ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];
const BROWSER = { dir: 'images/browser', flag: 'browser' };
const yaml = createRequire(join(ROOT, 'package.json'))('js-yaml');

const read = (file) => {
  try {
    return readFileSync(join(ROOT, file), 'utf8');
  } catch {
    console.error(`\n✖ cannot read ${file} — this gate cannot answer its question without it.\n`);
    process.exit(1);
  }
};
const badge = (flag) =>
  `[![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=${flag})](https://codecov.io/gh/The-AI-Alliance/semiont?flag=${flag})`;

// ---------- the packages ----------

const files = repositoryFiles(ROOT);
const packages = [
  ...new Map(
    files
      .map((file) => /^packages\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(file))
      .filter((m) => m !== null && MANIFESTS.includes(m[3]))
      .map(([, language, name]) => [`${language}/${name}`, { language, name, dir: `packages/${language}/${name}`, flag: `${language}-${name}` }]),
  ).values(),
];
if (packages.length === 0) {
  console.error('\n✖ found no package under packages/<language>/<name>: the gate has lost what it reads.\n');
  process.exit(1);
}
const measured = [...packages, BROWSER];
const flagsMeasured = new Set(measured.map((m) => m.flag));
const languages = [...new Set(packages.map((p) => p.language))];

// ---------- what ci.yml uploads ----------

const workflow = yaml.load(read(WORKFLOW));
const uploaded = new Map(); // flag -> the jobs that upload it
for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.uses !== 'string' || !step.uses.startsWith('codecov/codecov-action@')) continue;
    const written = String(step.with?.flags ?? '');
    const variable = /\$\{\{\s*matrix\.([a-z-]+)\s*\}\}/.exec(written);
    const values = variable === null ? [written] : (job.strategy?.matrix?.[variable[1]] ?? []).map((value) => written.replace(variable[0], value));
    for (const flag of values.flatMap((value) => value.split(',')).map((flag) => flag.trim()).filter(Boolean)) {
      uploaded.set(flag, [...(uploaded.get(flag) ?? []), id]);
    }
  }
}
if (uploaded.size === 0) {
  console.error(`\n✖ found no codecov upload in ${WORKFLOW}: the gate has lost what it reads.\n`);
  process.exit(1);
}

// ---------- what codecov.yml declares ----------

const codecov = yaml.load(read(CODECOV));
const flags = new Map(Object.entries(codecov.flags ?? {}));
const components = new Map((codecov.component_management?.individual_components ?? []).map((c) => [c.component_id, c]));
for (const [what, value] of [['flags', flags], ['component_management.individual_components', components]]) {
  if (value.size === 0) {
    console.error(`\n✖ could not read ${what} out of ${CODECOV}. A census that cannot see one of its lists is not a census.\n`);
    process.exit(1);
  }
}
const covers = (paths, dir) => (paths ?? []).some((path) => path === `${dir}/**`);

// ---------- the census ----------

const problems = [];

for (const m of measured) {
  if (!uploaded.has(m.flag)) problems.push(`${m.dir} is uploaded under no flag "${m.flag}": no job of ${WORKFLOW} names it in a codecov upload's flags.`);
  const flag = flags.get(m.flag);
  if (flag === undefined) {
    problems.push(`${m.dir} has no flag "${m.flag}" in ${CODECOV}: its upload lands unscoped, with no carryforward.`);
  } else {
    if (!covers(flag.paths, m.dir)) problems.push(`the flag "${m.flag}" is scoped to ${JSON.stringify(flag.paths)}, not ${m.dir}/**.`);
    if (flag.carryforward !== true) problems.push(`the flag "${m.flag}" has no "carryforward: true", so it reads as no data whenever its job does not run.`);
  }
  const component = components.get(m.flag);
  if (component === undefined) problems.push(`${m.dir} has no component "${m.flag}" in ${CODECOV}, so it is absent from the component breakdown.`);
  else if (!covers(component.paths, m.dir)) problems.push(`the component "${m.flag}" is scoped to ${JSON.stringify(component.paths)}, not ${m.dir}/**.`);
}

for (const [flag, jobs] of uploaded) {
  if (!flagsMeasured.has(flag)) problems.push(`${WORKFLOW} (${[...new Set(jobs)].join(', ')}) uploads the flag "${flag}", which is no package's.`);
}
for (const [flag] of flags) if (!flagsMeasured.has(flag)) problems.push(`${CODECOV} declares the flag "${flag}", which is no package's.`);
for (const [id] of components) if (!flagsMeasured.has(id)) problems.push(`${CODECOV} declares the component "${id}", which is no package's.`);

// Each package's README carries its badge, and its language's README its row.
const readmes = new Set(files.filter((file) => /^packages\/.*README\.md$/.test(file)));
for (const p of packages) {
  const own = `${p.dir}/README.md`;
  if (!readmes.has(own)) problems.push(`${p.dir} has no README.md to carry its coverage badge.`);
  else if (!read(own).includes(badge(p.flag))) problems.push(`${own} carries no Codecov badge for its flag:\n      ${badge(p.flag)}`);
}
for (const language of languages) {
  const index = `packages/${language}/README.md`;
  if (!readmes.has(index)) {
    problems.push(`packages/${language}/ has no README.md listing its packages.`);
    continue;
  }
  const text = read(index);
  const own = packages.filter((p) => p.language === language);
  for (const p of own) {
    if (!text.includes(`](./${p.name}/README.md)`)) problems.push(`${index} does not link ${p.name} (](./${p.name}/README.md)).`);
    if (!text.includes(badge(p.flag))) problems.push(`${index} does not carry ${p.name}'s Codecov badge.`);
  }
  for (const [, linked] of text.matchAll(/\]\(\.\/([^/)]+)\/README\.md\)/g)) {
    if (!own.some((p) => p.name === linked)) problems.push(`${index} links ${linked}, which is no package of packages/${language}/.`);
  }
}
for (const readme of readmes) {
  for (const [, flag] of read(readme).matchAll(/codecov\.io\/gh\/The-AI-Alliance\/semiont[^)\s]*[?&]flag=([a-z0-9-]+)/g)) {
    if (!flagsMeasured.has(flag)) problems.push(`${readme} shows a Codecov badge for the flag "${flag}", which is no package's.`);
  }
}

// The npm workspaces: what declares test:coverage is measured, and the matrix runs the npm packages.
const manifest = (dir) => {
  try {
    return JSON.parse(read(`${dir}/package.json`));
  } catch (error) {
    console.error(`\n✖ cannot parse ${dir}/package.json (${error.message}).\n`);
    process.exit(1);
  }
};
const measuredDirs = new Set(measured.map((m) => m.dir));
for (const dir of workspaceDirectories(ROOT)) {
  if (manifest(dir).scripts?.['test:coverage'] && !measuredDirs.has(dir)) {
    problems.push(`${dir} declares "test:coverage", and is no package this gate measures: its coverage is written and uploaded nowhere.`);
  }
}
const npmPackages = packages.filter((p) => p.language === 'typescript');
for (const p of npmPackages) {
  if (!manifest(p.dir).scripts?.['test:coverage']) problems.push(`${p.dir} declares no "test:coverage": the matrix runs it, and its run writes no lcov.info.`);
}
const matrix = workflow.jobs?.['test-package']?.strategy?.matrix?.package;
if (!Array.isArray(matrix)) {
  problems.push(`${WORKFLOW} has no test-package job with a package matrix: the npm packages' coverage is measured nowhere.`);
} else {
  const named = new Set(npmPackages.map((p) => p.name));
  for (const name of named) if (!matrix.includes(name)) problems.push(`the test-package matrix of ${WORKFLOW} does not run packages/typescript/${name}.`);
  for (const name of matrix) if (!named.has(name)) problems.push(`the test-package matrix of ${WORKFLOW} runs "${name}", which is no package of packages/typescript/.`);
}
if (!manifest(BROWSER.dir).scripts?.['test:coverage']) problems.push(`${BROWSER.dir} declares no "test:coverage", and test-browser uploads what it writes.`);

if (problems.length > 0) {
  console.error('\n✖ the coverage roster disagrees with itself:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\n  Each package\'s coverage is named in five places: an upload in ci.yml, a flag and a\n' +
      '  component in codecov.yml, its README\'s badge, and its row in its language\'s README.\n' +
      '  When they disagree the pipeline stays green and the package vanishes from the coverage\n' +
      '  everyone reads.\n',
  );
  process.exit(1);
}

console.log(
  `✅ coverage roster: ${packages.length} packages in ${languages.length} languages and the Browser, each uploaded under its flag, ` +
    `with its flag and component in ${basename(CODECOV)}, its badge in its README and its row in its language's`,
);
