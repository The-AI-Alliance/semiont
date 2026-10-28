/**
 * git, run by hand in a knowledge base's working tree, the way a person at its
 * terminal runs it, beside an Archivist that stages into the same index.
 */
import { execFileSync } from 'node:child_process';
import { eventually } from './net';

/** How long one git command may hold the index: far longer than a batch of staging takes. */
const INDEX_HELD_AT_MOST_MS = 10_000;

/**
 * The person running git: a name to commit under, which a runner has none of,
 * and no key, so a commit is not signed whatever the machine's own git says.
 */
const PERSON = ['-c', 'user.name=Conformance', '-c', 'user.email=conformance@example.com', '-c', 'commit.gpgsign=false'];

/**
 * Run git in `root` and return what it printed. While the Archivist stages a
 * batch it holds git's lock on the index, and a command that finds the index
 * locked is run again once the lock is gone, as the Archivist runs its own
 * (ARCHIVIST.md § Staging). Any other failure is thrown at once.
 */
export function gitByHand(root: string, ...args: string[]): Promise<string> {
  return eventually('git to find the index unlocked', INDEX_HELD_AT_MOST_MS, () => {
    try {
      return execFileSync('git', [...PERSON, ...args], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (refused) {
      if (foundTheIndexLocked(refused)) return undefined;
      throw refused;
    }
  });
}

const foundTheIndexLocked = (refused: unknown): boolean =>
  refused instanceof Error && 'stderr' in refused && typeof refused.stderr === 'string' && refused.stderr.includes("index.lock': File exists");
