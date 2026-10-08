/**
 * A Worker service's world: the service as a process, and everything it meets.
 * That is the trusted issuer, which admits its service account; a real
 * gateway, with the harness's stand-in Archivist behind it for bytes and
 * uploads; a stand-in Ollama, its provider; and the suite itself on the bus,
 * playing the three parties a worker asks things of. As the dispatcher it
 * answers `job:claim` from the jobs a case queued. As the record it answers
 * `browse:resource-requested`, `mark:commit` and `browse:annotation-requested`.
 * As the Smelter it answers `browse:anchored-text-requested`.
 *
 * The worker is pointed at a recording proxy in front of the gateway, so
 * everything it sends is read as a transcript: each sign-in, each stream it
 * opens, each emit, each read of bytes. Nothing reaches inside the process.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject } from 'vitest';
import type { components } from '@semiont/core';
import { startClientProxy, type ClientProxy, type ProxiedRequest } from './client-proxy';
import { everyJob } from './dispatcher-world';
import { freePort } from './net';
import { startOllama, type StandInOllama } from './ollama';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';
import { errorsOf, principals, spec } from './spec';
import type { BusFrame, BusStream } from './stream';
import { refusedWorkerBoot, startWorkerService, type WorkerEnvironment, type WorkerLaunch, type WorkerProcess, type WorkerSettings } from './worker-service-process';
import { World } from './world';

/** The worker's service account at the issuer. */
export const WORKER_CLIENT = 'semiont-worker';

export type RunningJob = components['schemas']['JobRunning'];
export type JobFilter = components['schemas']['JobFilter'];
export type JobType = components['schemas']['JobType'];
export type Annotation = components['schemas']['Annotation'];
type ResourceDescriptor = components['schemas']['ResourceDescriptor'];
type AgentEntry = WorkerSettings['agents'][number];

/** An agent a case's worker works as: a provider and a model, and the DID and name the gateway gives the pair. */
export interface WorkerAgent {
  provider: AgentEntry['agent']['provider'];
  model: string;
  did: string;
  name: string;
}

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
  /** The DID of the agent whose token it carried. */
  by: string | undefined;
  /** The status the gateway answered it with. */
  status: number | undefined;
}

/** One sign-in a worker made at the gateway. */
export interface SignIn {
  provider: unknown;
  model: unknown;
  did: string;
  token: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Whether a claim's filter takes `job`: its type, and for a `mark` job its motivation. */
function takes(filter: JobFilter, job: RunningJob): boolean {
  if (filter.jobType !== job.metadata.type) return false;
  return filter.jobType !== 'mark' || filter.params.motivation === job.params['motivation'];
}

/** A running worker, and the transcript of what it has sent the gateway. */
export class Served {
  constructor(
    readonly process: WorkerProcess,
    readonly proxy: ClientProxy,
  ) {}

  /** Each sign-in the gateway answered, in order. */
  signIns(): SignIn[] {
    return this.proxy.requests.flatMap((r) => {
      if (r.method !== 'POST' || r.path !== '/api/tokens/agent' || !isObject(r.answer) || !isObject(r.json)) return [];
      const { token, did } = r.answer;
      return typeof token === 'string' && typeof did === 'string' ? [{ provider: r.json['provider'], model: r.json['model'], did, token }] : [];
    });
  }

  /** The DID of the agent whose token `request` carried. */
  private by(request: ProxiedRequest): string | undefined {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    return this.signIns().find((s) => s.token === bearer)?.did;
  }

  /** Every stream opened: who opened it, and what it names. */
  streams(): Array<{ by: string | undefined; body: Record<string, unknown> }> {
    return this.proxy.requests.flatMap((r) => (r.method === 'POST' && r.path === '/bus/subscribe' && isObject(r.json) ? [{ by: this.by(r), body: r.json }] : []));
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
   * among the rest is not fixed. Sign-ins and streams are left out too.
   */
  sequence(): string[] {
    return this.proxy.requests.flatMap((r) => {
      if (r.path === '/api/tokens/agent' || r.path === '/bus/subscribe') return [];
      const emit = this.emitOf(r);
      if (emit) return emit.channel === 'job:report-progress' ? [] : [`emit ${emit.channel}`];
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

  /** The whole transcript, for a failing case. */
  account(): string {
    const wire = this.proxy.requests.map((r) => {
      const emit = this.emitOf(r);
      const what = emit ? `emit ${emit.channel} ${JSON.stringify(emit.payload)}` : r.path === '/bus/subscribe' ? `subscribe ${JSON.stringify(r.json)}` : `${r.method} ${r.path} ${r.path === '/api/tokens/agent' ? JSON.stringify(r.json) : ''}`;
      return `    [${r.status ?? 'unanswered'}] ${what}`;
    });
    return ['  the worker asked the gateway:', ...wire, '  the worker wrote:', ...this.process.output.slice(-80).map((line) => `    ${line}`)].join('\n');
  }
}

/** Progress reports in a fixed order: by percentage, then by their text. */
export function sortedProgress(reports: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const key = (p: Record<string, unknown>) => `${String(p['percentage']).padStart(6, '0')} ${JSON.stringify(p)}`;
  return [...reports].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export class WorkerServiceWorld {
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
  /** What the Smelter answers `browse:anchored-text-requested` with, per resource: an `AnchoredTextAnswer`. One it has nothing for, it does not know. */
  readonly anchoredText = new Map<string, Record<string, unknown>>();
  /** Every `browse:anchored-text-requested` the Smelter received. */
  readonly anchoredTextReads: string[] = [];
  /** What the suite did wrong, as a party a worker meets: it must hand a worker nothing the spec does not allow. */
  readonly violations: string[] = [];
  /**
   * What a case has the suite's parties do instead of their plain answer.
   * `claim` answers a claim with a refusal. `handAnyJob` answers a claim with
   * the next job whatever the claim's filters: what no dispatcher does.
   * `commit` runs when a batch arrives and before it is acknowledged, and may
   * refuse it with a reason.
   */
  hooks: {
    claim?: () => { code?: string; message: string } | undefined;
    handAnyJob?: boolean;
    commit?: (commit: Commit) => Promise<{ refuse: string } | undefined> | { refuse: string } | undefined;
  } = {};

  private readonly served: Served[] = [];
  private peer!: { stream: BusStream; token: string; clientId: string };

  private constructor(
    readonly implementation: string,
    private readonly command: readonly string[],
    readonly world: World,
    readonly ollama: StandInOllama,
    /** The worker's service account, as the issuer knows it. */
    readonly env: WorkerEnvironment,
  ) {}

  static async create(implementation: string): Promise<WorkerServiceWorld> {
    const command = inject('workerServices')[implementation];
    if (!command) throw new Error(`harness/paths.ts names no Worker service ${implementation}`);
    const secret = randomBytes(24).toString('hex');
    const world = await World.create('in-process', { accounts: { [WORKER_CLIENT]: { secret, roles: [SERVICE_ROLE, WORKER_ROLE] } } });
    const ollama = await startOllama();
    const made = new WorkerServiceWorld(implementation, command, world, ollama, { SEMIONT_OIDC_CLIENT_ID: WORKER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secret });
    made.peer = await world.responder(
      ['job:claim', 'browse:resource-requested', 'mark:commit', 'browse:annotation-requested', 'browse:anchored-text-requested'],
      (frame) => made.answer(frame),
    );
    return made;
  }

  // ── who the worker works as ──────────────────────────────────────────────

  /**
   * The agents a case's worker works as: the Ollama pairs of
   * principals/cases.json under this knowledge base, each with the DID and
   * name the gateway must give it.
   */
  get agents(): WorkerAgent[] {
    const found = principals(this.world.kb.domain).agents.flatMap((a): WorkerAgent[] => (a.provider === 'ollama' ? [{ provider: 'ollama', model: a.model, did: a.did, name: a.name }] : []));
    if (found.length < 2) throw new Error('principals/cases.json needs two ollama agents under the suite\'s knowledge base');
    return found;
  }

  /** The `generator` a worker working as `agent` states on what it makes. */
  generator(agent: WorkerAgent = this.agents[0]!): Record<string, unknown> {
    return { '@type': 'Software', '@id': agent.did, name: agent.name, provider: agent.provider, model: agent.model };
  }

  // ── the document a worker is started with ────────────────────────────────

  /**
   * A worker's configuration document: one agent, the first, serving every
   * job on the stand-in Ollama, unless `agents` says otherwise. It names
   * `gatewayUrl`, which `start` points at its recording proxy.
   */
  async settings(gatewayUrl: string, agents?: AgentEntry[]): Promise<WorkerSettings> {
    const first = this.agents[0]!;
    return {
      gatewayUrl,
      identity: { issuer: this.world.issuer.origin },
      agents: agents ?? [{ agent: { provider: first.provider, model: first.model }, accepts: everyJob(), baseUrl: this.ollama.origin }],
      port: await freePort(),
      logLevel: 'info',
      logFormat: 'json',
    };
  }

  /** An entry of `agents`: `agent`, serving `accepts`, on the stand-in Ollama. */
  entry(agent: WorkerAgent, accepts: JobFilter[]): AgentEntry {
    return { agent: { provider: agent.provider, model: agent.model }, accepts, baseUrl: this.ollama.origin };
  }

  /** A launch as `start` makes it, for a case that must change it: the gateway is dialled directly. */
  async launch(change: Partial<Omit<WorkerLaunch, 'command'>> = {}): Promise<WorkerLaunch> {
    return { command: this.command, settings: await this.settings(this.world.origin), env: this.env, ...change };
  }

  /** Start a worker that must refuse to start: its exit code and what it wrote. */
  async refused(change: Partial<Omit<WorkerLaunch, 'command'>> = {}): Promise<{ code: number | null; output: string; stderr: string }> {
    return refusedWorkerBoot(await this.launch(change));
  }

  /** Start a worker behind a recording proxy and wait for its health. It is stopped when the case ends. */
  async start(options: { agents?: AgentEntry[]; env?: WorkerEnvironment; unlisted?: Record<string, string>; settings?: Partial<WorkerSettings> } = {}): Promise<Served> {
    const proxy = await startClientProxy(this.world.origin);
    try {
      const process = await startWorkerService({
        command: this.command,
        settings: { ...(await this.settings(proxy.origin, options.agents)), ...options.settings },
        env: { ...this.env, ...options.env },
        ...(options.unlisted ? { unlisted: options.unlisted } : {}),
      });
      const served = new Served(process, proxy);
      this.served.push(served);
      return served;
    } catch (error) {
      await proxy.close();
      throw error;
    }
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
      case 'browse:resource-requested': {
        this.descriptorReads.push(resourceId);
        const resource = this.descriptors.get(resourceId);
        if (!resource) return { channel: 'browse:resource-failed', payload: { code: 'not-found', message: `Resource not found: ${resourceId}` } };
        return { channel: 'browse:resource-result', payload: { response: { resource, annotations: [], entityReferences: [] } } };
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
        return { channel: 'mark:commit-ok', payload: { response: { persisted: fresh.length, annotationIds: annotations.map((a) => a.id) } } };
      }
      case 'browse:annotation-requested': {
        const annotation = (this.recorded.get(resourceId) ?? []).find((a) => a.id === payload['annotationId']);
        if (!annotation) return { channel: 'browse:annotation-failed', payload: { code: 'not-found', message: `Annotation not found: ${String(payload['annotationId'])}` } };
        return { channel: 'browse:annotation-result', payload: { response: { annotation, resource: null, resolvedResource: null } } };
      }
      case 'browse:anchored-text-requested': {
        this.anchoredTextReads.push(resourceId);
        const result = { response: this.anchoredText.get(resourceId) ?? { kind: 'unknown' } };
        const validate = spec().component('BrowseAnchoredTextResult');
        if (!validate(result)) this.violations.push(`the case has the Smelter answer what no Smelter does (${errorsOf(validate)})`);
        return { channel: 'browse:anchored-text-result', payload: result };
      }
      default:
        this.violations.push(`the suite was sent ${frame.channel}, which it does not answer`);
        return undefined;
    }
  }

  // ── the end of a case ────────────────────────────────────────────────────

  /** What a failing case shows: every worker's transcript, and what its provider was asked. */
  account(): string {
    return [
      ...this.served.map((s) => s.account()),
      '  the stand-in Ollama was asked:',
      ...this.ollama.generations.map((g) => `    ${JSON.stringify(g.body)}${g.abandoned ? ' (abandoned)' : ''}`),
      '  the record was committed:',
      ...this.commits.map((c) => `    ${JSON.stringify(c)}`),
      '  the dispatcher was claimed from:',
      ...this.claims.map((c) => `    ${JSON.stringify(c)}`),
    ].join('\n');
  }

  /**
   * Stop every worker the case started and forget what the case scripted.
   * Returns what went wrong that no case may let pass: a request of the
   * gateway that it refused, a request of the provider no case scripted, a
   * frame or an Archivist call outside the spec, and anything the suite itself
   * handed a worker outside the spec.
   */
  async settle(allowRefusedRequests = false): Promise<string[]> {
    const violations: string[] = [];
    for (const served of this.served.splice(0)) {
      if (!allowRefusedRequests) violations.push(...served.refused());
      await served.process.stop();
      await served.proxy.close();
    }
    violations.push(...this.ollama.violations.splice(0), ...this.violations.splice(0), ...this.world.drain());
    this.ollama.reset();
    this.queue.length = 0;
    this.claims.length = 0;
    this.descriptors.clear();
    this.descriptorReads.length = 0;
    this.commits.length = 0;
    this.recorded.clear();
    this.anchoredText.clear();
    this.anchoredTextReads.length = 0;
    this.hooks = {};
    this.world.archivist.uploads.length = 0;
    this.world.archivist.calls.length = 0;
    this.world.archivist.mode.refuseUploads = undefined;
    return violations;
  }

  async close(): Promise<void> {
    await this.settle(true);
    await this.ollama.close();
    await this.world.close();
  }
}

/**
 * Run `body`'s cases against each implementation of the Worker service, each
 * in a world of its own. A case starts the workers it needs; they are stopped
 * when it ends, and it fails, whatever it was about, if a worker asked the
 * gateway for something the gateway refused, asked its provider for something
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
    afterEach(async (context) => {
      // A failing case shows what the worker sent and wrote while it ran.
      if (context.task.result?.state === 'fail') console.error(`${context.task.name}\n${world?.account()}\ngateway output:\n${world?.world.gateway.output.join('\n')}`);
      expect((await world?.settle(options.allowRefusedRequests)) ?? []).toEqual([]);
    });
    body(() => world!);
  });
}
