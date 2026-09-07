/**
 * Staging the working tree for a human, off the event loop.
 *
 * **Who the index is for.** The Archivist stages; operators commit, branch and
 * merge by hand. Nothing in the codebase runs `git commit` or reads the index
 * — so the requirement is *"current within seconds whenever someone looks"*,
 * not *"current synchronously after every change"*. Those two readings differ
 * by three orders of magnitude in work done, and the code had been written to
 * the second.
 *
 * **What it replaces.** Every appended event ran `execFileSync('git', ['add',
 * …])`. Synchronous, so the duration was not latency on the append — it was
 * time this process could serve nothing else, and the Archivist answers every
 * `browse:*` read and (post SINGLE-KB-MOUNT) every content read. A detection
 * job appending 1,400 annotations to ONE resource spawned 1,400 blocking
 * subprocesses to stage ONE path.
 *
 * **Two properties, and the second is the larger win.** Deduping by path turns
 * those 1,400 invocations into one; going async keeps the loop free while it
 * runs. Async alone would have kept all 1,400.
 *
 * **Serialized, because git's index is single-writer.** Concurrent `git add`
 * contends on `index.lock`, which fails rather than retries — so one worker,
 * one invocation at a time, per repository.
 *
 * **Lazy by construction.** Nothing starts at import: no timer, no worker, no
 * subprocess until something is actually staged. `@semiont/jobs` imports this
 * package for `EXTRACTORS` alone and runs where there is no KB mount and no
 * git; it must carry no live machinery.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { recordGitCommand } from '@semiont/observability';

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

const DEFAULT_FLUSH_MS = 250;
const DEFAULT_MAX_WAIT_MS = 2_000;

export function createStager(cwd: string, options: StagerOptions = {}): Stager {
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
      await run('git', args, { cwd });
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
    return serialize(() => git(['add', ...batch]));
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
      return drain().then(() => serialize(() => git(args)));
    },
    flush() {
      return drain();
    },
    pending() {
      return queued.size;
    },
    async dispose() {
      await drain();
      disposed = true;
      clearTimer();
      await inFlight;
    },
  };
}
