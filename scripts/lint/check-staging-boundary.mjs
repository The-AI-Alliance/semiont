#!/usr/bin/env node
/**
 * Git stays replaceable: the code that runs git is the code that implements
 * the staging interface in front of it, and nothing else.
 *
 * The Archivist stages changes where a person can commit them. `Staging`
 * (packages/content/src/staging.ts) names that job; `git-staging.ts` is the
 * one technology behind it. A module that
 * ran git beside it, or handed it git's own arguments, would tie the rest to
 * git, and nothing would say so. So, in production TypeScript and JavaScript:
 *
 *   - `git` is spawned only in the git driver;
 *   - git's arguments (`mv`, `rm`, `--cached`, `rev-parse`) are written only
 *     there;
 *   - no schema in `specs/` gives a caller a `noGit` switch. Whether a project
 *     stages is the project's `[git] sync`, never one command's choice.
 *
 * The same holds in Rust: no crate runs git. The Archivist's staging driver,
 * when it is written in Rust, is the one file that may, and is named here
 * then.
 *
 * A test may run git to set a repository up or to read its index. Each allowed
 * file must still use what it is allowed, so an entry cannot outlive the
 * implementation it was for.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repositoryFiles } from './repository-files.mjs';
import { withoutComments } from './source-text.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const DRIVER = 'packages/content/src/git-staging.ts';

const productionSource = (file) =>
  /^(apps|packages)\/[^/]+\/src\//.test(file) &&
  /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) &&
  !/(^|\/)__tests__\/|\.(test|spec)\.[^/]+$/.test(file);

const rustSource = (file) => /^(apps|packages)\/(?!desktop\/)(?:[^/]+\/)+src\/.*\.rs$/.test(file);

const specSchema = (file) => /^specs\/src\/.*\.json$/.test(file);

const RULES = [
  {
    what: 'a git subprocess',
    scope: productionSource,
    // A call whose first argument is the command name: execFile('git', …),
    // spawn("git", …), or an alias of either.
    uses: /\(\s*['"]git['"]\s*,/,
    allowed: [DRIVER],
  },
  {
    what: "git's own arguments",
    scope: productionSource,
    uses: /['"](?:--cached|rev-parse)['"]|\[\s*['"](?:mv|rm)['"]\s*,/,
    allowed: [DRIVER],
  },
  {
    what: 'a git subprocess',
    scope: rustSource,
    // Command::new("git"), by any path to Command.
    uses: /\bCommand::new\s*\(\s*"git"\s*\)/,
    allowed: [],
  },
  {
    what: 'a git library',
    scope: rustSource,
    uses: /\b(?:git2|gix)::/,
    allowed: [],
  },
  {
    what: 'a `noGit` switch on the wire',
    scope: specSchema,
    uses: /"noGit"\s*:/,
    allowed: [],
  },
];

const tracked = repositoryFiles(ROOT);
const text = new Map();
const source = (file) => {
  if (!text.has(file)) text.set(file, withoutComments(readFileSync(join(ROOT, file), 'utf8')));
  return text.get(file);
};

const problems = [];
for (const rule of RULES) {
  for (const file of tracked) {
    if (!rule.scope(file) || rule.allowed.includes(file)) continue;
    if (rule.uses.test(source(file))) problems.push(`${file} uses ${rule.what}, which ${rule.allowed.length > 0 ? `only ${rule.allowed.join(' and ')} may` : 'nothing may'}`);
  }
  for (const file of rule.allowed) {
    if (!tracked.includes(file)) problems.push(`${file} is allowed ${rule.what}, and is gone`);
    else if (!rule.uses.test(source(file))) problems.push(`${file} is allowed ${rule.what}, and no longer uses it: drop it from the rule`);
  }
}

if (problems.length > 0) {
  console.error('✗ lint:staging-boundary — git is reached around its interface:');
  for (const p of problems) console.error(`    ${p}`);
  console.error('  Stage, move and remove through Staging (packages/content/src/staging.ts).');
  process.exit(1);
}
console.log('✓ lint:staging-boundary — git is run, and spoken to in its own arguments, only in the git staging driver, and no schema carries a noGit switch');
