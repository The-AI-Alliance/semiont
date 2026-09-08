/**
 * Deferred, deduped `git add`. The index is for humans who commit by hand, so
 * it must be current within seconds, not after every change.
 *
 * Serialized per repo — git's index is single-writer, and concurrent `git add`
 * fails on `index.lock` rather than retrying. Created on first use, never at
 * import: consumers of this package may never stage anything.
 */

import { execFile } from 'child_process';
import { resolve } from 'path';
import { promisify } from 'util';
import { recordGitCommand, recordGitStagingFailure } from '@semiont/observability';

const run = promisify(execFile);

export interface StagerOptions {
  /** Quiet period after the last change before staging. */
  flushMs?: number;
  /** Ceiling on staleness: stage this long after the OLDEST pending path even
   *  if changes keep arriving. Without it a continuous append stream resets
   *  the debounce forever and the index never updates. */
  maxWaitMs?: number;
}

export interface Stager {
  /** Queue a path. Returns immediately; deduped against what is pending. */
  add(path: string): void;
  /** Run an order-sensitive command (`mv`, `rm`): pending adds flush first,
   *  then this runs alone — it must not overtake the adds it depends on. */
  run(args: string[]): Promise<void>;
  /** Stage everything pending now. */
  flush(): Promise<void>;
  /** Paths queued and not yet staged. */
  pending(): number;
  /** Drain and stop. A stopped process must leave nothing unstaged. */
  dispose(): Promise<void>;
}

/**
 * git exposes NO index-lock wait — `core.filesRefLockTimeout` and friends cover
 * refs, packed-refs, reftable and credentials, not the index — and `git add`
 * against a held lock fails in ~21 ms. So the wait is ours. Measured
 * 2026-09-08: this schedule absorbed an 800 ms external hold on attempt 5, at
 * 0.85 s of a ~3.15 s budget.
 */
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** ONLY the lock race is retried; a bad pathspec or a broken repo fails fast. */
const isIndexLockContention = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 128 &&
  String((error as { stderr?: unknown }).stderr ?? '').includes('index.lock');

const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_WAIT_MS = 2_000;

/**
 * One Stager per repo, keyed by resolved path.
 *
 * git's index is single-writer, and this module serializes per INSTANCE. Two
 * instances on one repo — the content store and the event log each built their
 * own — each believed it was the only writer and raced the other into
 * `index.lock`, killing the Archivist (ARCHIVIST-GIT-STAGER-CRASH).
 *
 * The FIRST caller's options win. A later caller cannot silently re-tune a
 * shared stager's debounce out from under the first.
 */
const stagers = new Map<string, Stager>();

export function createStager(cwd: string, options: StagerOptions = {}): Stager {
  const key = resolve(cwd);
  const existing = stagers.get(key);
  if (existing) return existing;
  const stager = buildStager(key, options);
  stagers.set(key, stager);
  return stager;
}

function buildStager(cwd: string, options: StagerOptions = {}): Stager {
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

  /** Serialize every invocation: one git per repo, no `index.lock` contention. */
  const serialize = (work: () => Promise<void>): Promise<void> => {
    inFlight = inFlight.then(work, work);
    return inFlight;
  };

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
        // permanently missing from the index — a quieter failure than the
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
        // failure is DEGRADED, not down. Rejecting here is what killed the
        // Archivist, and it would keep killing it through any caller that
        // forgot a `.catch` — so the guarantee lives at this boundary rather
        // than in every caller's discipline.
        recordGitStagingFailure(lock ? 'index-lock' : 'other');
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

  return {
    add(path) {
      if (disposed) return;
      if (queued.size === 0) oldestAt = Date.now();
      queued.add(path);
      arm();
    },
    run(args) {
      return drain().then(() =>
        serialize(() =>
          git(args).catch((error: unknown) => {
            recordGitStagingFailure(isIndexLockContention(error) ? 'index-lock' : 'other');
          }),
        ),
      );
    },
    flush() {
      return drain();
    },
    pending() {
      return queued.size;
    },
    async dispose() {
      stagers.delete(cwd);
      await drain();
      disposed = true;
      clearTimer();
      await inFlight;
    },
  };
}
