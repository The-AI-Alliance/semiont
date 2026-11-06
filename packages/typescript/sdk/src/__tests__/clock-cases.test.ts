/**
 * The time a client keeps, against protocol/specs/src/client/clock-cases.json.
 *
 * Each case builds its subject over a network faked in this process, under
 * vitest's fake timers, at this SDK's timings, which are the table's, and with
 * `Math.random` giving the lowest draw it can, 0. A `pass` moves the fake clock
 * to each instant a timer falls due, in turn, and runs what falls due there,
 * so a wait ends at the instant it was set to end, or the case fails. What the
 * table may say is held by .github/scripts/checks/specs/check-case-tables.mjs.
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BehaviorSubject, type Observable } from 'rxjs';
import {
  accessToken,
  annotationId,
  baseUrl,
  jobId,
  resourceId,
  userId,
  watched,
  type AccessToken,
  type BusOperationKey,
  type DiscoveredKB,
  type EventMap,
  type HttpEndpoint,
  type JobFilter,
} from '@semiont/core';
import { APIError, HttpTransport } from '@semiont/http-transport';
import { createCache, type CachePersister } from '../cache';
import type { HeldJob } from '../claims';
import { subscribeDiscovery, type DiscoveryReadResult, type DiscoveryTransport } from '../discovery';
import { httpKb } from '../session/knowledge-base';
import { signInWithDeviceGrant } from '../session/oauth';
import { SemiontSession, type UserInfo } from '../session/semiont-session';
import { InMemorySessionStorage } from '../session/session-storage';
import { setStoredSession } from '../session/storage';
import { createTestClient, refuseUnscriptedOperation, type FaultyTransport } from '../testing';
import { mockAnnotation } from './fixtures/annotation';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

interface Case {
  subject: string;
  case: string;
  given?: JsonObject;
  steps: Json[];
}

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../../../../protocol/specs/src/${path}`, import.meta.url), 'utf8'));

const TABLE = read('client/clock-cases.json') as { cases: Case[] };
const TIMING = new Map(
  (read('client/timing.json') as { timing: Array<{ name: string; value: Json }> }).timing.map(({ name, value }) => [name, value]),
);

/**
 * How many turns a settle lets pass. Each hands control to the runtime once,
 * which runs every promise callback that is ready, and then runs every timer
 * due at the clock's instant and what those make ready at it. More than one
 * leaves room for work that waits on the runtime's own queue more than once.
 */
const SETTLE_TURNS = 20;

/** Let what is ready run, and what that makes ready, without moving the clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await vi.advanceTimersByTimeAsync(0);
}

// ── Reading the table ───────────────────────────────────────────────────

function text(value: Json | undefined, what: string): string {
  if (typeof value !== 'string') throw new Error(`${what} is not a string: ${JSON.stringify(value)}`);
  return value;
}

function object(value: Json | undefined, what: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is not an object: ${JSON.stringify(value)}`);
  return value;
}

function count(value: Json | undefined, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what} is not a number: ${JSON.stringify(value)}`);
  return value;
}

function strings(value: Json | undefined, what: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not a list: ${JSON.stringify(value)}`);
  return value.map((item) => text(item, what));
}

/** A duration protocol/specs/src/client/timing.json names. A retry budget's member follows its budget and a `.`. */
function timingMs(name: string): number {
  const [budget, ...member] = name.split('.');
  const kept = TIMING.get(text(budget, 'a timing'));
  if (kept === undefined) throw new Error(`${name} is no timing of protocol/specs/src/client/timing.json`);
  if (member.length === 0) return count(kept, name);
  if (member.length > 1) throw new Error(`${name} names a member of a member`);
  return count(object(kept, budget)[text(member[0], 'a member')], name);
}

/** A duration as the table states it, in milliseconds: a whole number of them. */
function durationMs(value: Json | undefined): number {
  if (typeof value === 'number') return value;
  const stated = object(value, 'a duration');
  const times = stated['times'] === undefined ? 1 : count(stated['times'], 'times');
  const plus = stated['plusMs'] === undefined ? 0 : count(stated['plusMs'], 'plusMs');
  const ms = timingMs(text(stated['timing'], 'a timing')) * times + plus;
  if (!Number.isInteger(ms)) throw new Error(`${JSON.stringify(value)} is not a whole number of milliseconds`);
  return ms;
}

/** A span of seconds the case's `given` states, when it states one. */
function givenSeconds(given: JsonObject | undefined, name: string): number | undefined {
  const value = given?.[name];
  return value === undefined ? undefined : count(value, `given.${name}`);
}

const said = (error: unknown): string => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

// ── What a case drives ──────────────────────────────────────────────────

/** What a case drives: what it counts, and its action, when it has one. */
interface Subject {
  counted(): number;
  act?(): Promise<void>;
}

/**
 * What a case holds while it runs: what is let go once it is over, and what
 * ended that was to go on, or happened that the subject does not have
 * happen, which fails the next count.
 */
class Held {
  readonly wrong: string[] = [];
  private readonly releases: Array<() => void> = [];

  /** `release` is done once the case is over, before what was held before it. */
  later(release: () => void): void {
    this.releases.push(release);
  }

  /** `work`, which is to go on for as long as the case does. */
  running(work: Promise<unknown>, what: string): void {
    work.then(
      () => this.wrong.push(`${what} ended`),
      (error: unknown) => this.wrong.push(`${what} failed: ${said(error)}`),
    );
  }

  /** `values` read for as long as the case goes on, which they are to do. */
  reading(values: Observable<unknown>, what: string): void {
    const reader = values.subscribe({
      error: (error: unknown) => this.wrong.push(`${what} failed: ${said(error)}`),
      complete: () => this.wrong.push(`${what} ended`),
    });
    this.later(() => reader.unsubscribe());
  }

  release(): void {
    for (const release of this.releases.reverse()) release();
  }
}

type Build = (given: JsonObject | undefined, held: Held) => Promise<Subject>;

// ── The gateway ─────────────────────────────────────────────────────────

const GATEWAY = 'http://gateway.test';
const SUBSCRIBE = '/bus/subscribe';
const EMIT = '/bus/emit';
const HEALTH = '/api/health';
type GatewayPath = typeof SUBSCRIBE | typeof EMIT | typeof HEALTH;

/** How a gateway answers a subscribe: with a stream it holds open, with a 503, or not at all. */
type StreamAnswer = 'holds' | 'refuses' | 'never';

/** Where a request goes, and the signal it was made under, however `fetch` was called. */
function requestOf(input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]): { url: URL; signal: AbortSignal | null | undefined } {
  if (input instanceof Request) return { url: new URL(input.url), signal: input.signal };
  return { url: new URL(input instanceof URL ? input.href : input), signal: init?.signal };
}

/** An answer that never comes: the request waits until its signal is aborted, and fails with why. */
function neverAnswered(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_answer, fail) => {
    signal?.addEventListener('abort', () => fail(signal.reason), { once: true });
  });
}

/** The body of a stream a gateway holds open and says nothing on. Its reader closes it by aborting its request. */
function heldOpen(signal: AbortSignal | null | undefined, closed: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(body) {
      signal?.addEventListener(
        'abort',
        () => {
          closed();
          body.error(signal.reason);
        },
        { once: true },
      );
    },
  });
}

const json = (status: number, body: Json, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** A gateway in this process. It answers each request at once, as the subject has it answer, and counts what it is asked. */
class Gateway {
  /** How many requests of each path it has been asked. */
  readonly asked: Record<GatewayPath, number> = { [SUBSCRIBE]: 0, [EMIT]: 0, [HEALTH]: 0 };
  /** How many of the streams it held open their readers have closed. */
  closed = 0;

  constructor(
    private readonly held: Held,
    private readonly stream: StreamAnswer,
    private readonly unanswered: ReadonlySet<GatewayPath>,
    private readonly retryAfterSeconds?: number,
  ) {}

  readonly fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const { url, signal } = requestOf(input, init);
    const path = url.pathname;
    if (path !== SUBSCRIBE && path !== EMIT && path !== HEALTH) {
      this.held.wrong.push(`the gateway was asked ${path}, which this subject does not have it answer`);
      return neverAnswered(signal);
    }
    this.asked[path] += 1;
    if (this.unanswered.has(path)) return neverAnswered(signal);
    if (path !== SUBSCRIBE) {
      this.held.wrong.push(`the gateway was asked ${path}, which this subject does not have it answer`);
      return neverAnswered(signal);
    }
    switch (this.stream) {
      case 'holds':
        return new Response(heldOpen(signal, () => { this.closed += 1; }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      case 'refuses':
        return json(503, { error: 'The gateway is not ready' }, this.retryAfterSeconds === undefined ? {} : { 'retry-after': String(this.retryAfterSeconds) });
      case 'never':
        return neverAnswered(signal);
    }
  };

  /** A transport to this gateway, holding a token, so its stream is set going. */
  transport(): HttpTransport {
    const transport = new HttpTransport({
      baseUrl: baseUrl(GATEWAY),
      token$: watched(new BehaviorSubject<AccessToken | null>(accessToken('a-token'))),
      fetch: this.fetch,
    });
    this.held.later(() => transport.dispose());
    return transport;
  }
}

const RESOURCE = resourceId('res-1');

async function refusedStream(given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'refuses', new Set(), givenSeconds(given, 'retryAfterSeconds'));
  gateway.transport();
  return { counted: () => gateway.asked[SUBSCRIBE] };
}

async function unansweredStream(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'never', new Set());
  gateway.transport();
  return { counted: () => gateway.asked[SUBSCRIBE] };
}

async function degradedStream(given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'refuses', new Set(), givenSeconds(given, 'retryAfterSeconds'));
  let degraded = 0;
  const watching = gateway.transport().state$.subscribe((state) => {
    if (state === 'degraded') degraded += 1;
  });
  held.later(() => watching.unsubscribe());
  return { counted: () => degraded };
}

async function scopeTaken(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'holds', new Set());
  const transport = gateway.transport();
  return {
    counted: () => gateway.asked[SUBSCRIBE],
    act: async () => held.later(transport.subscribeToResource(RESOURCE)),
  };
}

async function scopeLetGo(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'holds', new Set());
  const transport = gateway.transport();
  let state: string | undefined;
  const watching = transport.state$.subscribe((now) => {
    state = now;
  });
  held.later(() => watching.unsubscribe());
  await settle();
  if (state !== 'open') throw new Error(`the stream did not open: it is ${state}`);
  const letGo = transport.subscribeToResource(RESOURCE);
  return { counted: () => gateway.asked[SUBSCRIBE], act: async () => letGo() };
}

async function handoffLinger(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'holds', new Set());
  const transport = gateway.transport();
  return {
    counted: () => gateway.closed,
    act: async () => held.later(transport.subscribeToResource(RESOURCE)),
  };
}

async function unansweredRequest(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'holds', new Set([HEALTH]));
  let failed = 0;
  gateway.transport().healthCheck().then(
    () => held.wrong.push('the health check was answered'),
    (error: unknown) => {
      if (error instanceof APIError && error.status === 0) failed += 1;
      else held.wrong.push(`the health check failed otherwise: ${said(error)}`);
    },
  );
  return { counted: () => failed };
}

async function unansweredEmit(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const gateway = new Gateway(held, 'holds', new Set([EMIT]));
  held.running(gateway.transport().emit('beckon:hover', { annotationId: annotationId('ann-1') }), 'the emit');
  return { counted: () => gateway.asked[EMIT] };
}

// ── The issuer ──────────────────────────────────────────────────────────

const KB_TARGET: HttpEndpoint = { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' };
const KB_GATEWAY = 'http://localhost:4000';
const ISSUER = 'http://issuer.test/realms/semiont';

/**
 * A knowledge base that trusts an issuer, and the issuer, in this process:
 * what a device grant asks. It mints a code that lives 900 seconds, with the
 * interval the case states, and answers each ask of its token endpoint with
 * the next of `answers`, the last repeating.
 */
class Issuer {
  tokenAsks = 0;

  constructor(
    private readonly held: Held,
    private readonly intervalSeconds: number | undefined,
    private readonly answers: readonly string[],
  ) {
    if (answers.length === 0) throw new Error('the token endpoint has answers');
  }

  readonly fetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const { url, signal } = requestOf(input, init);
    const where = `${url.origin}${url.pathname}`;
    switch (where) {
      case `${KB_GATEWAY}/.well-known/oauth-protected-resource`:
        return json(200, { resource: KB_GATEWAY, authorization_servers: [ISSUER], bearer_methods_supported: ['header'] });
      case `${ISSUER}/.well-known/openid-configuration`:
        return json(200, {
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          device_authorization_endpoint: `${ISSUER}/device`,
        });
      case `${ISSUER}/device`:
        return json(200, {
          device_code: 'the-device-code',
          user_code: 'WDJB-MJHT',
          verification_uri: 'http://issuer.test/device',
          expires_in: 900,
          ...(this.intervalSeconds === undefined ? {} : { interval: this.intervalSeconds }),
        });
      case `${ISSUER}/token`: {
        const answer = text(this.answers[Math.min(this.tokenAsks, this.answers.length - 1)], 'an answer');
        this.tokenAsks += 1;
        return json(400, { error: answer });
      }
      default:
        this.held.wrong.push(`the issuer was asked ${where}, which a device grant does not ask`);
        return neverAnswered(signal);
    }
  };
}

async function deviceGrant(given: JsonObject | undefined, held: Held): Promise<Subject> {
  const issuer = new Issuer(held, givenSeconds(given, 'intervalSeconds'), strings(given?.['answers'], 'given.answers'));
  const abandoned = new AbortController();
  held.later(() => abandoned.abort());
  held.running(signInWithDeviceGrant({ target: KB_TARGET, onCode: () => {}, signal: abandoned.signal, fetch: issuer.fetch }), 'the sign-in');
  return { counted: () => issuer.tokenAsks };
}

// ── A session ───────────────────────────────────────────────────────────

const KB = httpKb({ id: 'kb-alpha', label: 'Alpha', host: 'localhost', port: 4000, protocol: 'http' });
const ALICE: UserInfo = { did: userId('did:web:example.org:users:alice'), email: 'alice@example.org', name: 'Alice', image: null, domain: 'example.org' };

const segment = (value: Json): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A token issued now, by the wall clock, that lives `lifetimeSeconds`, told from every other by `n`. Nothing signs it. */
function token(lifetimeSeconds: number, n: number): string {
  const issued = Math.floor(Date.now() / 1000);
  return `${segment({ alg: 'RS256', typ: 'JWT' })}.${segment({ iat: issued, exp: issued + lifetimeSeconds, n })}.${segment('signature')}`;
}

async function renewal(given: JsonObject | undefined, held: Held): Promise<Subject> {
  const lifetime = givenSeconds(given, 'lifetimeSeconds');
  if (lifetime === undefined) throw new Error("a renewal's case states how long its tokens live");
  let renewals = 0;
  const storage = new InMemorySessionStorage();
  setStoredSession(storage, KB.id, { access: token(lifetime, 0), refresh: 'a-refresh-token', clientId: 'semiont-cli', tokenEndpoint: `${ISSUER}/token` });
  const { client } = createTestClient();
  const session = new SemiontSession({
    kb: KB,
    storage,
    client,
    token$: new BehaviorSubject<AccessToken | null>(null),
    refresh: async () => {
      renewals += 1;
      return token(lifetime, renewals);
    },
    validate: async () => ALICE,
  });
  held.later(() => client.dispose());
  held.later(() => session.dispose());
  return { counted: () => renewals };
}

// ── A worker's claims ───────────────────────────────────────────────────

const MARK_JOBS: JobFilter[] = [{ jobType: 'mark', params: { motivation: 'highlighting' } }];

const CLAIMED: EventMap['job:claimed']['response'] = {
  status: 'running',
  metadata: {
    id: jobId('job-1'),
    type: 'mark',
    userId: userId('did:web:example.org:users:alice'),
    created: '2026-10-01T00:00:00.000Z',
    retryCount: 0,
    maxRetries: 1,
  },
  params: { resourceId: RESOURCE },
  startedAt: '2026-10-01T00:00:01.000Z',
  progress: {},
};

/** What a subject's transport answers: each operation `answers` names, and none other, which is told. */
function answering(held: Held, answers: Partial<Record<BusOperationKey, (payload: Record<string, unknown>) => unknown>>) {
  return (operation: BusOperationKey, payload: Record<string, unknown>): unknown => {
    const answer = answers[operation];
    if (answer !== undefined) return answer(payload);
    held.wrong.push(`the transport was asked ${operation}, which this subject does not have it answer`);
    return refuseUnscriptedOperation(operation);
  };
}

async function heldJobStall(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const { client } = createTestClient({ transport: { makeResponse: answering(held, { 'job:claim': () => CLAIMED }) } });
  held.later(() => client.dispose());
  const claims = client.job.claim({ accepts: MARK_JOBS });
  let job: HeldJob | undefined;
  let stalls = 0;
  const stalled = claims.stalled$.subscribe(() => {
    stalls += 1;
  });
  const claiming = claims.subscribe((claimed) => {
    job = claimed;
  });
  held.later(() => claiming.unsubscribe());
  held.later(() => stalled.unsubscribe());
  await settle();
  const claimed = job;
  if (claimed === undefined) throw new Error('no job was claimed');
  return {
    counted: () => stalls,
    act: () => claimed.progress({ percentage: 50 }),
  };
}

// ── Discovery ───────────────────────────────────────────────────────────

const MANAGED: DiscoveredKB = { host: 'localhost', port: 4000, placement: 'local', managedBy: 'semiont-launcher', did: 'did:web:example.org:kb-a' };

/** A launcher's document: one managed knowledge base at the first read, and unchanged at every read after it. */
class LauncherDocument implements DiscoveryTransport {
  reads = 0;

  async read(): Promise<DiscoveryReadResult> {
    this.reads += 1;
    return this.reads === 1 ? { kind: 'managed', kbs: [MANAGED] } : { kind: 'unchanged' };
  }
}

async function discovery(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const document = new LauncherDocument();
  held.reading(subscribeDiscovery(document, { intervalMs: timingMs('discoveryIntervalMs') }), 'discovery');
  return { counted: () => document.reads };
}

// ── A client's queries and caches ───────────────────────────────────────

const asked = (transport: FaultyTransport, operation: BusOperationKey): number =>
  transport.requestLog.filter((request) => request.channel === operation).length;

const MARK_ADDED: EventMap['mark:added'] = {
  id: 'evt-1',
  type: 'mark:added',
  resourceId: RESOURCE,
  userId: userId('did:web:example.org:users:alice'),
  version: 1,
  timestamp: '2026-10-01T00:00:00.000Z',
  payload: { annotation: mockAnnotation('ann-1') },
  metadata: { sequenceNumber: 1 },
};

async function invalidationWindow(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const { client, transport } = createTestClient({
    transport: {
      makeResponse: answering(held, { 'browse:events-requested': (payload) => ({ events: [], total: 0, resourceId: payload['resourceId'] }) }),
    },
  });
  held.later(() => client.dispose());
  held.reading(client.browse.events(RESOURCE), 'the events query');
  return {
    counted: () => asked(transport, 'browse:events-requested'),
    // As the HTTP transport's bridge publishes a frame of a resource's scope: the test transport bridges no scope.
    act: async () => {
      client.bus.emit('mark:added', MARK_ADDED, { scope: RESOURCE });
    },
  };
}

/** A cache's storage: it keeps nothing to begin with, and records each save. */
class Saves implements CachePersister<string, number> {
  readonly saved: Array<Map<string, number>> = [];

  load(): Map<string, number> | null {
    return null;
  }

  save(entries: Map<string, number>): void {
    this.saved.push(new Map(entries));
  }
}

async function saveDebounce(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const saves = new Saves();
  const cache = createCache<string, number>(
    async (key) => {
      throw new Error(`a cache that is only written fetched ${key}`);
    },
    { persister: saves },
  );
  held.later(() => cache.dispose());
  let changes = 0;
  return {
    counted: () => saves.saved.length,
    act: async () => {
      changes += 1;
      cache.set('a key', changes);
    },
  };
}

const JOB_RUNNING = {
  jobId: 'job-1',
  type: 'mark',
  status: 'running',
  userId: 'did:web:example.org:users:alice',
  created: '2026-10-01T00:00:00.000Z',
};

const PROGRESSED: EventMap['job:report-progress'] = {
  resourceId: RESOURCE,
  jobId: jobId('job-1'),
  jobType: 'mark',
  percentage: 10,
  progress: { percentage: 10 },
};

async function jobFollower(_given: JsonObject | undefined, held: Held): Promise<Subject> {
  const { client, transport } = createTestClient({
    transport: { makeResponse: answering(held, { 'job:create': () => ({ jobId: 'job-1' }), 'job:status-requested': () => JOB_RUNNING }) },
  });
  held.later(() => client.dispose());
  held.reading(client.mark.delegate(RESOURCE, { motivation: 'highlighting' }), "the job's follower");
  return {
    counted: () => asked(transport, 'job:status-requested'),
    // The test transport hands what it is sent on a channel that is no request to the client's stream, as the wire does another participant's.
    act: async () => {
      await transport.emit('job:report-progress', PROGRESSED);
    },
  };
}

/** How this SDK builds each subject the table names. */
const SUBJECTS: Record<string, Build> = {
  refusedStream,
  unansweredStream,
  degradedStream,
  scopeTaken,
  scopeLetGo,
  handoffLinger,
  renewal,
  deviceGrant,
  heldJobStall,
  discovery,
  invalidationWindow,
  saveDebounce,
  jobFollower,
  unansweredRequest,
  unansweredEmit,
};

// ── A case, played ──────────────────────────────────────────────────────

/** Perform one step. Returns how far it moved the clock. */
async function perform(step: Json, subject: Subject, held: Held): Promise<number> {
  if (step === 'settle') {
    await settle();
    return 0;
  }
  if (step === 'act') {
    if (subject.act === undefined) throw new Error('the subject has no action');
    await subject.act();
    await settle();
    return 0;
  }
  const stated = object(step, 'a step');
  if ('pass' in stated) {
    const ms = durationMs(stated['pass']);
    if (ms < 0) throw new Error('a case passes no time backwards');
    await settle();
    await vi.advanceTimersByTimeAsync(ms);
    await settle();
    return ms;
  }
  if ('counted' in stated) {
    await settle();
    if (held.wrong.length > 0) throw new Error(held.wrong.join('; '));
    const counted = subject.counted();
    const stating = count(stated['counted'], 'counted');
    if (counted !== stating) throw new Error(`counted ${counted}, not ${stating}`);
    return 0;
  }
  throw new Error('no step this runner performs');
}

async function play(stated: Case): Promise<void> {
  const build = SUBJECTS[stated.subject];
  if (build === undefined) throw new Error(`this runner builds no ${stated.subject}`);
  const held = new Held();
  let atMs = 0;
  try {
    const subject = await build(stated.given, held);
    for (const [at, step] of stated.steps.entries()) {
      try {
        atMs += await perform(step, subject, held);
      } catch (broken) {
        throw new Error(`steps[${at}] ${JSON.stringify(step)}, at ${atMs} ms: ${said(broken)}`);
      }
    }
  } finally {
    held.release();
  }
}

// ── The tests ───────────────────────────────────────────────────────────

describe('the time a client keeps, against protocol/specs/src/client/clock-cases.json', () => {
  beforeEach(() => {
    // The microtasks the test transport answers on stay real; the clock is held.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('builds every subject the table names, and no other', () => {
    expect(new Set(Object.keys(SUBJECTS))).toEqual(new Set(TABLE.cases.map((stated) => stated.subject)));
  });

  it.each(TABLE.cases.map((stated) => [`${stated.subject}: ${stated.case}`, stated] as const))('%s', async (_name, stated) => {
    await play(stated);
  });

  it('fails a case whose wait ends a millisecond early', async () => {
    const first = TABLE.cases.find((stated) => stated.subject === 'refusedStream');
    if (first === undefined) throw new Error('the table has no case of refusedStream');
    const told: Case = structuredClone(first);
    // The last millisecond of the first wait: the case is told the stream was opened again in it.
    expect(told.steps[2]).toEqual({ counted: 1 });
    told.steps[2] = { counted: 2 };
    await expect(play(told)).rejects.toThrow(/steps\[2\]/);
  });
});
