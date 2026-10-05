/**
 * Staging with git — the one file that runs it. Deferred, deduped `git add`:
 * the index is for humans who commit by hand, so it must be current within
 * seconds, not after every change.
 *
 * Files are moved and deleted HERE, and git is told afterwards. Asking git to
 * do the file operation makes it depend on git's view of the file: `git rm`
 * refuses one that is staged but not yet committed, `git mv` an untracked one.
 * A file operation happens or throws; only the staging is best-effort.
 *
 * A knowledge base need not be a git repository — that is `noStaging`. This
 * driver is for a config that says `[git] sync = true`, and it refuses a tree
 * git cannot stage into: `ready()` rejects at boot. Past boot it pays for no
 * check. A move or a remove tells git itself, so it reports git's refusal; a
 * stage is queued behind its caller, so a batch that fails is logged as a
 * degradation and counted, and the caller has already succeeded.
 *
 * Serialized per repo — git's index is single-writer, and concurrent `git add`
 * fails on `index.lock` rather than retrying. Created on first use, never at
 * import: consumers of this package may never stage anything.
 */

import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { promisify } from 'util';
import { isObject } from '@semiont/core';
import { recordGitCommand, recordGitStagingFailure } from '@semiont/observability';
import type { Staging, StagingOptions } from './staging.js';

const run = promisify(execFile);

export interface GitStaging extends Staging {
  /** Paths queued and not yet staged — deduped, so many changes to one file count once. */
  pending(): number;
}

/**
 * git exposes NO index-lock wait — `core.filesRefLockTimeout` and friends cover
 * refs, packed-refs, reftable and credentials, not the index — and `git add`
 * against a held lock fails in ~21 ms. So the wait is ours: this schedule
 * absorbs an 800 ms external hold on attempt 5, at 0.85 s of a ~3.15 s
 * budget.
 */
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** ONLY the lock race is retried; a bad pathspec or a broken repo fails fast. */
const isIndexLockContention = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 128 &&
  String((error as { stderr?: unknown }).stderr ?? '').includes('index.lock');

/** Why git can never stage here, or nothing if the failure is not of that kind. */
const cannotStage = (error: unknown): string | undefined => {
  if (!isObject(error)) return undefined;
  if (error.code === 'ENOENT') return 'git could not be run';
  if (error.code === 128 && /not a git repository/i.test(String(error.stderr ?? ''))) return 'git finds no repository there';
  return undefined;
};

const refusal = (cwd: string, why: string): Error =>
  new Error(
    `The knowledge base's config says [git] sync = true, and ${cwd} is not a git checkout (${why}). ` +
    'Make it one (git init), or set sync = false.',
  );

const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_WAIT_MS = 2_000;

/**
 * One driver per repo, keyed by resolved path.
 *
 * git's index is single-writer, and this module serializes per INSTANCE. Two
 * instances on one repo — the content store and the event log each ask for
 * one — would each believe it is the only writer and race the other into
 * `index.lock`.
 *
 * The FIRST caller's options win. A later caller cannot silently re-tune a
 * shared driver's debounce out from under the first.
 */
const drivers = new Map<string, GitStaging>();

export function gitStaging(cwd: string, options: StagingOptions = {}): GitStaging {
  const key = resolve(cwd);
  const existing = drivers.get(key);
  if (existing) return existing;
  const driver = buildGitStaging(key, options);
  drivers.set(key, driver);
  return driver;
}

function buildGitStaging(cwd: string, options: StagingOptions = {}): GitStaging {
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const queued = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let oldestAt: number | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  let disposed = false;

  const git = async (args: string[]): Promise<void> => {
    const started = performance.now();
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await run('git', args, { cwd });
          return;
        } catch (error) {
          const last = attempt >= LOCK_RETRY_DELAYS_MS.length;
          if (last || !isIndexLockContention(error)) throw error;
          await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAYS_MS[attempt]!));
        }
      }
    } finally {
      recordGitCommand(args[0] ?? 'git', performance.now() - started);
    }
  };

  /**
   * Serialize every invocation: one git per repo, no `index.lock` contention.
   * `inFlight` never rejects — a failed file operation reaches its own caller
   * and no one else's `flush`.
   */
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const result = inFlight.then(work);
    inFlight = result.then(() => undefined, () => undefined);
    return result;
  };

  /** The operator's alert: the record is intact and the index is behind it. */
  const degraded = (error: unknown, paths: number): void => {
    recordGitStagingFailure(isIndexLockContention(error) ? 'index-lock' : 'other');
    options.logger?.error('Staging degraded: changes are recorded and were not staged in git', {
      root: cwd,
      paths,
      error: isObject(error) ? String(error.stderr ?? '').trim() || String(error.message ?? '') : String(error),
    });
  };

  /**
   * Tell git, for an operation that is waiting on it. Never throws; answers
   * the refusal when git cannot stage here at all, which the operation reports.
   */
  const index = (args: string[]): Promise<Error | undefined> =>
    git(args).then(
      () => undefined,
      (error: unknown) => {
        degraded(error, 1);
        const why = cannotStage(error);
        return why ? refusal(cwd, why) : undefined;
      },
    );

  const clearTimer = () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
  };

  const drain = (): Promise<void> => {
    clearTimer();
    if (queued.size === 0) return inFlight;
    const batch = [...queued];
    queued.clear();
    oldestAt = undefined;
    return serialize(() =>
      git(['add', ...batch]).catch((error: unknown) => {
        // `queued` was emptied BEFORE the command ran, so a dropped batch is
        // permanently missing from the index — a quieter failure than a
        // crash and harder to notice. Re-queue it.
        //
        // ONLY for a lock race that outlived the retries. Re-queueing a
        // PERMANENT failure (bad pathspec, broken repo) would re-arm forever,
        // spinning one subprocess per cycle and burying the real error.
        const lock = isIndexLockContention(error);
        if (lock) {
          for (const path of batch) queued.add(path);
          if (oldestAt === undefined) oldestAt = Date.now();
          arm();
        }
        // NEVER rethrow. Staging the index is not in the critical path; a
        // failure is DEGRADED, not down. A rejection here has no handler on
        // the debounced timer path, nor in any caller that forgot a
        // `.catch`, and Node kills the process on one — so the guarantee
        // lives at this boundary rather than in every caller's discipline.
        degraded(error, batch.length);
      }),
    );
  };

  const arm = () => {
    clearTimer();
    if (disposed || queued.size === 0) return;
    // Debounce, but never past the staleness ceiling measured from the OLDEST
    // pending path — a busy stream must not defer staging indefinitely.
    const sinceOldest = oldestAt === undefined ? 0 : Date.now() - oldestAt;
    const wait = Math.max(0, Math.min(flushMs, maxWaitMs - sinceOldest));
    timer = setTimeout(() => { void drain(); }, wait);
    timer.unref?.();
  };

  /** Order-sensitive work: pending adds flush first, then this runs alone —
   *  it must not overtake the adds of the file it moves or removes. */
  const afterPending = (work: () => Promise<void>): Promise<void> =>
    drain().then(() => serialize(work));

  const unstage = (path: string): Promise<Error | undefined> =>
    index(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', path]);

  /** Ask git whether it can work here — once, at boot. Any failure refuses. */
  const ready = async (): Promise<void> => {
    try {
      await git(['rev-parse', '--is-inside-work-tree']);
    } catch (error) {
      const detail = isObject(error) ? String(error.stderr ?? '').trim() || String(error.message ?? '') : String(error);
      throw refusal(cwd, cannotStage(error) ?? detail);
    }
  };

  return {
    ready,
    stage(path) {
      if (disposed) return;
      if (queued.size === 0) oldestAt = Date.now();
      queued.add(path);
      arm();
    },
    move(from, to) {
      return afterPending(async () => {
        await fs.rename(resolve(cwd, from), resolve(cwd, to));
        const refused = (await unstage(from)) ?? (await index(['add', '--', to]));
        if (refused) throw refused;
      });
    },
    remove(path, { keepFile }) {
      return afterPending(async () => {
        if (!keepFile) {
          await fs.unlink(resolve(cwd, path)).catch((error: unknown) => {
            if (!isObject(error) || error.code !== 'ENOENT') throw error;
          });
        }
        const refused = await unstage(path);
        if (refused) throw refused;
      });
    },
    /** Read when asked, never kept: a `git checkout` restarts nothing and emits nothing. */
    async currentBranch() {
      const started = performance.now();
      try {
        const { stdout } = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
        return stdout.trim() || undefined;
      } catch (error) {
        // A checkout with no commit yet has no branch to name: that is none,
        // not a refusal.
        const why = cannotStage(error);
        if (!why) return undefined;
        throw refusal(cwd, why);
      } finally {
        recordGitCommand('rev-parse', performance.now() - started);
      }
    },
    flush() {
      return drain();
    },
    pending() {
      return queued.size;
    },
    async dispose() {
      drivers.delete(cwd);
      await drain();
      disposed = true;
      clearTimer();
      await inFlight;
    },
  };
}
