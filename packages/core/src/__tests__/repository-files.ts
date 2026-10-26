/**
 * What the source censuses read: the TypeScript files the repository holds,
 * and their text with comments removed.
 *
 * Git says what the repository holds: the files it tracks and the new ones it
 * does not ignore, so the ignore rules decide which directories hold no
 * audited source. The disk also holds whatever this machine has built or
 * installed, so a walk of it gives one verdict here and another in CI.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const TYPESCRIPT = /\.tsx?$/;

const gitListed = (directories: readonly string[], ...flags: string[]): string[] =>
  execFileSync('git', ['ls-files', '-z', ...flags, '--', ...directories], { cwd: REPO, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);

/**
 * The `.ts` and `.tsx` files under `directories`, as paths relative to REPO.
 * Each names a regular file in the working tree: a link is skipped without
 * being followed, so one that dangles never fails the census, and a tracked
 * file deleted on disk is skipped too.
 */
export function typeScriptFiles(...directories: string[]): string[] {
  const listed = new Set([...gitListed(directories, '--cached'), ...gitListed(directories, '--others', '--exclude-standard')]);
  return [...listed]
    .filter((path) => TYPESCRIPT.test(path) && lstatSync(join(REPO, path), { throwIfNoEntry: false })?.isFile())
    .sort();
}

/** `source` without its block and line comments, so prose about a banned shape is not a match. */
export const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
