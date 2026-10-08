/**
 * The TypeScript worker driver for the worker conformance suite
 * (tests/conformance/worker). The suite starts it, sends it one operation per
 * line on stdin and reads what it did, and what it saw, one line at a time
 * from stdout; tests/conformance/worker/README.md is the protocol.
 *
 * It reaches the worker's surface only as a worker's author does, through what
 * `@semiont/jobs`, `@semiont/http-transport` and `@semiont/core` export. Node
 * runs this file as it is (types stripped); `npm run typecheck:conformance` is
 * its type check.
 *
 * The claim loop, the claimed record, the vitals, the stall rule and
 * `willRetry` are `@semiont/jobs`'s. The lifecycle a held job emits is
 * composed here, from the transport's `emit` and the adapter's `completeJob`
 * and `failJob`, as docs/builder/skills/semiont-worker teaches: the package has
 * no held job that emits and releases in one call. Until it has, the cases of
 * the lifecycle hold this composition and not the package.
 */
import { createInterface } from 'node:readline';
import { BehaviorSubject } from 'rxjs';
import {
  SemiontError,
  accessToken,
  baseUrl,
  replyChannelsFor,
  resourceId,
  type AccessToken,
  type EventMap,
  type JobFilter,
  type Logger,
} from '@semiont/core';
import { HttpTransport } from '@semiont/http-transport';
import { WORKER_CONSUMED_BROADCASTS, createJobClaimAdapter, startStallWatchdog, willRetryAfter, type ActiveJob, type JobClaimAdapter } from '@semiont/jobs';

type Arguments = Record<string, unknown>;

/** The suite sent something this driver cannot act on: the suite's mistake, never the worker's. */
class Misuse extends Error {}

const say = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

function text(args: Arguments, name: string): string {
  const value = args[name];
  if (typeof value !== 'string') throw new Misuse(`${name} must be a string`);
  return value;
}

function count(args: Arguments, name: string): number {
  const value = args[name];
  if (typeof value !== 'number') throw new Misuse(`${name} must be a number`);
  return value;
}

function object(args: Arguments, name: string): Arguments {
  const value = args[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Misuse(`${name} must be an object`);
  return value as Arguments;
}

/** A failure as the protocol carries it: the SDK's code, and the status when a server stated one. */
function failure(error: unknown): { code?: string; status?: number; detail: string } {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (!(error instanceof SemiontError)) return { detail };
  const status = (error as { status?: unknown }).status;
  return { code: error.code, ...(typeof status === 'number' && status > 0 ? { status } : {}), detail };
}

/** What a worker's stream names: the replies of its claim, and the two broadcasts it reads. */
const CHANNELS: (keyof EventMap)[] = [...replyChannelsFor(['job:claim']), ...WORKER_CONSUMED_BROADCASTS];

/** The entries of specs/src/client/timing.json this driver can override. */
const TRANSPORT_TIMING = ['reconnectMs', 'lazyRemoveMs', 'lingerMs'] as const;
const WORKER_TIMING = ['jobClaimTimeoutMs', 'heldJobStallMs', 'heldJobStallCheckMs'] as const;

const toStderr = (level: string) => (message: string, meta?: unknown): void => {
  process.stderr.write(`${level} ${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}\n`);
};
const logger: Logger = { debug: toStderr('debug'), info: toStderr('info'), warn: toStderr('warn'), error: toStderr('error'), child: () => logger };

let transport: HttpTransport | undefined;
let timing: Arguments = {};
let adapter: JobClaimAdapter | undefined;
let watchdog: { dispose(): void } | undefined;
/** The job the worker holds, as the adapter reported it. */
let held: ActiveJob | null = null;

function opened(): HttpTransport {
  if (!transport) throw new Misuse('no transport is open');
  return transport;
}

function claiming(): JobClaimAdapter {
  if (!adapter) throw new Misuse('the worker is not claiming');
  return adapter;
}

function holding(): ActiveJob {
  if (!held) throw new Misuse('the worker holds no job');
  return held;
}

/** What every lifecycle message of the held job carries. */
const identity = (job: ActiveJob) => ({ resourceId: job.resourceId, jobId: job.jobId, jobType: job.type, attempt: job.retryCount + 1 });

/** The checkpoint an operation states, when it states one. */
function checkpoint(args: Arguments): { completedUnits?: string[]; unitCursors?: ActiveJob['unitCursors'] } {
  const units = args['completedUnits'];
  if (units !== undefined && (!Array.isArray(units) || !units.every((u): u is string => typeof u === 'string'))) throw new Misuse('completedUnits must be a list of strings');
  return {
    ...(units === undefined ? {} : { completedUnits: units }),
    ...(args['unitCursors'] === undefined ? {} : { unitCursors: object(args, 'unitCursors') as ActiveJob['unitCursors'] }),
  };
}

const operations: Record<string, (args: Arguments) => Promise<unknown> | unknown> = {
  open(args) {
    if (transport) throw new Misuse('a transport is already open');
    timing = args['timing'] === undefined ? {} : object(args, 'timing');
    for (const name of Object.keys(timing)) {
      if (![...TRANSPORT_TIMING, ...WORKER_TIMING].some((known) => known === name)) throw new Misuse(`this driver cannot override ${name}`);
    }
    const token$ = new BehaviorSubject<AccessToken | null>(accessToken(text(args, 'token')));
    transport = new HttpTransport({
      baseUrl: baseUrl(text(args, 'baseUrl')),
      token$,
      channels: CHANNELS,
      ...(timing['reconnectMs'] === undefined ? {} : { reconnectMs: count(timing, 'reconnectMs') }),
      ...(timing['lazyRemoveMs'] === undefined ? {} : { lazyRemoveMs: count(timing, 'lazyRemoveMs') }),
      ...(timing['lingerMs'] === undefined ? {} : { lingerMs: count(timing, 'lingerMs') }),
    });
    transport.state$.subscribe((state) => say({ state }));
    transport.errors$.subscribe((error) => say({ error: failure(error) }));
  },

  close() {
    watchdog?.dispose();
    adapter?.dispose();
    opened().dispose();
  },

  'subscribe-resource'(args) {
    opened().subscribeToResource(resourceId(text(args, 'resource')));
  },

  claim(args) {
    if (adapter) throw new Misuse('the worker is already claiming');
    const accepts = args['accepts'];
    if (!Array.isArray(accepts)) throw new Misuse('accepts must be a list of filters');
    const bus = opened();
    const worker = createJobClaimAdapter({
      bus,
      accepts: accepts as JobFilter[],
      ...(timing['jobClaimTimeoutMs'] === undefined ? {} : { jobClaimTimeoutMs: count(timing, 'jobClaimTimeoutMs') }),
    });
    adapter = worker;
    worker.activeJob$.subscribe((job) => {
      held = job;
      if (job === null) return;
      say({ claimed: { jobId: job.jobId, jobType: job.type, resourceId: job.resourceId, params: job.params, completedUnits: job.completedUnits, unitCursors: job.unitCursors, retryCount: job.retryCount, maxRetries: job.maxRetries } });
    });
    worker.refused$.subscribe((refusal) => say({ refused: { ...(refusal.code === null ? {} : { code: refusal.code }), detail: refusal.message } }));
    // A cancellation is the held job's only when it names it.
    bus.stream('job:cancel-requested').subscribe((request) => {
      if (held !== null && request.jobId === held.jobId) say({ signalled: held.jobId });
    });
    watchdog = startStallWatchdog({
      workers: [{ vitals: () => ({ ...worker.vitals(), provider: 'conformance', model: 'driver', did: '', serves: accepts as JobFilter[] }) }],
      logger,
      exit: () => say({ stalled: worker.vitals().activeJob?.jobId ?? null }),
      ...(timing['heldJobStallMs'] === undefined ? {} : { heldJobStallMs: count(timing, 'heldJobStallMs') }),
      ...(timing['heldJobStallCheckMs'] === undefined ? {} : { heldJobStallCheckMs: count(timing, 'heldJobStallCheckMs') }),
    });
    worker.start();
  },

  async start() {
    await opened().emit('job:start', identity(holding()));
  },

  async progress(args) {
    const job = holding();
    const percentage = count(args, 'percentage');
    claiming().touchActivity();
    await opened().emit('job:report-progress', { ...identity(job), percentage, progress: { percentage, ...(args['message'] === undefined ? {} : { message: object(args, 'message') }) } } as EventMap['job:report-progress']);
  },

  async checkpoint(args) {
    const job = holding();
    await opened().emit('job:checkpoint', { jobId: job.jobId, ...checkpoint(args) } as EventMap['job:checkpoint']);
  },

  async complete(args) {
    const job = holding();
    await opened().emit('job:complete', { ...identity(job), ...(args['result'] === undefined ? {} : { result: object(args, 'result') }) } as EventMap['job:complete']);
    claiming().completeJob();
  },

  async fail(args) {
    const job = holding();
    const error = text(args, 'error');
    const failureClass = args['failureClass'] === undefined ? undefined : text(args, 'failureClass');
    if (failureClass !== undefined && failureClass !== 'transient' && failureClass !== 'deterministic') throw new Misuse('failureClass is transient or deterministic');
    await opened().emit('job:fail', {
      ...identity(job),
      error,
      ...checkpoint(args),
      ...(failureClass === undefined ? {} : { failureClass }),
      willRetry: willRetryAfter(job, failureClass),
    });
    claiming().failJob(job.jobId, error);
  },

  async cancel(args) {
    const job = holding();
    const { completedUnits } = checkpoint(args);
    await opened().emit('job:cancel', { resourceId: job.resourceId, jobId: job.jobId, jobType: job.type, ...(completedUnits === undefined ? {} : { completedUnits }) });
    claiming().completeJob();
  },

  vitals() {
    return claiming().vitals();
  },

  // Answers after everything the worker reported before it.
  sync() {},
};

async function run(line: string): Promise<void> {
  const { id, op, ...args } = JSON.parse(line) as { id: number; op: string } & Arguments;
  const operation = operations[op];
  if (!operation) {
    say({ id, unsupported: true });
    return;
  }
  try {
    const value: unknown = await operation(args);
    say({ id, ok: value === undefined ? null : value });
  } catch (error) {
    if (error instanceof Misuse) say({ id, misuse: error.message });
    else say({ id, error: failure(error) });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => void run(line));
lines.on('close', () => {
  watchdog?.dispose();
  adapter?.dispose();
  transport?.dispose();
  process.exit(0);
});
say({ ready: true });
