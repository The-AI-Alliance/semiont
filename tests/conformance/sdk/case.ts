/**
 * Runs one case against one SDK's driver (README.md § A case). The client is
 * the driver's; the backend is the world's real gateway behind the client
 * proxy, with a participant the suite plays in place of the services.
 *
 * Beyond its steps, every case holds the client to four things it never has to
 * state: each request it sent is one the spec declares, with a body the spec
 * accepts; it sent nothing the case did not account for; the frames it
 * delivered on a channel are exactly the events the gateway sent it there,
 * once each and in order; and every failure it reported carries a code from
 * specs/src/errors/codes.json.
 *
 * The two layers account for the wire differently. A wire case reads it as a
 * transcript: every request, in order. A live case reads what the live
 * contract means on it: each request the client makes of a service (a
 * `fetch`), in order and none unaccounted, and the scopes its stream has come
 * to name. How many times it reopened the stream to get there is the wire
 * layer's to judge.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Ajv } from 'ajv';
import { storedEvent } from '../harness/archivist';
import { startClientProxy, type ClientProxy, type ProxiedRequest } from '../harness/client-proxy';
import type { Plane } from '../harness/gateway';
import { nonConformance, type Reply } from '../harness/http';
import { startOtlp } from '../harness/otlp';
import { SPEC_SOURCE } from '../harness/paths';
import { errorsOf, registry, spec, type Method } from '../harness/spec';
import { outsideTheSdkTable } from '../harness/telemetry';
import type { World } from '../harness/world';
import { Driver, type DeliveredFrame, type ObservedState, type Outcome, type ReportedFailure } from './driver';
import { Bindings } from './match';

const HERE = dirname(fileURLToPath(import.meta.url));

/** How long a step waits for what it expects. Never compared: a conforming client is not timed, only waited for. */
const WAIT_MS = 15_000;

/**
 * How much sooner than a stated `Retry-After` a client may return and still
 * have waited it: the two ends read different clocks, a timer's and the
 * proxy's, and a millisecond between them is not a client returning early.
 */
const WAIT_GRACE_MS = 100;

export type Step =
  | { let: Record<string, unknown> }
  | { driver: string; with?: Record<string, unknown>; returns?: unknown; fails?: unknown; as?: string }
  | { abandon: string }
  | { settles: string; returns?: unknown; fails?: unknown; abandoned?: true }
  | { wire: string; at?: 'arrival' | 'answer' | 'live'; status?: number; params?: unknown; body?: unknown; token?: unknown; answer?: unknown; as?: string; follows?: string; waited?: string }
  | { carried: string; is: unknown }
  | { state: string }
  | { stays: string }
  | { frame: string; is: unknown }
  | { frames: string; count: number }
  | { error: unknown }
  | { backend: string; with?: Record<string, unknown> }
  | { quiet: number }
  | { observe: Record<string, unknown>; as: string }
  | { leave: string }
  | { reaches: string; state: unknown }
  | { holds: string; state: unknown }
  | { completes: string }
  | { fetch: string; payload?: unknown; as: string }
  | { fetches: Array<{ fetch: string; payload?: unknown; as: string }> }
  | { scopes: unknown[] };

type FetchStep = { fetch: string; payload?: unknown; as: string };

/** A layer of the suite: the transport, or the client's live queries over it. */
export type Layer = 'wire' | 'live';

interface CaseDocument {
  about: string;
  source: string;
  planes?: Plane[];
  /** A live case's tier: what every live layer does, or what one at full parity does. */
  tier?: 'fleet' | 'parity';
  /** Run the client exporting, and hold what it exported to the SDK telemetry table. */
  telemetry?: true;
  steps: Step[];
}

export interface Case extends CaseDocument {
  /** Its file's name, without the extension. */
  name: string;
}

const validate = new Ajv({ allErrors: true }).compile<CaseDocument>(JSON.parse(readFileSync(join(HERE, 'case.schema.json'), 'utf8')) as object);

/** `document`, named, once case.schema.json accepts it. */
export function caseOf(name: string, document: unknown): Case {
  if (!validate(document)) throw new Error(`${name} is not a case: ${errorsOf(validate)}`);
  return { name, ...document };
}

/** Every case in `sdk/<layer>/`, each checked against case.schema.json. */
export function cases(layer: string): Case[] {
  const dir = join(HERE, layer);
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => caseOf(file.slice(0, -'.json'.length), JSON.parse(readFileSync(join(dir, file), 'utf8'))));
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The error codes a client may report, from the table every SDK generates its own from. */
function vocabulary(): Set<string> {
  const table: unknown = JSON.parse(readFileSync(join(SPEC_SOURCE, 'errors/codes.json'), 'utf8'));
  const codes = new Set<string>();
  if (isObject(table)) {
    for (const section of Object.values(table)) {
      if (!isObject(section) || !Array.isArray(section['codes'])) continue;
      for (const entry of section['codes']) if (isObject(entry) && typeof entry['code'] === 'string') codes.add(entry['code']);
    }
  }
  if (codes.size === 0) throw new Error('errors/codes.json lists no codes');
  return codes;
}

/** A request as a case reads it: the operation the spec declares for it, and what it carried. */
interface Seen {
  operation: string;
  params: Record<string, string>;
  body: unknown;
  token: string | undefined;
}

const sorted = (v: unknown): unknown => (Array.isArray(v) ? [...v].sort() : v);

/**
 * A subscription by what it means, not by how a client wrote it: an absent
 * list is an empty one, and the order of channels, scopes and awaited replies
 * carries nothing.
 */
function subscription(json: unknown): unknown {
  if (!isObject(json)) return json;
  const scoped = Array.isArray(json['scoped']) ? json['scoped'] : [];
  return {
    clientId: json['clientId'],
    global: sorted(json['global'] ?? []),
    scoped: scoped
      .map((entry: unknown) => (isObject(entry) ? { ...entry, channels: sorted(entry['channels']) } : entry))
      .sort((a: unknown, b: unknown) => {
        const [left, right] = [a, b].map((entry) => String(isObject(entry) ? entry['scope'] : entry));
        return left! < right! ? -1 : left! > right! ? 1 : 0;
      }),
    pendingReplies: sorted(json['pendingReplies'] ?? []),
  };
}

/** The operation the spec declares for a request, and the values its path carried. */
function declared(method: string, path: string): { method: Method; template: string; params: Record<string, string> } | undefined {
  const pathname = path.split('?')[0]!;
  for (const operation of spec().operations()) {
    if (operation.method !== method.toLowerCase()) continue;
    const names: string[] = [];
    const pattern = new RegExp(`^${operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => (names.push(name), '([^/]+)'))}$`);
    const found = pattern.exec(pathname);
    if (found) return { method: operation.method, template: operation.path, params: Object.fromEntries(names.map((name, i) => [name, decodeURIComponent(found[i + 1]!)])) };
  }
  return undefined;
}

const operationName = (method: string, template: string): string => `${method.toUpperCase()} ${template}`;

class Run {
  private readonly bindings = new Bindings();
  private readonly codes = vocabulary();
  /** What the client did outside the spec, whatever the case was about. */
  private readonly problems: string[] = [];
  private wireCursor = 0;
  /** In a live case: how many of the client's emits its `fetch` steps have accounted for. */
  private fetchCursor = 0;
  /** In a live case: for each observer, how many of its states the case has read. */
  private readonly emissionCursor = new Map<string, number>();
  private stateCursor = 0;
  private failureCursor = 0;
  private readonly frameCursor = new Map<string, number>();
  /** Operations started with `as`, by name. */
  private readonly pending = new Map<string, { id: number; op: string }>();
  /** Requests a wire step named, by name. */
  private readonly named = new Map<string, ProxiedRequest>();
  /** For each channel the client listens to, the proxy's clock when it began. */
  private readonly listening = new Map<string, number>();

  constructor(
    private readonly layer: Layer,
    private readonly world: World,
    private readonly proxy: ClientProxy,
    private readonly driver: Driver,
    private readonly participant: { token: string; clientId: string },
    private readonly client: string,
  ) {}

  bind(name: string, value: unknown): void {
    this.bindings.bind(name, value);
  }

  // ── reading a request ────────────────────────────────────────────────────

  private read(record: ProxiedRequest): Seen {
    const operation = declared(record.method, record.path);
    const bearer = record.headers.authorization;
    const token = bearer?.startsWith('Bearer ') ? bearer.slice('Bearer '.length) : undefined;
    if (!operation) {
      this.problems.push(`${record.method} ${record.path}, which the spec does not declare`);
      return { operation: `${record.method} ${record.path}`, params: {}, body: record.json, token };
    }
    const name = operationName(operation.method, operation.template);
    const content = (spec().deref(spec().operation(operation.method, operation.template)['requestBody']) as { content?: Record<string, { schema?: unknown }> } | undefined)?.content;
    const schema = content?.['application/json']?.schema;
    if (schema !== undefined) {
      const validate = spec().validator(schema as never);
      if (!validate(record.json)) this.problems.push(`a ${name} whose body the spec does not accept (${errorsOf(validate)}): ${JSON.stringify(record.json)}`);
    }
    return { operation: name, params: operation.params, body: name === 'POST /bus/subscribe' ? subscription(record.json) : record.json, token };
  }

  private matcher(what: string): (record: ProxiedRequest) => boolean {
    return (record) => {
      const operation = declared(record.method, record.path);
      return operation !== undefined && operationName(operation.method, operation.template) === what;
    };
  }

  // ── the steps ────────────────────────────────────────────────────────────

  async step(step: Step): Promise<void> {
    if ('let' in step) {
      for (const [name, value] of Object.entries(step.let)) this.bindings.bind(name, this.bindings.resolve(value));
    } else if ('driver' in step) {
      await this.operate(step);
    } else if ('abandon' in step) {
      const started = this.pending.get(step.abandon);
      if (!started) throw new Error(`no operation was started as ${step.abandon}`);
      const id = this.driver.send('abandon', { request: started.id });
      this.judge('abandon', await this.driver.outcome(id, 'abandon to settle', WAIT_MS), {});
    } else if ('settles' in step) {
      const started = this.pending.get(step.settles);
      if (!started) throw new Error(`no operation was started as ${step.settles}`);
      this.pending.delete(step.settles);
      this.judge(started.op, await this.driver.outcome(started.id, `${started.op} (${step.settles}) to settle`, WAIT_MS), step);
    } else if ('wire' in step) {
      await this.wire(step);
    } else if ('carried' in step) {
      const stream = this.named.get(step.carried);
      if (!stream) throw new Error(`no request was named ${step.carried}`);
      let difference: string | undefined;
      await this.proxy.until(`the stream ${step.carried} to carry that frame`, () => {
        for (const event of stream.events) {
          if (event.event !== 'bus-event') continue;
          difference = this.bindings.match(step.is, JSON.parse(event.data));
          if (difference === undefined) return true;
        }
        return undefined;
      }, WAIT_MS).catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}${difference === undefined ? ': it carried no frames' : `; the last it carried differs: ${difference}`}`);
      });
    } else if ('reaches' in step) {
      await this.reaches(step.reaches, step.state);
    } else if ('holds' in step) {
      await this.sync();
      const states = this.driver.emissions.get(step.holds) ?? [];
      const latest = states.at(-1);
      if (!latest) throw new Error(`${step.holds} has reported no state`);
      const difference = this.bindings.match(step.state, this.observed(latest));
      if (difference !== undefined) throw new Error(`${step.holds} no longer holds that state: ${difference}`);
      this.emissionCursor.set(step.holds, states.length);
    } else if ('state' in step) {
      const at = await this.driver.until(`the state ${step.state} (reported since: ${this.driver.states.slice(this.stateCursor).join(', ') || 'none'})`, () => {
        const index = this.driver.states.indexOf(step.state, this.stateCursor);
        return index < 0 ? undefined : index;
      }, WAIT_MS);
      this.stateCursor = at + 1;
    } else if ('stays' in step) {
      await this.sync();
      const since = this.driver.states.slice(this.stateCursor);
      if (since.length > 0) throw new Error(`the transport did not stay ${step.stays}: since the case last read its state it reported ${since.join(', ')}`);
      if (this.driver.states.at(-1) !== step.stays) throw new Error(`the transport is ${this.driver.states.at(-1) ?? 'in no state'}, not ${step.stays}`);
    } else if ('frames' in step) {
      const cursor = this.frameCursor.get(step.frames) ?? 0;
      await this.driver.until(`${step.count} more frames on ${step.frames}`, () => ((this.driver.frames.get(step.frames)?.length ?? 0) >= cursor + step.count ? true : undefined), WAIT_MS);
      this.frameCursor.set(step.frames, cursor + step.count);
    } else if ('frame' in step) {
      const cursor = this.frameCursor.get(step.frame) ?? 0;
      const frame = await this.driver.until(`a frame on ${step.frame}`, () => this.driver.frames.get(step.frame)?.[cursor], WAIT_MS);
      this.frameCursor.set(step.frame, cursor + 1);
      const difference = this.bindings.match(step.is, frame);
      if (difference !== undefined) throw new Error(`the next frame on ${step.frame} differs: ${difference}`);
    } else if ('error' in step) {
      const cursor = this.failureCursor;
      const { failure, detail } = await this.driver.until('a failure on the error stream', () => this.driver.failures[cursor], WAIT_MS);
      this.failureCursor++;
      this.inVocabulary(failure, detail);
      const difference = this.bindings.match(step.error, failure);
      if (difference !== undefined) throw new Error(`the next failure on the error stream differs: ${difference} (${detail})`);
    } else if ('backend' in step) {
      await this.backend(step.backend, this.bindings.resolve(step.with ?? {}) as Record<string, unknown>);
    } else if ('quiet' in step) {
      await new Promise((resolve) => setTimeout(resolve, step.quiet));
      this.nothingUnaccounted(`within ${step.quiet} ms`);
    } else if ('observe' in step) {
      const id = this.driver.send('observe', { observer: step.as, query: this.bindings.resolve(step.observe) });
      this.judge('observe', await this.driver.outcome(id, 'observe to settle', WAIT_MS), {});
    } else if ('leave' in step) {
      const id = this.driver.send('unobserve', { observer: step.leave });
      this.judge('unobserve', await this.driver.outcome(id, 'unobserve to settle', WAIT_MS), {});
    } else if ('completes' in step) {
      await this.driver.until(`${step.completes}'s live query to complete`, () => (this.driver.completed.has(step.completes) ? true : undefined), WAIT_MS);
    } else if ('fetch' in step) {
      await this.fetch(step);
    } else if ('fetches' in step) {
      await this.fetches(step.fetches);
    } else {
      const expected = (this.bindings.resolve(step.scopes) as unknown[]).map(String).sort();
      let named: string[] = [];
      await this.proxy
        .until('the stream to name those scopes', () => {
          // One stream, and caught up: an event published next cannot race the
          // subscription, and no stream it superseded is still open to carry
          // the event a second time.
          const open = this.proxy.requests.filter((r) => r.path === '/bus/subscribe' && r.status === 200 && !r.closed);
          const stream = open.length === 1 ? open[0] : undefined;
          const body = stream?.events.some((e) => e.event === 'ping') ? subscription(stream.json) : undefined;
          named = isObject(body) && Array.isArray(body['scoped']) ? body['scoped'].map((entry: unknown) => String(isObject(entry) ? entry['scope'] : entry)) : [];
          return isDeepStrictEqual(named, expected) ? true : undefined;
        }, WAIT_MS)
        .catch((error: unknown) => {
          throw new Error(`${error instanceof Error ? error.message : String(error)}: it names ${JSON.stringify(named)}, not ${JSON.stringify(expected)}`);
        });
    }
  }

  /** Everything the client reported before it answers this is read by the time it does. */
  private async sync(): Promise<void> {
    const id = this.driver.send('sync', {});
    this.judge('sync', await this.driver.outcome(id, 'sync to settle', WAIT_MS), {});
  }

  /** A state as a case reads it: a failure by its code, without the SDK's own words for it. */
  private observed(state: ObservedState): unknown {
    if (state.status !== 'failed') return state;
    this.inVocabulary(state.error, state.detail);
    return { status: 'failed', error: state.error };
  }

  /** The observer comes to hold the state: the first it reports, from where the case has read to, that is it. */
  private async reaches(observer: string, pattern: unknown): Promise<void> {
    const from = this.emissionCursor.get(observer) ?? 0;
    let seen: unknown[] = [];
    const at = await this.driver
      .until(`${observer} to reach that state`, () => {
        const states = this.driver.emissions.get(observer) ?? [];
        seen = states.slice(from).map((state) => this.observed(state));
        const index = seen.findIndex((state) => this.bindings.match(pattern, state) === undefined);
        return index < 0 ? undefined : from + index;
      }, WAIT_MS)
      .catch((error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)}; since the case last read it, it reported ${JSON.stringify(seen)}`);
      });
    this.emissionCursor.set(observer, at + 1);
  }

  /** The client's emits, in order: in a live case each is a request it made of a service. */
  private emits(): ProxiedRequest[] {
    return this.proxy.requests.filter((record) => record.method === 'POST' && record.path.split('?')[0] === '/bus/emit');
  }

  private fetch(step: FetchStep): Promise<void> {
    return this.fetches([step]);
  }

  /** The client's next requests of a service are these, in whatever order it made them. */
  private async fetches(steps: FetchStep[]): Promise<void> {
    const from = this.fetchCursor;
    const what = steps.map((step) => step.fetch).join(', ');
    const records = await this.proxy.until(`the client's next ${steps.length === 1 ? 'request' : `${steps.length} requests`}: ${what}`, () => {
      const next = this.emits().slice(from, from + steps.length);
      return next.length === steps.length && next.every((record) => record.status !== undefined) ? next : undefined;
    }, WAIT_MS);
    this.fetchCursor += steps.length;
    const bodies = records.map((record) => {
      const { body } = this.read(record);
      if (record.status !== 202) throw new Error(`the gateway answered ${JSON.stringify(body)} with ${record.status}`);
      if (!isObject(body) || typeof body['correlationId'] !== 'string') throw new Error(`the client's request ${JSON.stringify(body)} carries no correlation id, so nothing can answer it`);
      return body;
    });
    for (const step of steps) {
      const at = bodies.findIndex((body) => body['channel'] === step.fetch && (step.payload === undefined || this.bindings.match(step.payload, body['payload']) === undefined));
      if (at < 0) throw new Error(`none of the client's next requests is a ${step.fetch}${step.payload === undefined ? '' : ` with ${JSON.stringify(this.bindings.resolve(step.payload))}`}: it made ${JSON.stringify(bodies)}`);
      this.bindings.bind(step.as, bodies.splice(at, 1)[0]!['correlationId']);
    }
  }

  private async operate(step: Extract<Step, { driver: string }>): Promise<void> {
    const args = this.bindings.resolve(step.with ?? {}) as Record<string, unknown>;
    if (step.driver === 'open') {
      args['baseUrl'] = this.proxy.origin;
      args['token'] ??= this.bindings.get('token');
    }
    // A case listens before anything is sent on the channel, so the clock here
    // is before every frame the client could deliver there.
    if (step.driver === 'listen' && typeof args['channel'] === 'string') this.listening.set(args['channel'], this.proxy.now());
    const id = this.driver.send(step.driver, args);
    if (step.as !== undefined) {
      if (this.pending.has(step.as)) throw new Error(`${step.as} is already started`);
      this.pending.set(step.as, { id, op: step.driver });
      return;
    }
    this.judge(step.driver, await this.driver.outcome(id, `${step.driver} to settle`, WAIT_MS), step);
  }

  private inVocabulary(failure: ReportedFailure, detail: string): void {
    if (failure.code === undefined) throw new Error(`the client failed with no code at all: ${detail}`);
    if (!this.codes.has(failure.code)) throw new Error(`the client reported the code ${failure.code}, which specs/src/errors/codes.json does not list (${detail})`);
  }

  private judge(op: string, outcome: Outcome, expected: { returns?: unknown; fails?: unknown; abandoned?: true }): void {
    if ('unsupported' in outcome) throw new Error(`the driver does not implement ${op}`);
    if ('misuse' in outcome) throw new Error(`the case asked the driver for a ${op} it could not act on: ${outcome.misuse}`);
    if ('abandoned' in outcome) {
      if (expected.abandoned !== true) throw new Error(`${op} was abandoned; the case expects it to settle on its own`);
      return;
    }
    if (expected.abandoned === true) throw new Error(`${op} settled with ${JSON.stringify(outcome)}; abandoned, it was to report nothing`);
    if (expected.fails !== undefined) {
      if ('ok' in outcome) throw new Error(`${op} succeeded with ${JSON.stringify(outcome.ok)}; it was to fail`);
      this.inVocabulary(outcome.error, outcome.detail);
      const difference = this.bindings.match(expected.fails, outcome.error);
      if (difference !== undefined) throw new Error(`${op} failed otherwise than expected: ${difference} (${outcome.detail})`);
      return;
    }
    if ('error' in outcome) throw new Error(`${op} failed: ${JSON.stringify(outcome.error)} (${outcome.detail})`);
    if (expected.returns !== undefined) {
      const difference = this.bindings.match(expected.returns, outcome.ok);
      if (difference !== undefined) throw new Error(`${op} returned otherwise than expected: ${difference}`);
    }
  }

  private async wire(step: Extract<Step, { wire: string }>): Promise<void> {
    if (this.layer === 'live') throw new Error('a live case accounts for the wire with `fetch` and `scopes`, not `wire`');
    const index = this.wireCursor;
    const record = await this.proxy.until(`the client's next request, a ${step.wire}`, () => this.proxy.requests[index], WAIT_MS);
    this.wireCursor++;
    const seen = this.read(record);
    if (seen.operation !== step.wire) throw new Error(`the client's next request is a ${seen.operation} (${JSON.stringify(seen.body)}), not a ${step.wire}`);

    const at = step.at ?? 'answer';
    if (at !== 'arrival') await this.proxy.until(`the ${step.wire} to be answered`, () => record.status, WAIT_MS);
    if (at === 'live') await this.proxy.until(`the ${step.wire} stream to catch up`, () => (record.events.some((e) => e.event === 'ping') ? true : undefined), WAIT_MS);
    if (step.answer !== undefined) await this.proxy.until(`the answer to the ${step.wire}`, () => (record.answer === undefined ? undefined : true), WAIT_MS);

    const compared: Array<[string, unknown, unknown]> = [
      ['status', step.status, record.status],
      ['params', step.params, seen.params],
      ['body', step.body, seen.body],
      ['token', step.token, seen.token],
      ['answer', step.answer, record.answer],
    ];
    for (const [field, pattern, value] of compared) {
      if (pattern === undefined) continue;
      const difference = this.bindings.match(pattern, value);
      if (difference !== undefined) throw new Error(`the ${step.wire} differs in its ${field}: ${difference}`);
    }

    if (step.follows !== undefined) {
      const earlier = this.named.get(step.follows);
      if (!earlier) throw new Error(`no request was named ${step.follows}`);
      if (earlier.answered === undefined || earlier.answered > record.arrived) throw new Error(`the ${step.wire} arrived before ${step.follows} was answered`);
    }
    if (step.waited !== undefined) {
      const refused = this.named.get(step.waited);
      if (!refused) throw new Error(`no request was named ${step.waited}`);
      if (refused.retryAfter === undefined || refused.answeredMs === undefined) throw new Error(`${step.waited} was not answered with a Retry-After`);
      const waited = record.arrivedMs - refused.answeredMs;
      if (waited < refused.retryAfter * 1000 - WAIT_GRACE_MS) {
        throw new Error(`the ${step.wire} came ${Math.round(waited)} ms after ${step.waited} was refused, which stated Retry-After: ${refused.retryAfter}`);
      }
    }
    if (step.as !== undefined) this.named.set(step.as, record);
  }

  // ── the backend ──────────────────────────────────────────────────────────

  private async backend(directive: string, args: Record<string, unknown>): Promise<void> {
    const text = (name: string): string => {
      if (typeof args[name] !== 'string') throw new Error(`backend ${directive} needs ${name}, a string`);
      return args[name];
    };
    const number = (name: string): number => {
      if (typeof args[name] !== 'number') throw new Error(`backend ${directive} needs ${name}, a number`);
      return args[name];
    };
    const optionalText = (name: string): string | undefined => (args[name] === undefined ? undefined : text(name));
    const allowed = (...names: string[]): void => {
      const strays = Object.keys(args).filter((name) => !names.includes(name));
      if (strays.length > 0) throw new Error(`backend ${directive} does not take ${strays.join(', ')}`);
    };
    const emit = async (body: Record<string, unknown>): Promise<void> => {
      const reply = await this.world.emit(this.participant.token, { ...body, clientId: this.participant.clientId });
      if (reply.status !== 202) throw new Error(`the gateway refused the backend's emit: ${reply.status} ${reply.text}`);
    };

    switch (directive) {
      case 'listen': {
        allowed('channels', 'scope');
        const channels = args['channels'];
        if (!Array.isArray(channels) || !channels.every((c): c is string => typeof c === 'string')) throw new Error('backend listen needs channels, a list of strings');
        const scope = optionalText('scope');
        await this.world.subscribe(this.participant.token, { clientId: this.participant.clientId, ...(scope === undefined ? { global: channels } : { scoped: [{ scope, channels }] }) });
        return;
      }
      case 'emit': {
        allowed('channel', 'payload', 'scope', 'correlationId');
        if (!isObject(args['payload'])) throw new Error('backend emit needs payload, an object');
        const scope = optionalText('scope');
        const correlationId = optionalText('correlationId');
        await emit({ channel: text('channel'), payload: args['payload'], ...(scope === undefined ? {} : { scope }), ...(correlationId === undefined ? {} : { correlationId }) });
        return;
      }
      case 'record': {
        allowed('resource', 'channel', 'sequence', 'count', 'live', 'payload', 'enriched', 'unscoped');
        const resource = text('resource');
        const first = number('sequence');
        // `count` events, at the sequence numbers from `sequence` on.
        for (let sequence = first; sequence < first + (args['count'] === undefined ? 1 : number('count')); sequence++) {
          const event = { ...storedEvent(text('channel'), resource, sequence), ...(isObject(args['payload']) ? { payload: args['payload'] } : {}) };
          this.world.archivist.events.set(resource, [...(this.world.archivist.events.get(resource) ?? []), event]);
          // Published as the record's own service publishes it: with what it
          // enriched the event with, and on the resource's scope unless the
          // channel is one every client hears.
          const published = { ...event, ...(isObject(args['enriched']) ? args['enriched'] : {}) };
          if (args['live'] === true) await emit({ channel: event.type, payload: published, ...(args['unscoped'] === true ? {} : { scope: resource }) });
        }
        return;
      }
      case 'archivist': {
        allowed('replayFails');
        if (typeof args['replayFails'] !== 'boolean') throw new Error('backend archivist needs replayFails, a boolean');
        this.world.archivist.mode.replayFails = args['replayFails'];
        return;
      }
      case 'content': {
        allowed('resource', 'mediaType', 'bytes');
        const storageUri = `file://seeded/${text('resource')}`;
        this.world.archivist.resources.set(text('resource'), { storageUri, mediaType: text('mediaType') });
        this.world.archivist.content.set(storageUri, Buffer.from(text('bytes'), 'base64'));
        return;
      }
      case 'description': {
        allowed('resource', 'graph');
        this.world.archivist.descriptions.set(text('resource'), args['graph']);
        return;
      }
      case 'uploaded': {
        allowed('resource', 'fields', 'bytes');
        const upload = this.world.archivist.uploads.find((u) => u.resourceId === text('resource'));
        if (!upload) throw new Error(`the Archivist recorded no upload as ${text('resource')}`);
        const difference = this.bindings.match(args['fields'], upload.fields);
        if (difference !== undefined) throw new Error(`the upload's fields differ: ${difference}`);
        if (!upload.file.equals(Buffer.from(text('bytes'), 'base64'))) throw new Error(`the upload's bytes differ: the Archivist stored ${upload.file.length} bytes`);
        if (upload.principal !== this.client) throw new Error(`the upload was recorded for ${upload.principal}, not the client (${this.client})`);
        return;
      }
      case 'refuse': {
        allowed('wire', 'status', 'retryAfter', 'body', 'times');
        const wire = text('wire');
        const [method, template] = wire.split(' ');
        const body = JSON.stringify(args['body']);
        const headers: Record<string, string> = { 'content-type': 'application/json', ...(args['retryAfter'] === undefined ? {} : { 'retry-after': String(number('retryAfter')) }) };
        const reply: Reply = { status: number('status'), headers: new Headers(headers), text: body, json: args['body'], bytes: Buffer.from(body) };
        // The proxy speaks for the gateway here, so what it says is held to what the spec lets a gateway say.
        const off = nonConformance(method!.toLowerCase() as Method, template!, reply);
        if (off.length > 0) throw new Error(`the case scripts a refusal the spec does not allow: ${off.join('; ')}`);
        this.proxy.answer(this.matcher(wire), { status: reply.status, headers, body }, number('times'));
        return;
      }
      case 'hold':
        allowed('wire');
        this.proxy.hold(this.matcher(text('wire')));
        return;
      case 'release':
        allowed();
        this.proxy.release();
        return;
      case 'rechunk':
        allowed('bytes');
        this.proxy.rechunk(number('bytes'));
        return;
      case 'cut':
        allowed();
        this.proxy.cut();
        return;
      case 'down':
        allowed();
        this.proxy.down();
        return;
      case 'up':
        allowed();
        this.proxy.up();
        return;
      default:
        throw new Error(`no backend directive ${directive}`);
    }
  }

  // ── what every case is held to ───────────────────────────────────────────

  private nothingUnaccounted(when: string): void {
    // A live case answers for every request the client made of a service, and
    // for anything that is neither that nor its stream.
    const unaccounted =
      this.layer === 'wire'
        ? this.proxy.requests.slice(this.wireCursor)
        : [...this.emits().slice(this.fetchCursor), ...this.proxy.requests.filter((record) => !['/bus/emit', '/bus/subscribe'].includes(record.path.split('?')[0]!))];
    const extra = unaccounted.map((record) => {
      const seen = this.read(record);
      return `${seen.operation} ${JSON.stringify(seen.body)}`;
    });
    if (extra.length > 0) throw new Error(`the client sent what the case does not account for, ${when}: ${extra.join('; ')}`);
  }

  /** The frames the gateway sent the client on `channel` since it began listening: each event once, in the order it first came. */
  private carried(channel: string, since: number): DeliveredFrame[] {
    const seen = new Set<string>();
    return this.proxy.requests
      .flatMap((record) => record.events)
      .filter((event) => event.event === 'bus-event' && event.at > since)
      .sort((a, b) => a.at - b.at)
      .flatMap((event): DeliveredFrame[] => {
        const frame: unknown = JSON.parse(event.data);
        if (!isObject(frame) || frame['channel'] !== channel) return [];
        if (event.id !== undefined) {
          if (seen.has(event.id)) return [];
          seen.add(event.id);
        }
        const { correlationId, scope } = frame;
        return [{ payload: frame['payload'], ...(typeof correlationId === 'string' ? { correlationId } : {}), ...(typeof scope === 'string' ? { scope } : {}) }];
      });
  }

  /** Wait for the client to have delivered what it was sent, so a frame still on its way is not read as one it lost. */
  async settle(): Promise<void> {
    for (const [channel, since] of this.listening) {
      const expected = this.carried(channel, since).length;
      await this.driver.until(`the ${expected} frames sent on ${channel} to be delivered`, () => ((this.driver.frames.get(channel)?.length ?? 0) >= expected ? true : undefined), 5_000).catch(() => undefined);
    }
  }

  /** Judge everything the case did not have to state. Called once the driver has stopped. */
  finish(): void {
    if (this.pending.size > 0) throw new Error(`the case never settled ${[...this.pending.keys()].join(', ')}`);
    this.nothingUnaccounted('by the end of the case');
    for (const [channel, since] of this.listening) {
      const delivered = this.driver.frames.get(channel) ?? [];
      const sent = this.carried(channel, since);
      if (!isDeepStrictEqual(delivered, sent)) {
        throw new Error(`on ${channel} the client delivered ${delivered.length} frames and was sent ${sent.length}, or they differ:\n  delivered ${JSON.stringify(delivered)}\n  sent      ${JSON.stringify(sent)}`);
      }
      const expected = this.frameCursor.get(channel) ?? 0;
      if (delivered.length !== expected) throw new Error(`the client delivered ${delivered.length} frames on ${channel}; the case expects ${expected}`);
    }
    const unexpected = this.driver.failures.slice(this.failureCursor);
    if (unexpected.length > 0) throw new Error(`the error stream carried what the case does not expect: ${JSON.stringify(unexpected)}`);
    if (this.driver.violations.length > 0) throw new Error(`the driver broke its protocol: ${this.driver.violations.join('; ')}`);
    if (this.problems.length > 0) throw new Error(`the client sent ${[...new Set(this.problems)].join('; ')}`);
  }

  /** What happened, for a failing case's message. */
  account(): string {
    const wire = this.proxy.requests.map((record, index) => {
      const operation = declared(record.method, record.path);
      const name = operation ? operationName(operation.method, operation.template) : `${record.method} ${record.path}`;
      return `    ${index < this.wireCursor ? ' ' : '?'} ${name} → ${record.status ?? 'unanswered'} ${JSON.stringify(record.json)}`;
    });
    const frames = [...this.driver.frames].map(([channel, delivered]) => `    ${channel}: ${JSON.stringify(delivered)}`);
    const observers = [...this.driver.emissions].map(([observer, states]) => `    ${observer}: ${JSON.stringify(states)}`);
    return [
      '  on the wire:',
      ...wire,
      `  states: ${this.driver.states.join(', ')}`,
      '  frames delivered:',
      ...frames,
      '  observers:',
      ...observers,
      `  error stream: ${JSON.stringify(this.driver.failures)}`,
      '  the driver’s stderr:',
      ...this.driver.stderr.slice(-20).map((line) => `    ${line}`),
    ].join('\n');
  }
}

/** Run `kase` against the driver `command` starts, on `world`'s gateway. Throws on the first thing a conforming client would not have done. */
export async function runCase(world: World, command: readonly string[], kase: Case, layer: Layer): Promise<void> {
  const proxy = await startClientProxy(world.origin);
  const otlp = kase.telemetry ? await startOtlp() : undefined;
  const driver = await Driver.start(command, otlp ? { OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint } : {});
  const subject = `client-${randomUUID()}`;
  const participant = await world.agent('conformance', `participant-${randomUUID()}`);
  const run = new Run(layer, world, proxy, driver, { token: participant.token, clientId: randomUUID() }, world.personDid(subject));

  run.bind('token', await world.person(subject, { jti: randomUUID() }));
  run.bind('token2', await world.person(subject, { jti: randomUUID() }));
  run.bind('client', world.personDid(subject));
  run.bind('participant', participant.did);
  // In name order, so a case can write a subscription's scopes in the order the suite reads them.
  const resources = Array.from({ length: 3 }, () => `res-${randomUUID()}`).sort();
  for (const [index, resource] of resources.entries()) run.bind(`r${index + 1}`, resource);
  for (const name of ['a1', 'a2']) run.bind(name, `ann-${randomUUID()}`);
  run.bind('resourceScopedChannels', [...registry().audience.scoped].sort());

  let at = 0;
  try {
    for (const [index, step] of kase.steps.entries()) {
      at = index;
      await run.step(step);
    }
    at = kase.steps.length;
    await run.settle();
    const code = await driver.stop();
    if (code !== 0) throw new Error(`the driver exited with code ${code}`);
    run.finish();
    if (otlp) {
      at = kase.steps.length + 1;
      const outside = await outsideTheSdkTable(otlp);
      if (outside.length > 0) throw new Error(`the client exported ${outside.join('; ')}`);
    }
  } catch (error) {
    const where = at < kase.steps.length ? `step ${at + 1} ${JSON.stringify(kase.steps[at])}` : at === kase.steps.length ? 'the end of the case' : 'what it exported';
    throw new Error(`${kase.name}, at ${where}: ${error instanceof Error ? error.message : String(error)}\n${run.account()}`);
  } finally {
    await driver.stop();
    await proxy.close();
    await otlp?.close();
    // A case that fails between switching the Archivist and switching it back must not fail the next.
    world.archivist.mode.replayFails = false;
  }
}
