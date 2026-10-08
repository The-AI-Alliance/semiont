/**
 * The TypeScript worker driver for the worker conformance suite
 * (tests/conformance/worker). The suite starts it, sends it one operation per
 * line on stdin and reads what it did, and what it saw, one line at a time
 * from stdout; tests/conformance/worker/README.md is the protocol.
 *
 * It reaches the worker's surface only as a worker's author does, through
 * what `@semiont/sdk` and `@semiont/core` export: `job.claim`, the claims it
 * returns, and the held jobs they hand out. Node runs this file as it is
 * (types stripped); `npm run typecheck:conformance` is its type check.
 */
import { createInterface } from 'node:readline';
import { BehaviorSubject } from 'rxjs';
import { SemiontError, accessToken, baseUrl, resourceId, type AccessToken, type JobFilter } from '@semiont/core';
import {
  HttpContentTransport,
  HttpTransport,
  JOB_CLAIM_CHANNELS,
  JOB_COMMIT_CHANNELS,
  SemiontClient,
  type ClaimsObservable,
  type HeldJob,
  type HeldMarkJob,
  type HeldYieldJob,
  type JobCheckpoint,
  type JobFailure,
} from '@semiont/sdk';

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

/** The entries of specs/src/client/timing.json this driver can override: the transport's, and a worker's. */
const TRANSPORT_TIMING = ['reconnectMs', 'lazyRemoveMs', 'lingerMs'] as const;
const WORKER_TIMING = ['jobClaimTimeoutMs', 'heldJobStallMs', 'heldJobStallCheckMs', 'markCommitTimeoutMs'] as const;

let transport: HttpTransport | undefined;
let client: SemiontClient | undefined;
let timing: Arguments = {};
let claims: ClaimsObservable | undefined;
/** The job the worker last came to hold, as its claims handed it out. */
let held: HeldJob | undefined;

function opened(): SemiontClient {
  if (!client) throw new Misuse('no transport is open');
  return client;
}

function claiming(): ClaimsObservable {
  if (!claims) throw new Misuse('the worker is not claiming');
  return claims;
}

function holding(): HeldJob {
  if (!held) throw new Misuse('the worker has held no job');
  return held;
}

/** The checkpoint an operation states, when it states one. */
function checkpoint(args: Arguments): Partial<JobCheckpoint> {
  const units = args['completedUnits'];
  if (units !== undefined && (!Array.isArray(units) || !units.every((u): u is string => typeof u === 'string'))) throw new Misuse('completedUnits must be a list of strings');
  return {
    ...(units === undefined ? {} : { completedUnits: units }),
    // A case states a cursor as the wire carries one; the gateway holds it to the schema.
    ...(args['unitCursors'] === undefined ? {} : { unitCursors: object(args, 'unitCursors') as NonNullable<JobCheckpoint['unitCursors']> }),
  };
}

const operations: Record<string, (args: Arguments) => Promise<unknown> | unknown> = {
  open(args) {
    if (transport) throw new Misuse('a transport is already open');
    timing = args['timing'] === undefined ? {} : object(args, 'timing');
    for (const name of Object.keys(timing)) {
      if (![...TRANSPORT_TIMING, ...WORKER_TIMING].some((known) => known === name)) throw new Misuse(`this driver cannot override ${name}`);
    }
    const commits = args['commits'] ?? false;
    if (typeof commits !== 'boolean') throw new Misuse('commits must be a boolean');
    const token$ = new BehaviorSubject<AccessToken | null>(accessToken(text(args, 'token')));
    transport = new HttpTransport({
      baseUrl: baseUrl(text(args, 'baseUrl')),
      token$,
      // What a worker's stream names for its claims, and for its commits when
      // it will make any, and no more: this worker awaits nothing else.
      channels: commits ? [...JOB_CLAIM_CHANNELS, ...JOB_COMMIT_CHANNELS] : JOB_CLAIM_CHANNELS,
      ...(timing['reconnectMs'] === undefined ? {} : { reconnectMs: count(timing, 'reconnectMs') }),
      ...(timing['lazyRemoveMs'] === undefined ? {} : { lazyRemoveMs: count(timing, 'lazyRemoveMs') }),
      ...(timing['lingerMs'] === undefined ? {} : { lingerMs: count(timing, 'lingerMs') }),
    });
    client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
    transport.state$.subscribe((state) => say({ state }));
    transport.errors$.subscribe((error) => say({ error: failure(error) }));
  },

  // A worker that stops: a job it still holds is failed first.
  async close() {
    await claims?.stop();
    opened().dispose();
  },

  'subscribe-resource'(args) {
    opened().transport.subscribeToResource(resourceId(text(args, 'resource')));
  },

  claim(args) {
    if (claims) throw new Misuse('the worker is already claiming');
    const accepts = args['accepts'];
    if (!Array.isArray(accepts)) throw new Misuse('accepts must be a list of filters');
    const worker = opened().job.claim({
      // A case states its filters as the wire carries them; the gateway holds the claim to the schema.
      accepts: accepts as JobFilter[],
      ...(timing['jobClaimTimeoutMs'] === undefined ? {} : { jobClaimTimeoutMs: count(timing, 'jobClaimTimeoutMs') }),
      ...(timing['heldJobStallMs'] === undefined ? {} : { heldJobStallMs: count(timing, 'heldJobStallMs') }),
      ...(timing['heldJobStallCheckMs'] === undefined ? {} : { heldJobStallCheckMs: count(timing, 'heldJobStallCheckMs') }),
      ...(timing['markCommitTimeoutMs'] === undefined ? {} : { markCommitTimeoutMs: count(timing, 'markCommitTimeoutMs') }),
    });
    claims = worker;
    worker.refused$.subscribe((refusal) => say({ refused: { ...(refusal.code === null ? {} : { code: refusal.code }), detail: refusal.message } }));
    worker.stalled$.subscribe((stall) => say({ stalled: stall.jobId }));
    worker.subscribe({
      next: (job) => {
        held = job;
        job.cancelled.addEventListener('abort', () => say({ signalled: job.jobId }), { once: true });
        say({ claimed: { jobId: job.jobId, jobType: job.jobType, resourceId: job.resourceId, params: job.params, completedUnits: job.completedUnits, unitCursors: job.unitCursors, retryCount: job.retryCount, maxRetries: job.maxRetries } });
      },
      error: (error) => say({ error: failure(error) }),
    });
  },

  async start() {
    await holding().start();
  },

  async progress(args) {
    const percentage = count(args, 'percentage');
    // A case states a progress message as the wire carries one.
    const message = args['message'] === undefined ? undefined : (object(args, 'message') as Parameters<HeldJob['progress']>[0]['message']);
    await holding().progress({ percentage, ...(message === undefined ? {} : { message }) });
  },

  async checkpoint(args) {
    const { completedUnits, unitCursors } = checkpoint(args);
    if (completedUnits === undefined) throw new Misuse('a checkpoint states the units finished');
    await holding().checkpoint({ completedUnits, ...(unitCursors === undefined ? {} : { unitCursors }) });
  },

  // The held job commits for itself: it cites its own id, and remembers what
  // the commit observed for its settle.
  async commit(args) {
    const annotations = args['annotations'];
    if (!Array.isArray(annotations)) throw new Misuse('annotations must be a list of annotations');
    // A case states an annotation as the wire carries one; the gateway holds the commit to the schema.
    await holding().commit(resourceId(text(args, 'resourceId')), annotations as Parameters<HeldJob['commit']>[1]);
  },

  // A completion is its verb's, so the verb is narrowed before the result is
  // given. A case states a result as the wire carries one, and the gateway
  // refuses one that is the other verb's.
  async complete(args) {
    const job = holding();
    const result = object(args, 'result');
    if (job.jobType === 'mark') await job.complete(result as Parameters<HeldMarkJob['complete']>[0]);
    else await job.complete(result as Parameters<HeldYieldJob['complete']>[0]);
  },

  async fail(args) {
    const failureClass = args['failureClass'] === undefined ? undefined : text(args, 'failureClass');
    if (failureClass !== undefined && failureClass !== 'transient' && failureClass !== 'deterministic') throw new Misuse('failureClass is transient or deterministic');
    const said: JobFailure = { ...checkpoint(args), ...(failureClass === undefined ? {} : { failureClass }) };
    await holding().fail(text(args, 'error'), said);
  },

  async cancel(args) {
    await holding().cancel(checkpoint(args));
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
// The suite is done with this worker. It ends as a process that is killed
// ends: it says nothing more, of a job it holds or of anything else.
lines.on('close', () => {
  client?.dispose();
  process.exit(0);
});
say({ ready: true });
