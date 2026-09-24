#!/usr/bin/env node
/**
 * The set of packages whose coverage CI measures is written out by hand in four
 * places, and nothing makes them agree.
 *
 * A package declares `test:coverage`; `package-tests.yml` names it in the job
 * matrix; `codecov.yml` declares a flag for it (which is what gives it `paths`
 * scoping and `carryforward`); and `codecov.yml` declares a component for it
 * (which is what puts it in the component breakdown). Add a package and three
 * of those four do not notice. Nothing fails — the matrix uploads under a flag
 * Codecov was never told about, the upload is accepted, and the package is
 * simply absent from the view everyone reads.
 *
 * That is not hypothetical. `sdk` had no flag from the day `codecov.yml` was
 * written until 2026-09-23; `vectors` joined the matrix in #595 and the config
 * was not touched. Both were invisible for as long as they existed, because
 * every step in the chain is green when the file it wants does not exist.
 *
 * A block that cannot be read is a FAILURE, not a pass: a census that silently
 * checks three of four things is not a census.
 *
 * Deliberately NOT parsed with a YAML library. `js-yaml` is only a transitive
 * dependency here, and a gate that breaks when something else bumps its deps
 * fails for a reason that has nothing to do with what it checks.
 */
import { readFileSync, readdirSync, existsSync } from 'fs';
import { basename, dirname } from 'path';

const CODECOV = 'codecov.yml';
const WORKFLOW = '.github/workflows/package-tests.yml';

/**
 * Workspaces measured somewhere other than the package matrix. Each carries the
 * file that measures it, and that claim is VERIFIED below — an exemption list
 * nobody checks is one more ungated mirror, which is the defect this gate is
 * about.
 */
const EXEMPT_FROM_MATRIX = [
  { name: 'browser', dir: 'apps/browser', uploadedBy: '.github/workflows/security-tests.yml' },
  { name: 'gateway', dir: 'apps/gateway', uploadedBy: '.github/workflows/security-tests.yml' },
];

const read = (file) => {
  try {
    // Normalise the trailing newline. Every block parser below anchors on
    // line ends, and codecov.yml ships without a final one — which silently
    // truncated the last flag's body and reported a `carryforward` that was
    // plainly there. A gate that cries wolf gets switched off.
    const content = readFileSync(file, 'utf8');
    return content.endsWith('\n') ? content : `${content}\n`;
  } catch {
    console.error(`\n✖ cannot read ${file} — this gate cannot answer its question without it.\n`);
    process.exit(1);
  }
};

// ---------- what declares coverage ----------

/**
 * Expand the `workspaces` globs against the filesystem.
 *
 * Deliberately NOT `npm query .workspace`: that reads the INSTALLED tree, so a
 * package added but not yet installed is invisible to it — which is the exact
 * moment this gate exists to catch. Reading the globs needs no install, no
 * lockfile and no subprocess.
 */
function workspaceDirectories() {
  const globs = JSON.parse(readFileSync('package.json', 'utf8')).workspaces ?? [];
  const dirs = [];
  for (const glob of globs) {
    if (!glob.includes('*')) {
      if (existsSync(`${glob}/package.json`)) dirs.push(glob);
      continue;
    }
    const parent = dirname(glob);
    let entries;
    try {
      entries = readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory() && existsSync(`${parent}/${e.name}/package.json`)) dirs.push(`${parent}/${e.name}`);
    }
  }
  return dirs;
}

const workspaces = workspaceDirectories()
  // Keyed by DIRECTORY basename, not npm name: every list this gate compares is
  // written that way — the matrix interpolates `packages/${matrix.package}`, and
  // the flags scope `apps/browser/**`. `apps/browser` is the npm package
  // `semiont-browser`, so keying by npm name silently matches nothing.
  .map((dir) => ({ name: basename(dir), dir }))
  .filter((w) => {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(`${w.dir}/package.json`, 'utf8'));
    } catch {
      return false;
    }
    return Boolean(pkg.scripts?.['test:coverage']);
  });

// ---------- what the matrix runs ----------

const workflow = read(WORKFLOW);
const matrixBlock = /package:\s*\n((?:\s*-\s*\S+\s*\n)+)/.exec(workflow);
if (matrixBlock === null) {
  console.error(`\n✖ could not find the package matrix in ${WORKFLOW}. If it moved, move this gate with it.\n`);
  process.exit(1);
}
const matrix = [...matrixBlock[1].matchAll(/-\s*(\S+)/g)].map((m) => m[1]);

// ---------- what codecov.yml declares ----------

const codecov = read(CODECOV);

/** `flags:` → the mapping's own keys, with the paths each scopes itself to. */
function readFlags(source) {
  const start = /^flags:\s*$/m.exec(source);
  if (start === null) return null;
  const rest = source.slice(start.index + start[0].length);
  const end = /^\S/m.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;
  const flags = new Map();
  for (const m of block.matchAll(/^ {2}([a-z0-9-]+):\s*\n((?:^ {4}.*\n|^\s*\n)*)/gm)) {
    const paths = [...m[2].matchAll(/^ {6}-\s*(\S+)\s*$/gm)].map((p) => p[1]);
    flags.set(m[1], { paths, carryforward: /carryforward:\s*true/.test(m[2]) });
  }
  return flags;
}

/** `component_management.individual_components` → each id with its paths. */
function readComponents(source) {
  const start = /^component_management:\s*$/m.exec(source);
  if (start === null) return null;
  const rest = source.slice(start.index + start[0].length);
  const end = /^\S/m.exec(rest);
  const block = end ? rest.slice(0, end.index) : rest;
  const components = new Map();
  for (const m of block.matchAll(/-\s*component_id:\s*(\S+)\s*\n((?:\s{6}.*\n)*)/g)) {
    const paths = [...m[2].matchAll(/-\s*(\S+)\s*$/gm)].map((p) => p[1]);
    components.set(m[1], { paths });
  }
  return components;
}

const flags = readFlags(codecov);
const components = readComponents(codecov);
for (const [what, value] of [['flags:', flags], ['component_management:', components]]) {
  if (value === null || value.size === 0) {
    console.error(`\n✖ could not read ${what} out of ${CODECOV}. A census that cannot see one of its\n  four lists is not a census — fix this gate rather than deleting the question.\n`);
    process.exit(1);
  }
}

// ---------- the census ----------

const problems = [];
const exemptNames = new Set(EXEMPT_FROM_MATRIX.map((e) => e.name));
const measured = [...workspaces];

// The exemption must be true, not merely asserted.
for (const e of EXEMPT_FROM_MATRIX) {
  const uploader = read(e.uploadedBy);
  if (!uploader.includes(`${e.dir}/coverage`)) {
    problems.push(
      `${e.name} is exempt from the matrix on the grounds that ${e.uploadedBy} uploads it,\n` +
        `    and that file no longer mentions ${e.dir}/coverage. Either the upload moved (fix the\n` +
        `    exemption) or it is gone (remove the exemption and put ${e.name} in the matrix).`,
    );
  }
}

for (const w of workspaces) {
  if (!matrix.includes(w.name) && !exemptNames.has(w.name)) {
    problems.push(
      `${w.name} declares "test:coverage" but is not in the ${WORKFLOW} matrix, so its coverage\n` +
        `    is never produced. Add it to the matrix, or exempt it here with the file that measures it.`,
    );
  }
}

for (const name of matrix) {
  if (!workspaces.some((w) => w.name === name)) {
    problems.push(
      `the matrix runs "${name}", which is not a workspace declaring "test:coverage". The job falls\n` +
        `    back to "npm test -- --coverage" and produces no lcov. Give it the script or drop it.`,
    );
  }
}

for (const w of measured) {
  const flag = flags.get(w.name);
  if (flag === undefined) {
    problems.push(
      `${w.name} is measured but has no flag in ${CODECOV}. Its upload lands unscoped, with no\n` +
        `    carryforward — declare it beside the others.`,
    );
  } else {
    if (!flag.paths.some((p) => p.startsWith(`${w.dir}/`))) {
      problems.push(`the "${w.name}" flag scopes paths ${JSON.stringify(flag.paths)}, which does not cover ${w.dir}/.`);
    }
    if (!flag.carryforward) {
      problems.push(`the "${w.name}" flag has no "carryforward: true", so it reads as no-data whenever its job does not run.`);
    }
  }

  const component = components.get(w.name);
  if (component === undefined) {
    problems.push(`${w.name} is measured but appears in no component, so it is absent from the component breakdown.`);
  } else if (!component.paths.some((p) => p.startsWith(`${w.dir}/`))) {
    problems.push(`the "${w.name}" component scopes paths ${JSON.stringify(component.paths)}, which does not cover ${w.dir}/.`);
  }
}

// Rot in the other direction: a declaration outliving the package.
const measuredNames = new Set(measured.map((w) => w.name));
for (const [name] of flags) {
  if (!measuredNames.has(name)) problems.push(`${CODECOV} declares the flag "${name}", which is no package this repo measures.`);
}
for (const [name] of components) {
  if (!measuredNames.has(name)) problems.push(`${CODECOV} declares the component "${name}", which is no package this repo measures.`);
}

if (problems.length > 0) {
  console.error('\n✖ the coverage roster disagrees with itself:\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\n  Four lists decide which packages CI measures: the workspaces declaring\n' +
      '  "test:coverage", the package-tests.yml matrix, codecov.yml flags, and\n' +
      '  codecov.yml components. When they disagree the pipeline stays green and the\n' +
      '  package simply vanishes from the coverage everyone reads.\n',
  );
  process.exit(1);
}

console.log(
  `✅ coverage roster: ${measured.length} measured packages agree across the matrix, flags and components ` +
    `(${EXEMPT_FROM_MATRIX.map((e) => e.name).join(', ')} measured by security-tests.yml)`,
);
