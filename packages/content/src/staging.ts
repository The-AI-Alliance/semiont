/**
 * Staging: recording the working tree's changes where a person can commit
 * them. The interface names the job; `git-staging.ts` is the one technology
 * behind it, and `noStaging` is a project that does not sync git.
 */

import { promises as fs } from 'fs';
import { isObject, type Logger } from '@semiont/core';
import type { SemiontProject } from '@semiont/core/node';
import { gitStaging } from './git-staging.js';

export interface StagingOptions {
  /** Quiet period after the last change before staging. */
  flushMs?: number;
  /** Ceiling on staleness: stage this long after the OLDEST pending path even
   *  if changes keep arriving. Without it a continuous append stream resets
   *  the debounce forever and nothing is ever staged. */
  maxWaitMs?: number;
  /** Where a batch that could not be staged is reported, for the operator. */
  logger?: Logger;
}

export interface Staging {
  /** Rejects where this driver cannot do its job. A process awaits it before it serves. */
  ready(): Promise<void>;
  /** The path's current state will be staged within the staleness bound. Returns at once: the
   *  staging is queued, so a failure is logged as a degradation, never returned to this caller. */
  stage(path: string): void;
  /** Rename the file; what is staged follows it. Runs after everything staged before it.
   *  Rejects if the rename fails, or if it happened and could not be staged. */
  move(from: string, to: string): Promise<void>;
  /** Unstage the path, and delete the file unless `keepFile`. An absent file is not an error.
   *  Rejects if the delete fails, or if it happened and could not be unstaged. */
  remove(path: string, options: { keepFile: boolean }): Promise<void>;
  /** The branch the tree is on. None for a project that does not sync git — it runs no git at
   *  all — and none where the tree is not a git checkout. */
  currentBranch(): Promise<string | undefined>;
  /** Everything staged so far is where a person can commit it. */
  flush(): Promise<void>;
  /** Drain and stop. A stopped process must leave nothing unstaged. */
  dispose(): Promise<void>;
}

/** A project that does not sync git still moves and removes its own files, and never runs git. */
export const noStaging: Staging = {
  ready: () => Promise.resolve(),
  stage() {},
  currentBranch: () => Promise.resolve(undefined),
  move: (from, to) => fs.rename(from, to),
  async remove(path, { keepFile }) {
    if (keepFile) return;
    try {
      await fs.unlink(path);
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error;
    }
  },
  flush: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
};

/** The one driver for a project's repository — every store that stages there shares it. */
export function stagingFor(project: Pick<SemiontProject, 'root' | 'gitSync'>, options: StagingOptions = {}): Staging {
  return project.gitSync ? gitStaging(project.root, options) : noStaging;
}
