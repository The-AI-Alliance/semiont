import { execFileSync } from 'node:child_process';

/**
 * The repository's files as the working tree holds them: every file git
 * tracks and has not seen deleted, and every new one it does not ignore,
 * relative to `root`. On a clean checkout — CI's — it is `git ls-files`
 * exactly; before a change is staged it is still the change, so a lint run
 * then judges the tree it will be committed as.
 */
export function repositoryFiles(root) {
  const list = (...args) => execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const deleted = new Set(list('--deleted'));
  return [...new Set([...list('--cached'), ...list('--others', '--exclude-standard')])].filter((file) => !deleted.has(file)).sort();
}
