/**
 * A dispatcher world: a dispatcher process and everything it meets. That is
 * the trusted issuer, which admits the dispatcher's service account; a gateway
 * on the in-process plane, the dispatcher's only route to the bus; a JetStream
 * broker for its queue, fresh for every world, so the clocks a case sets are the
 * ones the broker's objects are made with; and the Archivist's Browser,
 * answering the two vocabulary reads `job:create` makes over the bus.
 *
 * Cases meet the dispatcher as the bus does: as people, workers and sidecars
 * emitting through the gateway and reading replies off their streams. Every
 * frame those streams carry must be what the registry says its channel
 * carries, and a case fails otherwise, whatever it was about.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect } from 'vitest';
import type { components } from '@semiont/core';
import { QUIET_TIMING, startDispatcher, type DispatcherEnvironment, type DispatcherProcess, type DispatcherSettings, type DispatcherTiming } from './dispatcher';
import { startBroker, type Broker, type BrokerOptions } from './nats';
import { eventually, freePort } from './net';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';
import { errorsOf, operationFor, registry, spec } from './spec';
import type { BusFrame, BusStream } from './stream';
import { World } from './world';

/** The dispatcher's service account at the issuer. */
export const DISPATCHER_CLIENT = 'semiont-dispatcher';

/** The four operations the dispatcher answers with a correlated reply. */
export const JOB_OPERATIONS = ['job:create', 'job:claim', 'job:status-requested', 'job:cancel-requested'] as const;
export type JobOperation = (typeof JOB_OPERATIONS)[number];

export type JobType = components['schemas']['JobType'];
export type JobFilter = components['schemas']['JobFilter'];
export type Motivation = components['schemas']['MarkJobParams']['motivation'];
/** A `mark` job's parameters as a case states them: its motivation, and whatever else the case gives it. */
export type MarkParams = { motivation: Motivation } & Record<string, unknown>;
type TagSchema = components['schemas']['TagSchema'];
type UnitCursor = components['schemas']['UnitCursor'];
export type RunningJob = components['schemas']['JobRunning'];
export type JobStatus = components['schemas']['JobStatusResponse'];

/** What the Browser answers the vocabulary reads with. */
export interface Vocabulary {
  entityTypes: string[];
  tagSchemas: TagSchema[];
}

export const VOCABULARY: Vocabulary = {
  entityTypes: ['Person', 'Place'],
  tagSchemas: [
    {
      id: 'irac',
      name: 'IRAC',
      description: 'Issue, rule, application, conclusion',
      domain: 'legal',
      tags: [
        { name: 'Issue', description: 'The question the case turns on', examples: ['Whether the contract was formed'] },
        { name: 'Rule', description: 'The law that governs it', examples: ['An offer must be accepted'] },
      ],
    },
  ],
};

export interface DispatcherWorldOptions {
  /** The clocks the dispatcher runs with, over QUIET_TIMING. */
  timing?: Partial<DispatcherTiming>;
  /** What the Browser answers; `null` runs no Browser, so the Archivist is absent. */
  vocabulary?: Vocabulary | null;
  /** How the queue's broker is started: with credentials, the dispatcher is handed them by name. */
  broker?: BrokerOptions;
  /** More of the dispatcher's environment, over its service account and the broker's credentials. */
  env?: DispatcherEnvironment;
}

/** A claim's filter for `mark` jobs of one motivation. */
export const marks = (motivation: Motivation): JobFilter => ({ jobType: 'mark', params: { motivation } });

/** A claim's filter for `yield` jobs. */
export const YIELDS: JobFilter = { jobType: 'yield' };

/** The motivations a `mark` job has: the ones the spec tells MarkJobParams apart by. */
function markMotivations(): Motivation[] {
  const params = spec().doc['components'] as { schemas: { MarkJobParams: { discriminator: { mapping: Record<string, string> } } } };
  return Object.keys(params.schemas.MarkJobParams.discriminator.mapping) as Motivation[];
}

/** Filters that between them take every job: one per motivation, and `yield`. */
export function everyJob(): JobFilter[] {
  return [...markMotivations().map(marks), YIELDS];
}

/** The filter that takes jobs like `job`: its type, and for a `mark` job its motivation. */
export function filterOf(job: RunningJob): JobFilter {
  return job.metadata.type === 'mark' ? marks((job.params as unknown as { motivation: Motivation }).motivation) : YIELDS;
}

/** A reply to a correlated request. */
export interface Answer {
  ok: boolean;
  channel: string;
  payload: Record<string, unknown>;
}

/** Whatever carries a job's identity on a worker's signals. */
export interface JobRef {
  jobId: string;
  jobType: string;
  resourceId: string;
}

/** Holds every frame a stream carries to its channel's schema in the registry. */
function holdToRegistry(stream: BusStream): void {
  stream.on((message) => {
    const frame = message.frame;
    if (!frame) return;
    const channel = registry().channels.find((c) => c.channel === frame.channel);
    if (!channel) {
      stream.violations.push(`a frame on ${frame.channel}, which the registry does not declare`);
      return;
    }
    if (channel.shape !== 'schema' || channel.schema === undefined) return;
    // The gateway's stamps (EVENT-BUS.md) are the bus's, not the payload's.
    const payload = Object.fromEntries(Object.entries(frame.payload).filter(([key]) => !key.startsWith('_')));
    const validate = spec().component(channel.schema);
    if (!validate(payload)) {
      stream.violations.push(`${frame.channel} carried a payload that is not a ${channel.schema} (${errorsOf(validate)}): ${JSON.stringify(frame.payload).slice(0, 400)}`);
    }
  });
}

/**
 * A participant on the bus: a person, a worker or a sidecar, subscribed to the
 * replies of the dispatcher's four operations under its own client id, and to
 * any channel it names.
 */
export class BusClient {
  constructor(
    private readonly world: DispatcherWorld,
    readonly token: string,
    readonly did: string,
    readonly clientId: string,
    readonly stream: BusStream,
  ) {}

  /** Emit `operation` with a fresh correlationId and read its one reply. */
  async request(operation: JobOperation, payload: Record<string, unknown>, timeoutMs = 10_000): Promise<Answer> {
    const { result, failure } = operationFor(operation);
    const correlationId = randomUUID();
    const from = this.stream.messages.length;
    await this.emit(operation, payload, correlationId);
    const message = await this.stream.next(
      `a reply to ${operation}`,
      (m) => m.frame?.correlationId === correlationId && (m.frame.channel === result || m.frame.channel === failure),
      timeoutMs,
      from,
    );
    const frame = message.frame!;
    return { ok: frame.channel === result, channel: frame.channel, payload: frame.payload };
  }

  /** Emit a frame, uncorrelated unless given a correlationId; the gateway must accept it. */
  async emit(channel: string, payload: Record<string, unknown>, correlationId?: string): Promise<void> {
    const reply = await this.world.world.emit(this.token, {
      channel,
      payload,
      ...(correlationId ? { correlationId, clientId: this.clientId } : {}),
    });
    if (reply.status !== 202) throw new Error(`the gateway refused ${channel}: ${reply.status} ${reply.text}`);
  }

  /**
   * Emit a frame and answer what the gateway said of it at its door: `202`
   * when it took the frame, and its refusal when the payload is not what the
   * channel's schema states.
   */
  async offered(channel: string, payload: Record<string, unknown>): Promise<{ status: number; text: string }> {
    const reply = await this.world.world.emit(this.token, { channel, payload });
    return { status: reply.status, text: reply.text };
  }

  /**
   * Create a job: a `mark` job names its resource and, in `params`, its
   * motivation; a `yield` job names its context. The world keeps the id of a
   * job that was admitted, to cancel it once its case is over.
   */
  async create(jobType: JobType, params: Record<string, unknown>, resourceId?: string): Promise<Answer> {
    const answer = await this.request('job:create', { jobType, params, ...(resourceId === undefined ? {} : { resourceId }) });
    if (answer.ok) this.world.unfinished.add((answer.payload['response'] as { jobId: string }).jobId);
    return answer;
  }

  /** Create a job the dispatcher must admit, and answer its id. */
  async created(jobType: JobType, params: Record<string, unknown>, resourceId?: string): Promise<string> {
    const answer = await this.create(jobType, params, resourceId);
    if (!answer.ok) throw new Error(`job:create was refused: ${JSON.stringify(answer.payload)}`);
    return (answer.payload['response'] as { jobId: string }).jobId;
  }

  claim(accepts: JobFilter[]): Promise<Answer> {
    return this.request('job:claim', { accepts });
  }

  /** Claim a job the dispatcher must hand over, and answer it. */
  async claimed(accepts: JobFilter[]): Promise<RunningJob> {
    const answer = await this.claim(accepts);
    if (!answer.ok) throw new Error(`job:claim was refused: ${JSON.stringify(answer.payload)}`);
    return answer.payload['response'] as RunningJob;
  }

  status(jobId: string): Promise<Answer> {
    return this.request('job:status-requested', { jobId });
  }

  /** The status of a job the dispatcher must know. */
  async statusOf(jobId: string): Promise<JobStatus> {
    const answer = await this.status(jobId);
    if (!answer.ok) throw new Error(`job:status-requested was refused: ${JSON.stringify(answer.payload)}`);
    return answer.payload['response'] as JobStatus;
  }

  /** Poll the status until `holds` accepts it. */
  async until(jobId: string, what: string, holds: (status: JobStatus) => boolean, timeoutMs = 10_000): Promise<JobStatus> {
    return eventually(what, timeoutMs, async () => {
      const status = await this.statusOf(jobId);
      return holds(status) ? status : undefined;
    });
  }

  cancelRequest(request: { jobId: string }): Promise<Answer> {
    return this.request('job:cancel-requested', request);
  }

  complete(job: JobRef, result?: Record<string, unknown>): Promise<void> {
    return this.emit('job:complete', { ...job, ...(result === undefined ? {} : { result }) });
  }

  fail(job: JobRef, error: string, extra: { failureClass?: string; completedUnits?: string[]; unitCursors?: Record<string, UnitCursor> } = {}): Promise<void> {
    return this.emit('job:fail', { ...job, error, ...extra });
  }

  reportProgress(job: JobRef, percentage: number, progress?: Record<string, unknown>): Promise<void> {
    return this.emit('job:report-progress', { ...job, percentage, ...(progress === undefined ? {} : { progress }) });
  }

  checkpoint(jobId: string, completedUnits: string[], unitCursors?: Record<string, UnitCursor>): Promise<void> {
    return this.emit('job:checkpoint', { jobId, completedUnits, ...(unitCursors === undefined ? {} : { unitCursors }) });
  }

  cancel(job: JobRef): Promise<void> {
    return this.emit('job:cancel', { ...job });
  }
}

/** A claimed job, as its worker's signals name it. */
export function refOf(job: RunningJob): JobRef {
  return { jobId: job.metadata.id, jobType: job.metadata.type, resourceId: job.params.resourceId };
}

export class DispatcherWorld {
  /** How many times the Browser was asked each vocabulary read. */
  readonly browserReads = new Map<string, number>();
  /** The jobs this world's cases created that are not known to be over. */
  readonly unfinished = new Set<string>();

  private constructor(
    readonly world: World,
    readonly broker: Broker,
    /** The environment the dispatcher is started with: its service account, the broker's credentials when named, and what the world was given. */
    readonly env: DispatcherEnvironment,
    public dispatcher: DispatcherProcess,
    /** Every `job:queued` and `job:assign` the bus carried, read by a standing observer. */
    readonly observer: BusStream,
  ) {}

  static async create(options: DispatcherWorldOptions = {}): Promise<DispatcherWorld> {
    const secret = randomBytes(24).toString('hex');
    const world = await World.create('in-process', { accounts: { [DISPATCHER_CLIENT]: { secret, roles: [SERVICE_ROLE] } } });
    const broker = await startBroker(options.broker);
    const credentials = options.broker?.user ? { userEnv: 'QUEUE_USER', passwordEnv: 'QUEUE_PASSWORD' } : {};
    const env: DispatcherEnvironment = {
      SEMIONT_OIDC_CLIENT_ID: DISPATCHER_CLIENT,
      SEMIONT_OIDC_CLIENT_SECRET: secret,
      ...(options.broker?.user ? { QUEUE_USER: options.broker.user, QUEUE_PASSWORD: options.broker.password } : {}),
      ...options.env,
    };
    const settings: DispatcherSettings = {
      gatewayUrl: world.origin,
      identity: { issuer: world.issuer.origin },
      queue: { servers: broker.url, ...credentials },
      port: await freePort(),
      timing: { ...QUIET_TIMING, ...options.timing },
      logLevel: 'info',
      logFormat: 'json',
    };
    const { token } = await world.agent('conformance', 'observer');
    const observer = await world.subscribe(token, { clientId: randomUUID(), global: ['job:queued', 'job:assign'] }, world.origin, true);
    holdToRegistry(observer);
    const dispatcher = await startDispatcher({ settings, env });
    const self = new DispatcherWorld(world, broker, env, dispatcher, observer);
    if (options.vocabulary !== null) await self.startBrowser(options.vocabulary ?? VOCABULARY);
    await self.answering();
    return self;
  }

  private async startBrowser(vocabulary: Vocabulary): Promise<void> {
    const reads: Record<string, { channel: string; payload: Record<string, unknown> }> = {
      'browse:entity-types-requested': { channel: 'browse:entity-types-result', payload: { response: { entityTypes: vocabulary.entityTypes } } },
      'browse:tag-schemas-requested': { channel: 'browse:tag-schemas-result', payload: { response: { tagSchemas: vocabulary.tagSchemas } } },
    };
    const { stream } = await this.world.responder(Object.keys(reads), (frame) => {
      this.browserReads.set(frame.channel, (this.browserReads.get(frame.channel) ?? 0) + 1);
      return reads[frame.channel];
    });
    holdToRegistry(stream);
  }

  /**
   * Wait until the dispatcher answers on the bus. Its health says the queue is
   * connected and its handlers attached, not that its stream to the gateway is
   * open; until it is, a request reaches no one.
   */
  async answering(): Promise<void> {
    const probe = await this.sidecar('readiness');
    await eventually('the dispatcher to answer on the bus', 20_000, async () => {
      const answer = await probe.status(`job-${randomUUID()}`);
      return answer.payload['code'] === 'peer-unavailable' ? undefined : true;
    });
  }

  get settings(): DispatcherSettings {
    return this.dispatcher.settings;
  }

  private async client(token: string, did: string, channels: string[]): Promise<BusClient> {
    const replies = JOB_OPERATIONS.flatMap((op) => {
      const { result, failure } = operationFor(op);
      return [result, failure];
    });
    const clientId = randomUUID();
    const stream = await this.world.subscribe(token, { clientId, global: [...replies, ...channels] });
    holdToRegistry(stream);
    return new BusClient(this, token, did, clientId, stream);
  }

  /** A person, signed in at the issuer. */
  async person(sub: string, channels: string[] = []): Promise<BusClient> {
    return this.client(await this.world.person(sub), this.world.personDid(sub), channels);
  }

  /** A worker: a software agent holding the worker role. */
  async worker(model: string, channels: string[] = []): Promise<BusClient> {
    const { token, did } = await this.world.agent('conformance', model, [SERVICE_ROLE, WORKER_ROLE]);
    return this.client(token, did, channels);
  }

  /** A sidecar: a software agent holding the service role and not the worker role. */
  async sidecar(model: string, channels: string[] = []): Promise<BusClient> {
    const { token, did } = await this.world.agent('conformance', model, [SERVICE_ROLE]);
    return this.client(token, did, channels);
  }

  /**
   * A job created by a person and claimed by a worker: the worker holds it,
   * `running`. A `mark` job, given as its parameters, is created on a fresh
   * resource; a `yield` job on a context focusing one.
   */
  async running(job: MarkParams | 'yield' = { motivation: 'highlighting' }): Promise<{ creator: BusClient; worker: BusClient; job: RunningJob; ref: JobRef }> {
    const creator = await this.person('creator');
    const worker = await this.worker(`worker-${job === 'yield' ? job : job.motivation}`);
    const jobId = job === 'yield'
      ? await creator.created('yield', generation(resourceIdOf()))
      : await creator.created('mark', job, resourceIdOf());
    const claimed = await worker.claimed([job === 'yield' ? YIELDS : marks(job.motivation)]);
    if (claimed.metadata.id !== jobId) throw new Error(`the claim handed out ${claimed.metadata.id}, not the job just created, ${jobId}`);
    return { creator, worker, job: claimed, ref: refOf(claimed) };
  }

  /** The `job:queued` announcements of `jobId` so far. */
  announcements(jobId: string): BusFrame[] {
    return this.observer.frames('job:queued').filter((f) => f.payload['jobId'] === jobId);
  }

  /** Wait for the `n`th announcement of `jobId`. */
  announced(jobId: string, n = 1, timeoutMs = 10_000): Promise<BusFrame> {
    return eventually(`announcement ${n} of ${jobId}`, timeoutMs, () => this.announcements(jobId)[n - 1]);
  }

  /** Wait for the `job:assign` recording the `n`th claim of `jobId`. */
  assigned(jobId: string, n = 1, timeoutMs = 10_000): Promise<BusFrame> {
    return eventually(`assignment ${n} of ${jobId}`, timeoutMs, () => this.observer.frames('job:assign').filter((f) => f.payload['jobId'] === jobId)[n - 1]);
  }

  /** Start a dispatcher again, on the same broker and, unless changed, the same settings. */
  async restartDispatcher(change: (s: DispatcherSettings) => DispatcherSettings = (s) => s): Promise<void> {
    await this.dispatcher.stop();
    await this.startAgain(change(this.settings));
  }

  /** Kill the dispatcher without its shutdown, and start another on the same broker. */
  async crashAndRestart(change: (s: DispatcherSettings) => DispatcherSettings = (s) => s): Promise<void> {
    await this.dispatcher.crash();
    await this.startAgain(change(this.settings));
  }

  private async startAgain(settings: DispatcherSettings): Promise<void> {
    this.dispatcher = await startDispatcher({ settings, env: this.env });
    await this.answering();
  }

  /**
   * Cancel every pending job a case of this world created, each by its id, so
   * that no case's jobs are claimable by the next: a claim names jobs by what
   * they are, not by id. A job the dispatcher did not act on is over, and is
   * not asked about again; one it did act on may be running, and is asked
   * about after every case until it is over.
   */
  async clearPending(): Promise<void> {
    const sweeper = await this.sidecar('sweeper');
    for (const jobId of [...this.unfinished]) {
      const answer = await sweeper.cancelRequest({ jobId });
      if (!answer.ok) throw new Error(`cancelling ${jobId} was refused: ${JSON.stringify(answer.payload)}`);
      if (!(answer.payload['response'] as { cancelled: boolean }).cancelled) this.unfinished.delete(jobId);
    }
  }

  drain(): string[] {
    return this.world.drain();
  }

  async close(): Promise<void> {
    await this.dispatcher.stop();
    await this.world.close();
    await this.broker.stop();
  }
}

/**
 * Run `body`'s cases against one dispatcher world. After every case, the
 * streams it opened must have carried nothing the spec does not allow.
 */
export function withDispatcher(title: string, body: (world: () => DispatcherWorld) => void, options: DispatcherWorldOptions = {}): void {
  describe(title, () => {
    let world: DispatcherWorld | undefined;
    beforeAll(async () => {
      world = await DispatcherWorld.create(options);
    });
    afterAll(async () => {
      await world?.close();
    });
    afterEach(async (context) => {
      if (context.task.result?.state === 'fail') console.error(`dispatcher output:\n${world?.dispatcher.output.join('\n')}`);
      await world?.clearPending();
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!);
  });
}

/**
 * Wait out a frame's handling. The dispatcher does not serialize frames
 * (JOBS.md § Channels), so a case that needs one one-way frame applied before
 * it sends the next, and has no reply to wait on, waits.
 */
export function settle(ms = 500): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A resource as a gathered context describes one. */
export function descriptorOf(resourceId: string): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@id': resourceId, name: 'The source', representations: [{ mediaType: 'text/plain' }] };
}

/** A gathered context with `focus`, and nothing gathered around it. */
export function contextOf(focus: Record<string, unknown>): Record<string, unknown> {
  return { focus, graph: { nodes: [], edges: [] }, metadata: {} };
}

/** A `yield` job's params whose context focuses `resourceId`, as `gather.resource` produces. */
export function generation(resourceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'A generated resource',
    storageUri: `file://generated/${randomUUID()}.md`,
    context: contextOf({ kind: 'resource', resource: descriptorOf(resourceId) }),
    ...extra,
  };
}

export function resourceIdOf(): string {
  return `res-${randomUUID()}`;
}
