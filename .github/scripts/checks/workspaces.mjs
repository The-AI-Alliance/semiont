import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryFiles } from './repository-files.mjs';

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The repository's npm workspaces: each directory, relative to `root`, that an
 * entry of the root package.json's `workspaces` names and that holds a
 * package.json the repository holds, in the order the entries list them.
 *
 * Git says which package.json files there are (`repository-files.mjs`), so a
 * package added and not yet committed counts, and a directory a build left
 * behind does not. Nothing is installed or run: `npm query .workspace` reads
 * the installed tree, where a package added but not yet installed is missing,
 * and that is the moment the coverage gates exist to catch.
 *
 * An entry is a directory, or a pattern whose `*` stands for any run of
 * characters within one path segment. Any other glob syntax is refused.
 */
export function workspaceDirectories(root) {
  const manifest = join(root, 'package.json');
  const entries = JSON.parse(readFileSync(manifest, 'utf8')).workspaces;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${manifest} declares no workspaces`);
  const packages = repositoryFiles(root)
    .filter((file) => file.endsWith('/package.json'))
    .map((file) => file.slice(0, -'/package.json'.length));
  return entries.flatMap((entry) => {
    if (/\*\*|[?[\]{}!]/.test(entry)) throw new Error(`${manifest}: the workspace entry "${entry}" uses glob syntax this reader does not expand`);
    const named = new RegExp(`^${entry.split('*').map(escaped).join('[^/]*')}$`);
    return packages.filter((dir) => named.test(dir));
  });
}
