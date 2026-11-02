/**
 * A Worker service's world: the service as a process, and everything it meets.
 * That is each knowledge base it serves, as the suite stands in for one: the
 * trusted issuer, which holds the public half of the worker's key on a client
 * of its own; a real gateway, with the harness's stand-in Archivist behind it
 * for bytes, for uploads and for the text the Smelter read out of a PDF; and
 * the suite itself on the gateway's bus, playing the two parties a worker asks
 * things of there. As the dispatcher it answers `job:claim` from the jobs a
 * case queued. As the record it answers `browse:kb-requested`,
 * `browse:resource-requested`, `mark:commit` and
 * `browse:annotation-requested`. Beside them are a stand-in Ollama and a
 * stand-in Anthropic, the providers every knowledge base's engines share.
 *
 * A case's worker serves the world's own knowledge base, and, in a case about
 * a worker of several, the world's second beside it. The worker is pointed at
 * a recording proxy in front of each gateway, so everything it sends a
 * knowledge base is read as a transcript: its sign-in, the stream it opens,
 * each emit, each read of bytes. Nothing reaches inside the process.
 */
import { generateKeyPairSync, randomBytes, type KeyObject } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, inject } from 'vitest';
import type { components } from '@semiont/core';
import { startAnthropic, type ModelFacts, type StandInAnthropic } from './anthropic';
import { startClientProxy, type ClientProxy, type ProxiedRequest } from './client-proxy';
import { everyJob } from './dispatcher-world';
import { freePort } from './net';
import { startOllama, type StandInOllama } from './ollama';
import { MODEL_CATALOGUE } from './paths';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';
import { errorsOf, kbIdentity, principals, spec, SUITE_KB, type KbIdentity } from './spec';
import type { BusFrame, BusStream } from './stream';
import { refusedWorkerBoot, spawnWorkerService, type WorkerEnvironment, type WorkerLaunch, type WorkerProcess, type WorkerSettings } from './worker-service-process';
import { endCase, World } from './world';

/** The client the world's own knowledge base's issuer holds the worker's key on: the worker's account there. */
export const WORKER_CLIENT = 'semiont-worker';

/**
 * The client the second knowledge base's issuer holds the worker's key on:
 * another than the first's, so that what the worker says it is called at each
 * is told apart.
 */
export const SECOND_WORKER_CLIENT = 'semiont-worker-second';

/** The case of kb-identity/cases.json the second knowledge base is. */
const SECOND_KB = 'plain scalars, and a version, which names nothing';

/** The roles the worker's account holds at each issuer, in the order its token carries them. */
export const WORKER_ROLES: readonly string[] = [SERVICE_ROLE, WORKER_ROLE];

/**
 * The variable an Anthropic engine's entry names for its key (`apiKeyEnv`). It
 * is not one the provider's own library reads, so a worker that reaches the
 * stand-in read the variable its document names.
 */
export const ANTHROPIC_KEY_VARIABLE = 'WORKER_SERVICE_ANTHROPIC_KEY';

/**
 * What the stand-in Anthropic says of a model unless a case says otherwise: it
 * reads far more than it writes, and answers in a schema.
 */
export const ANTHROPIC_MODEL: ModelFacts = { maxInputTokens: 200_000, maxOutputTokens: 64_000, structuredOutputs: true };

export type RunningJob = components['schemas']['JobRunning'];
export type JobFilter = components['schemas']['JobFilter'];
export type JobType = components['schemas']['JobType'];
export type FailureClass = components['schemas']['FailureClass'];
export type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type WorkerEngineConfig = components['schemas']['WorkerEngineConfig'];
type WorkerKnowledgeBaseConfig = components['schemas']['WorkerKnowledgeBaseConfig'];

/** An engine a case's worker runs: a provider and a model. */
export interface Engine {
  provider: WorkerEngineConfig['engine']['provider'];
  model: string;
}

/**
 * The engines the suite's workers run, two of each provider so that a case can
 * start a worker of two. An engine is no principal: the gateway names a worker
 * by its account, and what a worker states of an engine is its provider and
 * model, and no name: what the worker is called is its profile.
 */
const OLLAMA_ENGINES: readonly Engine[] = [
  { provider: 'ollama', model: 'gemma2:27b' },
  { provider: 'ollama', model: 'library/llama3' },
];
const ANTHROPIC_ENGINES: readonly Engine[] = [
  { provider: 'anthropic', model: 'claude-sonnet-5' },
  { provider: 'anthropic', model: 'claude-3.5-sonnet' },
];

/** A batch a worker committed, as the record received it. */
export interface Commit {
  resourceId: string;
  jobId: unknown;
  annotations: Annotation[];
  /** The DID the gateway stamped the commit with. */
  by: unknown;
}

/** One `POST /bus/emit` a worker made. */
export interface Emit {
  channel: string;
  payload: Record<string, unknown>;
  correlationId: string | undefined;
  scope: string | undefined;
  /** The DID the gateway named the bearer of its token by. */
  by: string | undefined;
  /** The status the gateway answered it with. */
  status: number | undefined;
  /** When the proxy had it, on the clock its requests and the frames its streams carried share. */
  arrived: number;
}

/** A frame one of the worker's streams carried, and when the proxy read it, on the clock its requests share. */
export interface Carried {
  frame: BusFrame;
  at: number;
}

/** One sign-in a worker made at the gateway: the token it carried, and the DID the gateway answered `GET /api/users/me` with. */
export interface SignIn {
  did: string;
  token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `text` as the JSON it holds, or undefined for text that holds none. */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The token a request carried as its bearer. */
const bearerOf = (request: ProxiedRequest): string | undefined => request.headers.authorization?.replace(/^Bearer /, '');

/** Whether a claim's filter takes `job`: its type, and for a `mark` job its motivation. */
function takes(filter: JobFilter, job: RunningJob): boolean {
  if (filter.jobType !== job.metadata.type) return false;
  return filter.jobType !== 'mark' || filter.params.motivation === job.params['motivation'];
}

/**
 * A running worker, as one knowledge base it serves meets it: the transcript
 * of what it has sent that knowledge base's gateway.
 */
export class Served {
  constructor(
    readonly process: WorkerProcess,
    readonly proxy: ClientProxy,
    /** The proxy in front of the gateway of each knowledge base the worker serves. */
    readonly proxies: ReadonlyMap<StandInKnowledgeBase, ClientProxy>,
  ) {}

  /** The same worker, as `kb` meets it. */
  at(kb: StandInKnowledgeBase): Served {
    const proxy = this.proxies.get(kb);
    if (!proxy) throw new Error(`the worker does not serve ${kb.domain}`);
    return new Served(this.process, proxy, this.proxies);
  }

  /** Each sign-in the gateway answered, in order. */
  signIns(): SignIn[] {
    return this.proxy.requests.flatMap((r) => {
      if (r.method !== 'GET' || r.path !== '/api/users/me' || r.status !== 200 || !isObject(r.answer)) return [];
      const { did } = r.answer;
      const token = bearerOf(r);
      return typeof did === 'string' && token !== undefined ? [{ did, token }] : [];
    });
  }

  /** Every token the worker carried here as its bearer. */
  tokens(): string[] {
    return [...new Set(this.proxy.requests.flatMap((r) => bearerOf(r) ?? []))];
  }

  /** The DID the gateway named the bearer of `request`'s token by, when it signed in with it. */
  private by(request: ProxiedRequest): string | undefined {
    const bearer = bearerOf(request);
    return this.signIns().find((s) => s.token === bearer)?.did;
  }

  /** Every stream opened: who opened it, what it names, and whether it has ended. */
  streams(): Array<{ by: string | undefined; body: Record<string, unknown>; closed: boolean }> {
    return this.proxy.requests.flatMap((r) => (r.method === 'POST' && r.path === '/bus/subscribe' && isObject(r.json) ? [{ by: this.by(r), body: r.json, closed: r.closed }] : []));
  }

  /** The frames on `channel` the worker's streams carried to it, in the order the proxy read them. */
  carried(channel: string): Carried[] {
    return this.proxy.requests.flatMap((r) =>
      r.method === 'POST' && r.path === '/bus/subscribe'
        ? r.events.flatMap((event) => {
            const frame = event.event === 'bus-event' ? parsed(event.data) : undefined;
            return isObject(frame) && frame['channel'] === channel ? [{ frame: frame as unknown as BusFrame, at: event.at }] : [];
          })
        : [],
    );
  }

  private emitOf(r: ProxiedRequest): Emit | undefined {
    if (r.method !== 'POST' || r.path !== '/bus/emit' || !isObject(r.json)) return undefined;
    const { channel, payload, correlationId, scope } = r.json;
    if (typeof channel !== 'string' || !isObject(payload)) return undefined;
    return {
      channel,
      payload,
      correlationId: typeof correlationId === 'string' ? correlationId : undefined,
      scope: typeof scope === 'string' ? scope : undefined,
      by: this.by(r),
      status: r.status,
      arrived: r.arrived,
    };
  }

  /** Every emit, in the order the gateway received them; of one channel, when named. */
  emits(channel?: string): Emit[] {
    return this.proxy.requests.flatMap((r) => {
      const emit = this.emitOf(r);
      return emit && (channel === undefined || emit.channel === channel) ? [emit] : [];
    });
  }

  /** The payloads emitted on `channel`, in order. */
  payloads(channel: string): Array<Record<string, unknown>> {
    return this.emits(channel).map((e) => e.payload);
  }

  /** Resolves with the `count`th emit on `channel` that `match` accepts, once the gateway has answered it. */
  emitted(channel: string, match: (e: Emit) => boolean = () => true, count = 1, timeoutMs = 20_000): Promise<Emit> {
    return this.proxy.until(
      `emit ${count} on ${channel}`,
      () => {
        const found = this.emits(channel).filter((e) => e.status !== undefined && match(e));
        return found[count - 1];
      },
      timeoutMs,
    );
  }

  /**
   * What the worker asked of the gateway, in order, by name: `emit <channel>`,
   * `GET <path>`, `POST <path>`. Progress reports are left out: a worker does
   * not wait for the gateway to take one before it goes on, so where they fall
   * among the rest is not fixed. Sign-ins, streams, the question of which
   * knowledge base this is and the agent's saying what it is called are left
   * out too: what a worker says as it starts.
   */
  sequence(): string[] {
    return this.proxy.requests.flatMap((r) => {
      if (r.path === '/api/users/me' || r.path === '/bus/subscribe') return [];
      const emit = this.emitOf(r);
      if (emit) return STARTING.has(emit.channel) || emit.channel === 'job:report-progress' ? [] : [`emit ${emit.channel}`];
      return [`${r.method} ${r.path}`];
    });
  }

  /** The progress reports of `jobId`, in a fixed order of their own: by percentage, then by what they say. */
  progress(jobId: string): Array<Record<string, unknown>> {
    return sortedProgress(this.payloads('job:report-progress').filter((p) => p['jobId'] === jobId));
  }

  /** Every request the gateway refused. */
  refused(): string[] {
    return this.proxy.requests.flatMap((r) => (r.status !== undefined && r.status >= 400 ? [`${r.method} ${r.path} answered ${r.status}: ${JSON.stringify(r.json ?? null).slice(0, 300)} → ${JSON.stringify(r.answer ?? null).slice(0, 300)}`] : []));
  }

  /** What it asked of this knowledge base's gateway, for a failing case. */
  account(): string[] {
    return this.proxy.requests.map((r) => {
      const emit = this.emitOf(r);
      const what = emit ? `emit ${emit.channel} ${JSON.stringify(emit.payload)}` : r.path === '/bus/subscribe' ? `subscribe ${JSON.stringify(r.json)}` : `${r.method} ${r.path}`;
      return `    [${r.status ?? 'unanswered'}] ${what}`;
    });
  }
}

/** What a worker says on a knowledge base's bus as it starts there: which knowledge base this is, and what the agent is called. */
const STARTING: ReadonlySet<string> = new Set(['browse:kb-requested', 'principal:profile']);

/** Progress reports in a fixed order: by percentage, then by their text. */
export function sortedProgress(reports: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const key = (p: Record<string, unknown>) => `${String(p['percentage']).padStart(6, '0')} ${JSON.stringify(p)}`;
  return [...reports].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * How a knowledge base answers a worker that asks which it is
 * (`browse:kb-requested`), when a case says otherwise than its plain answer:
 * with another domain, with `browse:kb-failed`, or not at all.
 */
export type Confirmation = { domain: string } | { failure: string } | 'unanswered';

/** The channels the suite answers on a knowledge base's bus, as the dispatcher and as the record. */
const ANSWERED = ['job:claim', 'browse:kb-requested', 'browse:resource-requested', 'mark:commit', 'browse:annotation-requested'];

/** The world of a knowledge base the suite stands in for, whose issuer holds the public half of the worker's key on `client`. */
async function standInWorld(identity: KbIdentity, client: string, publicKey: KeyObject): Promise<World> {
  return World.create('in-process', { kb: identity, accounts: { [client]: { publicKey, roles: [...WORKER_ROLES] } } });
}

/**
 * A knowledge base a worker serves, as the suite stands in for it: its
 * gateway, behind the issuer that holds the worker's key on `client`, and the
 * suite on its bus as the dispatcher and the record.
 */
export class StandInKnowledgeBase {
  /** Jobs waiting to be claimed, in order. A claim is answered with the first its filters take. */
  readonly queue: RunningJob[] = [];
  /** Every `job:claim` the dispatcher received: who claimed, with what filters, and the job it was answered with. */
  readonly claims: Array<{ by: unknown; roles: unknown; accepts: unknown; answered: string | undefined }> = [];
  /** The descriptors the record answers `browse:resource-requested` with. */
  readonly descriptors = new Map<string, ResourceDescriptor>();
  /** Every `browse:resource-requested` the record received. */
  readonly descriptorReads: string[] = [];
  /** Every batch committed, in order, acknowledged or not. */
  readonly commits: Commit[] = [];
  /** What the record holds, per resource: an annotation is recorded once, by its id. */
  readonly recorded = new Map<string, Annotation[]>();
  /** What the suite did wrong, as a party a worker meets: it must hand a worker nothing the spec does not allow. */
  readonly violations: string[] = [];
  /**
   * What a case has the suite's parties do instead of their plain answer.
   * `claim` answers a claim with a refusal. `handAnyJob` answers a claim with
   * the next job whatever the claim's filters: what no dispatcher does.
   * `commit` runs when a batch arrives and before it is acknowledged, and may
   * refuse it with a reason. `described` runs when a resource's description
   * is asked for and before it is answered. `confirm` runs when the worker
   * asks which knowledge base this is and before it is answered, and may
   * answer otherwise than this knowledge base's domain.
   */
  hooks: {
    claim?: () => { code?: string; message: string } | undefined;
    handAnyJob?: boolean;
    commit?: (commit: Commit) => Promise<{ refuse: string } | undefined> | { refuse: string } | undefined;
    described?: (resourceId: string) => Promise<void>;
    confirm?: () => Promise<Confirmation | undefined> | Confirmation | undefined;
  } = {};

  private peer!: { stream: BusStream; token: string; clientId: string };

  protected constructor(
    readonly world: World,
    /** The client its issuer holds the worker's key on: the worker's account here. */
    readonly client: string,
  ) {}

  /** Stand in for the knowledge base `identity` is. */
  static async standIn(identity: KbIdentity, client: string, publicKey: KeyObject): Promise<StandInKnowledgeBase> {
    const kb = new StandInKnowledgeBase(await standInWorld(identity, client, publicKey), client);
    await kb.attend();
    return kb;
  }

  /** Put the suite on this knowledge base's bus, as the parties a worker asks things of. */
  protected async attend(): Promise<void> {
    this.peer = await this.world.responder(ANSWERED, (frame) => this.answer(frame));
  }

  // ── which knowledge base this is, and who the worker is here ─────────────

  /** Its did:web domain, as it answers `browse:kb-requested`. */
  get domain(): string {
    return this.world.kb.domain;
  }

  /** The DID the gateway names the worker by here: its account's (principals/cases.json). */
  get did(): string {
    return principals(this.domain).agentDid(this.world.issuer.subjectOf(this.client));
  }

  /** The `generator` the worker states on what `engine` makes here: the worker, by its DID here, and the engine. */
  generator(engine: Engine = OLLAMA_ENGINES[0]!): Record<string, unknown> {
    return { '@type': 'Software', '@id': this.did, provider: engine.provider, model: engine.model };
  }

  /**
   * What a worker's document says of this knowledge base: its domain, its
   * gateway at `gatewayUrl`, its issuer and the client the worker signs in as
   * there, and the engines the worker offers it.
   */
  configuration(gatewayUrl: string, engines: WorkerEngineConfig[], client = this.client): WorkerKnowledgeBaseConfig {
    return { domain: this.domain, gatewayUrl, identity: { issuer: this.world.issuer.origin, clientId: client }, engines };
  }

  // ── what a case gives the parties the suite plays ────────────────────────

  /** A text resource: its bytes behind the gateway, and its description on the bus. */
  resource(id: string, text: string, mediaType = 'text/markdown', name = 'A resource'): void {
    const storageUri = `file://worker-service/${id}`;
    this.world.archivist.resources.set(id, { storageUri, mediaType });
    this.world.archivist.content.set(storageUri, Buffer.from(text, 'utf8'));
    this.describe(id, mediaType, name);
  }

  /** A resource's description on the bus, with no bytes behind the gateway. */
  describe(id: string, mediaType: string, name = 'A resource'): void {
    this.descriptors.set(id, { '@context': 'https://schema.org', '@id': id as ResourceDescriptor['@id'], name, representations: [{ mediaType, storageUri: `file://worker-service/${id}`, rel: 'original' }] });
  }

  /**
   * The resources whose anchored text the gateway asked the Archivist for, one
   * for each read, in order. What a read is answered is a case's to script,
   * in the stand-in's `anchoredTexts`.
   */
  anchoredTextReads(): string[] {
    return this.world.archivist.calls.flatMap((call) => {
      const resource = call.method === 'GET' ? /^\/resources\/([^/]+)\/anchored-text$/.exec(call.path)?.[1] : undefined;
      return resource === undefined ? [] : [decodeURIComponent(resource)];
    });
  }

  /** A job as the dispatcher hands it to whoever claims it, queued for the next claim that takes it. */
  queued(jobId: string, type: JobType, params: Record<string, unknown> & { resourceId: string }, metadata: Partial<RunningJob['metadata']> = {}): RunningJob {
    // The ids are the case's own strings: the spec's id types are branded, and a case names its ids plainly.
    const job: RunningJob = {
      status: 'running',
      metadata: {
        id: jobId as RunningJob['metadata']['id'],
        type,
        userId: this.world.personDid('requester') as RunningJob['metadata']['userId'],
        created: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
        maxRetries: 3,
        ...metadata,
      },
      params: params as RunningJob['params'],
      startedAt: '2026-01-01T00:00:01.000Z',
      progress: {},
    };
    const validate = spec().component('JobClaimedResult');
    if (!validate({ response: job })) throw new Error(`the case queued a job a dispatcher could not hand out (${errorsOf(validate)})`);
    this.queue.push(job);
    return job;
  }

  /** Announce `job` as the dispatcher announces one it has queued: `job:queued`, with the description and none of what the dispatcher adds. */
  async announce(job: RunningJob): Promise<void> {
    const { resourceId, schema: _schema, ...description } = job.params;
    await this.emit('job:queued', { jobId: job.metadata.id, jobType: job.metadata.type, resourceId, userId: job.metadata.userId, params: description });
  }

  /** Emit as a party on the bus: the dispatcher's announcements, a cancellation, a request of the worker. */
  async emit(channel: string, payload: Record<string, unknown>, correlationId?: string): Promise<void> {
    const reply = await this.world.emit(this.peer.token, { channel, payload, ...(correlationId ? { correlationId, clientId: this.peer.clientId } : {}) });
    if (reply.status !== 202) throw new Error(`the gateway refused the suite's ${channel}: ${reply.status} ${reply.text}`);
  }

  /** A stream of the suite's own, naming `channels`: for the replies and broadcasts a case reads. */
  async listen(channels: string[]): Promise<{ stream: BusStream; clientId: string; token: string }> {
    const clientId = `listener-${randomBytes(8).toString('hex')}`;
    const stream = await this.world.subscribe(this.peer.token, { clientId, global: channels });
    return { stream, clientId, token: this.peer.token };
  }

  // ── the parties the suite plays ──────────────────────────────────────────

  private async answer(frame: BusFrame): Promise<{ channel: string; payload: Record<string, unknown> } | undefined> {
    const payload = frame.payload;
    const resourceId = String(payload['resourceId']);
    switch (frame.channel) {
      case 'job:claim': {
        const accepts = Array.isArray(payload['accepts']) ? (payload['accepts'] as JobFilter[]) : [];
        const claim: (typeof this.claims)[number] = { by: payload['_userId'], roles: payload['_roles'], accepts, answered: undefined };
        this.claims.push(claim);
        const refusal = this.hooks.claim?.();
        if (refusal) return { channel: 'job:claim-failed', payload: refusal };
        const at = this.hooks.handAnyJob ? (this.queue.length > 0 ? 0 : -1) : this.queue.findIndex((job) => accepts.some((filter) => takes(filter, job)));
        if (at < 0) return { channel: 'job:claim-failed', payload: { code: 'none-pending', message: 'No pending job matches' } };
        const [job] = this.queue.splice(at, 1);
        claim.answered = job!.metadata.id;
        return { channel: 'job:claimed', payload: { response: job } };
      }
      case 'browse:kb-requested': {
        const confirmation = await this.hooks.confirm?.();
        if (confirmation === 'unanswered') return undefined;
        if (confirmation !== undefined && 'failure' in confirmation) return { channel: 'browse:kb-failed', payload: { message: confirmation.failure } };
        const domain = confirmation === undefined ? this.domain : confirmation.domain;
        return { channel: 'browse:kb-result', payload: { response: { name: this.world.kb.name, domain } } };
      }
      case 'browse:resource-requested': {
        this.descriptorReads.push(resourceId);
        await this.hooks.described?.(resourceId);
        const resource = this.descriptors.get(resourceId);
        if (!resource) return { channel: 'browse:resource-failed', payload: { code: 'not-found', message: `Resource not found: ${resourceId}` } };
        return { channel: 'browse:resource-result', payload: { response: { resource, lastSequence: 1 } } };
      }
      case 'mark:commit': {
        const annotations = Array.isArray(payload['annotations']) ? (payload['annotations'] as Annotation[]) : [];
        const commit: Commit = { resourceId, jobId: payload['jobId'], annotations, by: payload['_userId'] };
        this.commits.push(commit);
        const verdict = await this.hooks.commit?.(commit);
        if (verdict) return { channel: 'mark:commit-failed', payload: { message: verdict.refuse } };
        // The record appends the annotations it does not hold.
        const held = this.recorded.get(resourceId) ?? [];
        const fresh = annotations.filter((a) => !held.some((h) => h.id === a.id));
        this.recorded.set(resourceId, [...held, ...fresh]);
        // `persisted` is how many of the batch are in the record, appended now or held already: never an append tally.
        return { channel: 'mark:commit-ok', payload: { response: { persisted: annotations.length, annotationIds: annotations.map((a) => a.id) } } };
      }
      case 'browse:annotation-requested': {
        const annotation = (this.recorded.get(resourceId) ?? []).find((a) => a.id === payload['annotationId']);
        if (!annotation) return { channel: 'browse:annotation-failed', payload: { code: 'not-found', message: `Annotation not found: ${String(payload['annotationId'])}` } };
        return { channel: 'browse:annotation-result', payload: { response: { annotation, resource: null, resolvedResource: null } } };
      }
      default:
        this.violations.push(`the suite was sent ${frame.channel}, which it does not answer`);
        return undefined;
    }
  }

  // ── the end of a case ────────────────────────────────────────────────────

  /** What a failing case shows of this knowledge base: what its record was committed and its dispatcher claimed from, and what its gateway wrote. */
  account(): string[] {
    return [
      `  ${this.domain}'s record was committed:`,
      ...this.commits.map((c) => `    ${JSON.stringify(c)}`),
      `  ${this.domain}'s dispatcher was claimed from:`,
      ...this.claims.map((c) => `    ${JSON.stringify(c)}`),
      `  ${this.domain}'s gateway wrote:`,
      ...this.world.gateway.output.map((line) => `    ${line}`),
    ];
  }

  /**
   * What went wrong here that no case may let pass, and forget what the case
   * scripted: a frame outside the spec, an Archivist call or answer outside
   * its own, anything the suite itself handed a worker outside the spec, and
   * a grant the issuer was told to fail that no grant met.
   */
  forget(): string[] {
    const violations = [...this.violations.splice(0), ...this.world.drain()];
    const unmet = this.world.issuer.failing.next.splice(0);
    if (unmet.length > 0) violations.push(`${this.domain}'s issuer was told to fail grants no grant met: ${unmet.join(', ')}`);
    this.world.issuer.failing.met.length = 0;
    this.queue.length = 0;
    this.claims.length = 0;
    this.descriptors.clear();
    this.descriptorReads.length = 0;
    this.commits.length = 0;
    this.recorded.clear();
    this.hooks = {};
    this.world.archivist.uploads.length = 0;
    this.world.archivist.calls.length = 0;
    this.world.archivist.anchoredTexts.clear();
    this.world.archivist.mode.refuseUploads = undefined;
    return violations;
  }

  async close(): Promise<void> {
    await this.world.close();
  }
}

/**
 * A case's world: its own knowledge base, which every case's worker serves,
 * the second a case of a worker of two has it serve beside the first, the
 * providers both share, and the workers the case started.
 */
export class WorkerServiceWorld extends StandInKnowledgeBase {
  private readonly served: Served[] = [];
  private secondKnowledgeBase: StandInKnowledgeBase | undefined;

  private constructor(
    readonly implementation: string,
    private readonly command: readonly string[],
    world: World,
    readonly ollama: StandInOllama,
    readonly anthropic: StandInAnthropic,
    /** The key the worker signs in with at every knowledge base, as its environment holds it. */
    readonly env: WorkerEnvironment,
    /** The key's public half, which each knowledge base's issuer holds on the worker's client there. */
    private readonly publicKey: KeyObject,
  ) {
    super(world, WORKER_CLIENT);
  }

  static async create(implementation: string): Promise<WorkerServiceWorld> {
    const command = inject('workerServices')[implementation];
    if (!command) throw new Error(`harness/paths.ts names no Worker service ${implementation}`);
    // The worker proves itself with a key: each issuer holds the public half, the worker's environment the private.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const world = await standInWorld(kbIdentity(SUITE_KB), WORKER_CLIENT, publicKey);
    const ollama = await startOllama();
    const anthropic = await startAnthropic(
      `sk-ant-conformance-${randomBytes(24).toString('hex')}`,
      ANTHROPIC_ENGINES.map((engine) => engine.model),
      ANTHROPIC_MODEL,
    );
    const made = new WorkerServiceWorld(implementation, command, world, ollama, anthropic, { SEMIONT_OIDC_CLIENT_KEY: key }, publicKey);
    await made.attend();
    return made;
  }

  /**
   * The second knowledge base: another domain, a gateway and an issuer of its
   * own, the worker's key held there on `SECOND_WORKER_CLIENT`. Made when a
   * case first asks for it, and kept for the file's other cases.
   */
  async second(): Promise<StandInKnowledgeBase> {
    this.secondKnowledgeBase ??= await StandInKnowledgeBase.standIn(kbIdentity(SECOND_KB), SECOND_WORKER_CLIENT, this.publicKey);
    return this.secondKnowledgeBase;
  }

  // ── the engines a worker runs ────────────────────────────────────────────

  /** The engines a case's worker runs unless the case says otherwise: Ollama's. */
  get engines(): readonly Engine[] {
    return OLLAMA_ENGINES;
  }

  /** The engines of a case about a worker on Anthropic. */
  get anthropicEngines(): readonly Engine[] {
    return ANTHROPIC_ENGINES;
  }

  /**
   * An entry of a knowledge base's `engines`: `engine`, used for `jobs`, on the
   * stand-in of its provider. An Anthropic engine's entry names the variable
   * its key is in.
   */
  entry(engine: Engine, jobs: JobFilter[]): WorkerEngineConfig {
    const used = { engine: { provider: engine.provider, model: engine.model }, jobs };
    return engine.provider === 'anthropic' ? { ...used, baseUrl: this.anthropic.origin, apiKeyEnv: ANTHROPIC_KEY_VARIABLE } : { ...used, baseUrl: this.ollama.origin };
  }

  /** What a knowledge base's worker runs unless a case says otherwise: one engine, the first, used for every job. */
  private everything(): WorkerEngineConfig[] {
    return [this.entry(this.engines[0]!, everyJob())];
  }

  // ── the document a worker is started with ────────────────────────────────

  /** A worker's configuration document, serving `knowledgeBases`. */
  async settings(knowledgeBases: WorkerKnowledgeBaseConfig[]): Promise<WorkerSettings> {
    return { knowledgeBases, modelCatalogue: MODEL_CATALOGUE, port: await freePort(), logLevel: 'info', logFormat: 'json' };
  }

  /** A launch of a worker of this world's knowledge base as `start` makes one, for a case that must change it: the gateway is dialled directly. */
  async launch(change: Partial<Omit<WorkerLaunch, 'command'>> = {}): Promise<WorkerLaunch> {
    return { command: this.command, settings: await this.settings([this.configuration(this.world.origin, this.everything())]), env: this.env, ...change };
  }

  /** Start a worker that must refuse to start: its exit code and what it wrote. */
  async refused(change: Partial<Omit<WorkerLaunch, 'command'>> = {}): Promise<{ code: number | null; output: string; stdout: string[]; stderr: string }> {
    return refusedWorkerBoot(await this.launch(change));
  }

  /**
   * Start a worker serving this world's knowledge base, with `engines` there,
   * and each of `serving` after it, behind a recording proxy in front of each
   * gateway, and go on without waiting for its health. A knowledge base of
   * `serving` is signed in at as its client unless `client` names another. It
   * is stopped when the case ends. Each variable its document names for a key
   * holds the stand-in Anthropic's.
   */
  async spawn(options: StartOptions = {}): Promise<Served> {
    const own = await startClientProxy(this.world.origin);
    const proxies = new Map<StandInKnowledgeBase, ClientProxy>([[this, own]]);
    try {
      const entries = [this.configuration(own.origin, options.engines ?? this.everything())];
      for (const { kb, engines, client } of options.serving ?? []) {
        const proxy = await startClientProxy(kb.world.origin);
        proxies.set(kb, proxy);
        entries.push(kb.configuration(proxy.origin, engines, client));
      }
      const settings: WorkerSettings = { ...(await this.settings(entries)), ...options.settings };
      const keys: WorkerEnvironment = {};
      for (const entry of settings.knowledgeBases.flatMap((kb) => kb.engines)) if (entry.apiKeyEnv !== undefined) keys[entry.apiKeyEnv] = this.anthropic.apiKey;
      const process = spawnWorkerService({
        command: this.command,
        settings,
        env: { ...this.env, ...keys, ...options.env },
        ...(options.unlisted ? { unlisted: options.unlisted } : {}),
      });
      const served = new Served(process, own, proxies);
      this.served.push(served);
      return served;
    } catch (error) {
      for (const proxy of proxies.values()) await proxy.close();
      throw error;
    }
  }

  /** Start a worker as `spawn` does, and wait for its health. */
  async start(options: StartOptions = {}): Promise<Served> {
    const served = await this.spawn(options);
    await served.process.healthy();
    return served;
  }

  // ── the end of a case ────────────────────────────────────────────────────

  /** What a failing case shows: every worker's transcript at each knowledge base, what it wrote, what its providers were asked, and each knowledge base's record, dispatcher and gateway. */
  override account(): string[] {
    return [
      ...this.served.flatMap((served) => [
        ...[...served.proxies.keys()].flatMap((kb) => [`  the worker asked ${kb.domain}'s gateway:`, ...served.at(kb).account()]),
        '  the worker wrote:',
        ...served.process.output.slice(-80).map((line) => `    ${line}`),
      ]),
      '  the stand-in Ollama was asked:',
      ...this.ollama.generations.map((g) => `    ${JSON.stringify(g.body)}${g.abandoned ? ' (abandoned)' : ''}`),
      '  the stand-in Anthropic was asked:',
      ...this.anthropic.requests.map((r) => `    ${r.method} ${r.path} ${JSON.stringify(r.body ?? null)}${r.abandoned ? ' (abandoned)' : ''}`),
      ...super.account(),
      ...(this.secondKnowledgeBase?.account() ?? []),
    ];
  }

  /**
   * Stop every worker the case started and forget what the case scripted.
   * Returns what went wrong that no case may let pass: a request of a gateway
   * that it refused, a request of a provider no case scripted, and what each
   * knowledge base's `forget` returns.
   */
  async settle(allowRefusedRequests = false): Promise<string[]> {
    const violations: string[] = [];
    for (const served of this.served.splice(0)) {
      if (!allowRefusedRequests) for (const kb of served.proxies.keys()) violations.push(...served.at(kb).refused());
      await served.process.stop();
      for (const proxy of served.proxies.values()) await proxy.close();
    }
    violations.push(...this.ollama.violations.splice(0), ...this.anthropic.violations.splice(0), ...this.forget(), ...(this.secondKnowledgeBase?.forget() ?? []));
    this.ollama.reset();
    this.anthropic.reset();
    return violations;
  }

  override async close(): Promise<void> {
    await this.settle(true);
    await this.ollama.close();
    await this.anthropic.close();
    await this.secondKnowledgeBase?.close();
    await super.close();
  }
}

/** How a case starts a worker: what `WorkerServiceWorld.spawn` takes. */
export interface StartOptions {
  /** The engines it offers the world's own knowledge base. */
  engines?: WorkerEngineConfig[];
  /** The knowledge bases it serves after the world's own, in order, each with the engines it offers there. */
  serving?: Array<{ kb: StandInKnowledgeBase; engines: WorkerEngineConfig[]; client?: string }>;
  env?: WorkerEnvironment;
  unlisted?: Record<string, string>;
  settings?: Partial<WorkerSettings>;
}

/**
 * Run `body`'s cases against each implementation of the Worker service, each
 * in a world of its own. A case starts the workers it needs; they are stopped
 * when it ends, and it fails, whatever it was about, if a worker asked the
 * gateway for something the gateway refused, asked a provider for something
 * the case did not script, or put on the bus what the spec does not allow.
 */
export function eachWorkerService(title: string, body: (world: () => WorkerServiceWorld) => void, options: { allowRefusedRequests?: boolean } = {}): void {
  describe.each(Object.keys(inject('workerServices')))(`${title} (the %s worker)`, (implementation) => {
    let world: WorkerServiceWorld | undefined;
    beforeAll(async () => {
      world = await WorkerServiceWorld.create(implementation);
    });
    afterAll(async () => {
      await world?.close();
    });
    afterEach((context) => endCase(context, world!.account().join('\n'), () => world!.settle(options.allowRefusedRequests)));
    body(() => world!);
  });
}
