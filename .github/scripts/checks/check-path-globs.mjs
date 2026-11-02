/**
 * lint:path-globs — every glob over apps/, images/ or packages/ that the
 * repository's own files write matches what the tree holds.
 *
 * A glob that matches nothing selects nothing, and nothing says so: a path
 * filter that never fires, a cache key that never moves, a census that counts
 * fewer packages than there are, a release step that bumps fewer versions. A
 * directory that moves, or a naming convention that changes, leaves exactly
 * these behind. So every such glob a workflow, a script, a test or a manifest
 * writes is held to the tree: it matches a file the repository holds or a
 * directory of one, or it names what a build makes beneath directories it
 * does match, which git ignores (node_modules under each app).
 *
 * What it cannot see: a glob that still matches part of what it should after
 * the rest has moved, and a glob assembled from parts (a filepath.Join, a
 * Python path's `/`) rather than written out.
 *
 * WHAT THE REPOSITORY HOLDS is what git says it does (repository-files.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ignoredByGit, repositoryFiles } from './repository-files.mjs';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** This file writes the globs it explains. */
const SELF = '.github/scripts/checks/check-path-globs.mjs';

/** Prose, lockfiles, and the ignore rules, whose globs name what the tree does not keep. */
const NOT_TOOLING = [/\.md$/, /(^|\/)(package-lock\.json|Cargo\.lock|uv\.lock|go\.sum)$/, /(^|\/)\.gitignore$/];

/**
 * A glob over the three trees as a file writes it: bare, after `./`, after a
 * root variable (`$REPO_ROOT/`, `"$ROOT"/`), or after git's `:(glob)`. A token
 * with `$`, `{` or `\` in it is assembled or escaped, not written out.
 */
const GLOB = /(?:^|[^\w./-])(?:\$\{?\w+\}?\/|"\$\{?\w+\}?"\/|:\(glob\)|\.\/)?((?:apps|images|packages)\/[^\s'"`,;:()[\]{}<>|\\$]*\*[^\s'"`,;:()[\]{}<>|\\$]*)/g;

function toRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        out += '(?:[^/]+/)*';
      } else {
        out += '.*';
      }
    } else if (c === '*') {
      out += '[^/]*';
    } else {
      out += c.replace(/[.+?^$()|[\]\\{}]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

const tree = repositoryFiles(ROOT).filter((file) => !file.split('/').includes('node_modules'));
const directories = new Set();
for (const file of tree) {
  for (let i = file.indexOf('/'); i !== -1; i = file.indexOf('/', i + 1)) directories.add(file.slice(0, i));
}
const paths = [...tree, ...directories];

/**
 * What a build makes beneath directories the glob reaches: the longest head of
 * it that matches directories the tree holds, and below one of them, the rest
 * with each wildcard given a name, is a path git ignores. So
 * apps/launcher/dist/ with an archive glob after it names goreleaser's
 * output, and a glob whose head matches nothing names nothing.
 */
function namesBuildOutput(glob) {
  const parts = glob.split('/');
  for (let k = parts.length - 1; k > 0; k--) {
    const head = toRegExp(parts.slice(0, k).join('/'));
    const reached = [...directories].filter((directory) => head.test(directory));
    if (reached.length === 0) continue;
    const rest = parts.slice(k).filter((part) => part !== '**').map((part) => part.replaceAll('*', 'x')).join('/');
    return rest !== '' && reached.some((directory) => ignoredByGit(ROOT, `${directory}/${rest}`));
  }
  return false;
}

const verdicts = new Map();
function holds(glob) {
  if (!verdicts.has(glob)) {
    const pattern = toRegExp(glob);
    verdicts.set(glob, paths.some((path) => pattern.test(path)) || namesBuildOutput(glob));
  }
  return verdicts.get(glob);
}

const failures = [];
let written = 0;
const writers = new Set();
for (const file of tree) {
  if (file === SELF || NOT_TOOLING.some((pattern) => pattern.test(file))) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, file), 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\0')) continue;
  text.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(GLOB)) {
      const glob = match[1].replace(/[.]+$/, '').replace(/\/+$/, '');
      written++;
      writers.add(file);
      if (!holds(glob)) failures.push(`${file}:${index + 1}: ${glob}`);
    }
  });
}

if (failures.length > 0) {
  console.error(`\n✖ lint:path-globs — ${failures.length} glob(s) over apps/, images/ or packages/ match nothing the tree holds:\n`);
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(
    '\n  A glob that matches nothing selects nothing, silently. Write it for the tree as it is:\n' +
      '  a directory that moved takes its globs with it, and a convention that changed\n' +
      '  (a name suffix, a depth) changes every glob that spelled it.\n',
  );
  process.exit(1);
}
console.log(`✅ lint:path-globs — ${written} globs over apps/, images/ and packages/ in ${writers.size} files, each matching what the tree holds`);
