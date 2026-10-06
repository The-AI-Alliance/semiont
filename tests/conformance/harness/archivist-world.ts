/**
 * An Archivist world: an Archivist process and everything it meets. That is a
 * knowledge base's working tree, made fresh and, unless a file says otherwise,
 * a git checkout; a state volume and an anchored-text store beside it; the
 * trusted issuer, which admits the Archivist's service account; and a gateway
 * on the in-process plane, the Archivist's only route to the bus.
 *
 * Cases meet the Archivist in the three places the rest of Semiont does: on
 * the bus, as people, workers and sidecars emitting through the gateway and
 * reading replies and facts off their streams; at its HTTP surface, as a
 * service; and in the files it keeps, which other processes read. Every frame
 * a stream carries must be what the registry says its channel carries, and
 * every response what the Archivist's API says, and a case fails otherwise,
 * whatever it was about.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect } from 'vitest';
import type { components } from '@semiont/core';
import { startArchivistProcess, type ArchivistEnvironment, type ArchivistProcess, type ArchivistSettings } from './archivist-process';
import { archivistNonConformance, type CallOptions, type Reply } from './http';
import { eventually, freePort } from './net';
import { SPEC_SOURCE } from './paths';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';
import { errorsOf, operationFor, registry, spec, type Method } from './spec';
import type { BusFrame, BusStream } from './stream';
import { PARTICIPANT_CLIENT, World } from './world';

/** The Archivist's service account at the issuer. */
export const ARCHIVIST_CLIENT = 'semiont-archivist';

export type Roster = ArchivistSettings['roster'];
export type Annotation = components['schemas']['Annotation'];
export type ResourceView = components['schemas']['ResourceView'];
type ExtractedText = components['schemas']['ExtractedText'];

/** One line of a stream's log, as stored. */
export interface StoredEvent {
  type: string;
  resourceId?: string;
  userId: string;
  version: number;
  payload: Record<string, unknown>;
  id: string;
  timestamp: string;
  metadata: { sequenceNumber: number };
}

export interface ArchivistWorldOptions {
  /** Whether the knowledge base syncs git, and is a checkout. Default: it does, and is. */
  gitSync?: boolean;
  /** Who serves each role. Default: no one. */
  roster?: Roster;
  /** The staging bounds, over a quarter of a second and two seconds. */
  staging?: Partial<ArchivistSettings['staging']>;
  /** Prepare the tree, the state volume or the store before the Archivist first boots. */
  before?: (dirs: Directories) => void;
  /** More of the Archivist's environment, over its service account. */
  env?: ArchivistEnvironment;
  /** Put a `git` that only records that it was run ahead of the real one: for a knowledge base that must run none. */
  gitTripwire?: boolean;
}

/** Where a world keeps its three trees. */
export interface Directories {
  /** The working tree. */
  root: string;
  /** The state volume. */
  stateHome: string;
  /** The knowledge base's state directory under it. */
  stateDir: string;
  anchoredTextDir: string;
}

/** A reply to a correlated request. */
export interface Answer {
  ok: boolean;
  channel: string;
  payload: Record<string, unknown>;
  /** The reply's `response`, when it has one. */
  response: Record<string, unknown>;
}

/** A payload without the gateway's stamps (EVENT-BUS.md), which are the bus's and not the payload's. */
export function unstamped<T extends Record<string, unknown>>(payload: T): T {
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith('_'))) as T;
}

/** The persisted channels: the facts. */
export const FACTS: readonly string[] = registry().channels.filter((c) => c.shape === 'storedEvent').map((c) => c.channel);

/** The two-level shard of a key, as specs/src/archivist/shard-cases.json states the arithmetic. */
export function shardOf(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  const hex = (Math.abs(hash) % 65536).toString(16).padStart(4, '0');
  return `${hex.slice(0, 2)}/${hex.slice(2)}`;
}

export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Holds every frame a stream carries to what the registry says its channel carries. */
function holdToRegistry(stream: BusStream): void {
  stream.on((message) => {
    const frame = message.frame;
    if (!frame) return;
    const channel = registry().channels.find((c) => c.channel === frame.channel);
    if (!channel) {
      stream.violations.push(`a frame on ${frame.channel}, which the registry does not declare`);
      return;
    }
    if (channel.shape === 'storedEvent') {
      const validate = spec().component('StoredEventResponse');
      if (!validate(frame.payload)) {
        stream.violations.push(`${frame.channel} carried a payload that is not a stored event (${errorsOf(validate)}): ${JSON.stringify(frame.payload).slice(0, 400)}`);
      } else if (frame.payload['type'] !== frame.channel) {
        stream.violations.push(`${frame.channel} carried an event of type ${String(frame.payload['type'])}`);
      }
      return;
    }
    if (channel.shape !== 'schema' || channel.schema === undefined) return;
    // The gateway's stamps (EVENT-BUS.md) are the bus's, not the payload's.
    const payload = unstamped(frame.payload);
    const validate = spec().component(channel.schema);
    if (!validate(payload)) {
      stream.violations.push(`${frame.channel} carried a payload that is not a ${channel.schema} (${errorsOf(validate)}): ${JSON.stringify(frame.payload).slice(0, 400)}`);
    }
  });
}

/**
 * A participant on the bus: a person, a worker or a sidecar, subscribed under
 * its own client id to the replies of every operation, to every fact, and to
 * any other channel it names.
 */
export class BusClient {
  constructor(
    private readonly world: ArchivistWorld,
    readonly token: string,
    readonly did: string,
    readonly clientId: string,
    readonly stream: BusStream,
  ) {}

  /** Emit `operation` with a fresh correlationId and read its one reply. */
  async request(operation: string, payload: Record<string, unknown>, timeoutMs = 20_000): Promise<Answer> {
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
    const response = frame.payload['response'];
    return {
      ok: frame.channel === result,
      channel: frame.channel,
      payload: unstamped(frame.payload),
      response: typeof response === 'object' && response !== null ? (response as Record<string, unknown>) : {},
    };
  }

  /** A request the Archivist must answer on the result channel; answers its `response`. */
  async ask(operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const answer = await this.request(operation, payload);
    if (!answer.ok) throw new Error(`${operation} was refused: ${JSON.stringify(answer.payload)}`);
    return answer.response;
  }

  /** A request the Archivist must refuse; answers the refusal's message. */
  async refused(operation: string, payload: Record<string, unknown>): Promise<string> {
    const answer = await this.request(operation, payload);
    if (answer.ok) throw new Error(`${operation} was answered, and should have been refused: ${JSON.stringify(answer.payload)}`);
    return String(answer.payload['message']);
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

  /** The facts this client's stream has carried with no scope, oldest first. */
  facts(type?: string): StoredEvent[] {
    return this.stream
      .frames()
      .filter((f) => f.scope === undefined && FACTS.includes(f.channel) && (type === undefined || f.channel === type))
      .map((f) => unstamped(f.payload) as unknown as StoredEvent);
  }

  /** Wait for an unscoped fact `match` accepts. */
  fact(type: string, match: (event: StoredEvent) => boolean = () => true, timeoutMs = 10_000): Promise<StoredEvent> {
    return eventually(`a ${type} fact`, timeoutMs, () => this.facts(type).find(match));
  }
}

export class ArchivistWorld {
  private constructor(
    readonly world: World,
    readonly dirs: Directories,
    /** The environment the Archivist is started with: its service account, and what the world was given. */
    readonly env: ArchivistEnvironment,
    public archivist: ArchivistProcess,
    private readonly responses: string[],
    private readonly pathFirst: string | undefined,
  ) {}

  static async create(options: ArchivistWorldOptions = {}): Promise<ArchivistWorld> {
    const secret = randomBytes(24).toString('hex');
    const world = await World.create('in-process', { accounts: { [ARCHIVIST_CLIENT]: { secret, roles: [SERVICE_ROLE] } } });
    const base = mkdtempSync(join(tmpdir(), 'conformance-kb-'));
    const stateHome = join(base, 'state');
    const dirs: Directories = {
      root: join(base, 'kb'),
      stateHome,
      stateDir: join(stateHome, 'semiont', world.kb.name),
      anchoredTextDir: join(base, 'anchored-text'),
    };
    const gitSync = options.gitSync ?? true;
    mkdirSync(join(dirs.root, '.semiont'), { recursive: true });
    mkdirSync(dirs.stateHome, { recursive: true });
    mkdirSync(dirs.anchoredTextDir, { recursive: true });
    writeFileSync(
      join(dirs.root, '.semiont', 'config'),
      `[project]\nname = ${JSON.stringify(world.kb.name)}\n\n[git]\nsync = ${gitSync}\n\n[site]\ndomain = ${JSON.stringify(world.kb.domain)}\n`,
    );
    if (gitSync) execFileSync('git', ['init', '--quiet'], { cwd: dirs.root });
    options.before?.(dirs);

    const env: ArchivistEnvironment = {
      SEMIONT_OIDC_CLIENT_ID: ARCHIVIST_CLIENT,
      SEMIONT_OIDC_CLIENT_SECRET: secret,
      ...options.env,
    };
    const settings: ArchivistSettings = {
      gatewayUrl: world.origin,
      identity: { issuer: world.issuer.origin },
      root: dirs.root,
      stateHome: dirs.stateHome,
      anchoredTextDir: dirs.anchoredTextDir,
      roster: options.roster ?? { workers: {}, actors: {} },
      port: await freePort(),
      skipRebuild: false,
      staging: { flushMs: 250, maxWaitMs: 2_000, ...options.staging },
      logLevel: 'info',
      logFormat: 'json',
    };
    let pathFirst: string | undefined;
    if (options.gitTripwire) {
      pathFirst = join(base, 'tripwire');
      mkdirSync(pathFirst);
      writeFileSync(join(pathFirst, 'git'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(join(base, 'git-runs'))}\nexit 1\n`, { mode: 0o755 });
    }
    const archivist = await startArchivistProcess({ settings, env, ...(pathFirst ? { pathFirst } : {}) });
    const self = new ArchivistWorld(world, dirs, env, archivist, [], pathFirst);
    await self.answering();
    return self;
  }

  get settings(): ArchivistSettings {
    return this.archivist.settings;
  }

  /**
   * Wait until the Archivist answers on the bus. Its health says it has booted,
   * not that its stream to the gateway is open; until it is, a request reaches
   * no one.
   */
  async answering(): Promise<void> {
    const probe = await this.sidecar('readiness');
    await eventually('the Archivist to answer on the bus', 30_000, async () => {
      const answer = await probe.request('browse:kb-requested', {}, 5_000).catch(() => undefined);
      return answer === undefined || answer.payload['code'] === 'peer-unavailable' ? undefined : true;
    });
  }

  // ── Participants ──────────────────────────────────────────────────────────

  private async client(token: string, did: string, channels: string[], scopes: string[]): Promise<BusClient> {
    const replies = registry().operations.flatMap((op) => [op.result, op.failure]);
    const clientId = randomUUID();
    const stream = await this.world.subscribe(token, {
      clientId,
      global: [...new Set([...replies, ...FACTS, ...channels])],
      ...(scopes.length > 0 ? { scoped: scopes.map((scope) => ({ scope, channels: [...FACTS] })) } : {}),
    });
    holdToRegistry(stream);
    return new BusClient(this, token, did, clientId, stream);
  }

  /** A person, signed in at the issuer. `scopes` are the resources whose scoped facts they follow. */
  async person(sub: string, options: { channels?: string[]; scopes?: string[] } = {}): Promise<BusClient> {
    return this.client(await this.world.person(sub), this.world.personDid(sub), options.channels ?? [], options.scopes ?? []);
  }

  /** A worker: a software agent holding the worker role. */
  async worker(model: string, options: { channels?: string[]; scopes?: string[] } = {}): Promise<BusClient> {
    const { token, did } = await this.world.agent('conformance', model, [SERVICE_ROLE, WORKER_ROLE]);
    return this.client(token, did, options.channels ?? [], options.scopes ?? []);
  }

  /** A sidecar: a software agent holding the service role and not the worker role. */
  async sidecar(model: string, options: { channels?: string[]; scopes?: string[] } = {}): Promise<BusClient> {
    const { token, did } = await this.world.agent('conformance', model, [SERVICE_ROLE]);
    return this.client(token, did, options.channels ?? [], options.scopes ?? []);
  }

  // ── The HTTP surface ──────────────────────────────────────────────────────

  /** A service account's token: what the Archivist's HTTP surface admits. */
  serviceToken(roles: string[] = [SERVICE_ROLE]): Promise<string> {
    return this.world.issuer.service(PARTICIPANT_CLIENT, roles);
  }

  /** A request of the HTTP surface, as a service unless `options.token` says otherwise. Held to the Archivist's API. */
  async http(method: string, path: string, options: CallOptions & { anonymous?: boolean; route?: string } = {}): Promise<Reply> {
    const { anonymous, route, ...callOptions } = options;
    const token = anonymous ? undefined : (callOptions.token ?? (await this.serviceToken()));
    const reply = await this.archivist.http(method, path, { ...callOptions, ...(token === undefined ? {} : { token }) });
    if (route !== undefined) {
      this.responses.push(...archivistNonConformance(method.toLowerCase() as Method, route, reply).map((v) => `${method} ${path}: ${v}`));
    }
    return reply;
  }

  /**
   * Upload content as `principal` and have it recorded: `POST /resources`, as
   * the gateway sends a person's upload on. Answers the reply.
   */
  async upload(
    principal: string,
    fields: { name: string; storageUri: string; format?: string; content: string | Buffer } & Record<string, string | Buffer | undefined>,
    roles: string[] = [],
  ): Promise<Reply> {
    const { content, ...rest } = fields;
    const form = new FormData();
    for (const [name, value] of Object.entries({ format: 'text/markdown', ...rest })) {
      if (typeof value === 'string') form.set(name, value);
    }
    form.set('file', new Blob([typeof content === 'string' ? content : new Uint8Array(content)]), 'upload');
    return this.http('POST', '/resources', {
      body: form,
      headers: { 'Semiont-Principal': principal, ...(roles.length > 0 ? { 'Semiont-Roles': roles.join(',') } : {}) },
      route: '/resources',
    });
  }

  /** Upload content the Archivist must record, and answer the new resource's id. */
  async created(principal: string, fields: { name: string; storageUri: string; format?: string; content: string | Buffer } & Record<string, string | Buffer | undefined>): Promise<string> {
    const reply = await this.upload(principal, fields);
    if (reply.status !== 200) throw new Error(`the upload was not recorded: ${reply.status} ${reply.text}`);
    return (reply.json as { resourceId: string }).resourceId;
  }

  // ── The files it keeps ────────────────────────────────────────────────────

  /** A resource's stream directory, or the `__system__` stream's. */
  streamDir(resourceId: string): string {
    return resourceId === '__system__'
      ? join(this.dirs.root, '.semiont', 'events', '__system__')
      : join(this.dirs.root, '.semiont', 'events', ...shardOf(resourceId).split('/'), resourceId);
  }

  /** A stream's files, in order. */
  streamFiles(resourceId: string): string[] {
    const dir = this.streamDir(resourceId);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** Every line of a stream, as written: no line is parsed. */
  streamLines(resourceId: string): string[] {
    return this.streamFiles(resourceId).flatMap((file) => {
      const text = readFileSync(join(this.streamDir(resourceId), file), 'utf8');
      if (text !== '' && !text.endsWith('\n')) throw new Error(`${file} of ${resourceId} does not end with a newline`);
      return text.split('\n').slice(0, -1);
    });
  }

  /** A stream's events, oldest first. */
  stored(resourceId: string): StoredEvent[] {
    return this.streamLines(resourceId).map((line) => JSON.parse(line) as StoredEvent);
  }

  viewPath(resourceId: string): string {
    return join(this.dirs.stateDir, 'resources', ...shardOf(resourceId).split('/'), `${resourceId}.json`);
  }

  /** A resource's view file, held to the ResourceView schema; undefined when there is none. */
  view(resourceId: string): ResourceView | undefined {
    return this.document<ResourceView>(this.viewPath(resourceId), 'ResourceView');
  }

  /** A `__system__` projection, held to its schema; undefined when there is none. */
  projection<T = Record<string, unknown>>(file: 'entitytypes.json' | 'tagschemas.json' | 'people.json'): T | undefined {
    const schema = { 'entitytypes.json': 'EntityTypesProjection', 'tagschemas.json': 'TagSchemasProjection', 'people.json': 'PeopleProjection' }[file];
    return this.document<T>(join(this.dirs.stateDir, 'projections', '__system__', file), schema);
  }

  storageUriPath(uri: string): string {
    return join(this.dirs.stateDir, 'projections', 'storage-uri', ...shardOf(uri).split('/'), `${sha256(uri)}.json`);
  }

  /** The storage-uri index's entry for a URI, held to its schema; undefined when there is none. */
  storageUriEntry(uri: string): { uri: string; resourceId: string } | undefined {
    return this.document(this.storageUriPath(uri), 'StorageUriEntry');
  }

  private document<T>(path: string, schema: string): T | undefined {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const validate = spec().component(schema);
    if (!validate(parsed)) throw new Error(`${path} is not a ${schema} (${errorsOf(validate)})`);
    return parsed as T;
  }

  /** The file a storage URI names in the working tree. */
  contentPath(storageUri: string): string {
    return join(this.dirs.root, storageUri.slice('file://'.length));
  }

  /** Put a file in the working tree, as a person editing the tree would. */
  write(storageUri: string, content: string | Buffer): void {
    const path = this.contentPath(storageUri);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  // ── git ───────────────────────────────────────────────────────────────────

  private git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.dirs.root, encoding: 'utf8' });
  }

  /** The paths staged in the index, relative to the root. */
  staged(): string[] {
    return this.git('diff', '--cached', '--name-only', '-z').split('\0').filter((path) => path !== '');
  }

  /** The paths in the index: staged, or committed and unchanged. */
  indexed(): string[] {
    return this.git('ls-files', '-z').split('\0').filter((path) => path !== '');
  }

  /** Every run of git the tripwire recorded, by its arguments. */
  gitRuns(): string[] {
    const record = join(dirname(this.dirs.root), 'git-runs');
    return existsSync(record) ? readFileSync(record, 'utf8').split('\n').filter((line) => line !== '') : [];
  }

  /** Wait until the index holds `path`, within the staging bound and a margin. */
  untilIndexed(path: string): Promise<true> {
    return eventually(`${path} to be staged`, this.settings.staging.maxWaitMs + 5_000, () => (this.indexed().includes(path) ? true : undefined));
  }

  // ── The Smelter ───────────────────────────────────────────────────────────

  /**
   * The Smelter, as far as the Archivist meets it: state a stamp in the store,
   * write an entry under it for content of this checksum, and signal that the
   * resource has settled.
   */
  async smelt(resourceId: string, checksum: string, entry: Record<string, unknown> | undefined, outcome: 'indexed' | 'skipped' = 'indexed', stamp = 'conformance-smelter'): Promise<void> {
    if (entry !== undefined) {
      writeFileSync(join(this.dirs.anchoredTextDir, 'STAMP'), `${stamp}\n`);
      const path = join(this.dirs.anchoredTextDir, ...shardOf(checksum).split('/'), `${checksum}.json`);
      mkdirSync(dirname(path), { recursive: true });
      const document = { v: 2, stamp, ...entry };
      const validate = spec().component('AnchoredTextEntry');
      if (!validate(document)) throw new Error(`the suite's anchored-text entry is not an AnchoredTextEntry (${errorsOf(validate)})`);
      writeFileSync(path, JSON.stringify(document));
    }
    const smelter = await this.sidecar('smelter');
    await smelter.emit('smelt:settled', { resourceId, contentChecksum: checksum, outcome });
  }

  // ── Restarts ──────────────────────────────────────────────────────────────

  /** Stop the Archivist and start it again on the same trees and, unless changed, the same settings. */
  async restart(change: (s: ArchivistSettings) => ArchivistSettings = (s) => s): Promise<void> {
    const settings = change(this.settings);
    await this.archivist.stop();
    this.archivist = await startArchivistProcess({ settings, env: this.env, ...(this.pathFirst ? { pathFirst: this.pathFirst } : {}) });
    await this.answering();
  }

  /** Every file under the knowledge base's state directory, by its path from there, with its bytes. */
  stateFiles(): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (dir: string, from: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const name = from === '' ? entry.name : `${from}/${entry.name}`;
        if (entry.isDirectory()) walk(path, name);
        else files.set(name, readFileSync(path, 'utf8'));
      }
    };
    walk(this.dirs.stateDir, '');
    return files;
  }

  /** Kill the Archivist without its shutdown, and start another on the same trees. */
  async crashAndRestart(): Promise<void> {
    const settings = this.settings;
    await this.archivist.crash();
    this.archivist = await startArchivistProcess({ settings, env: this.env, ...(this.pathFirst ? { pathFirst: this.pathFirst } : {}) });
    await this.answering();
  }

  drain(): string[] {
    return [...this.world.drain(), ...this.responses.splice(0)];
  }

  async close(): Promise<void> {
    await this.archivist.stop();
    await this.world.close();
    rmSync(dirname(this.dirs.root), { recursive: true, force: true });
  }
}

/**
 * Run `body`'s cases against one Archivist world. After every case, the
 * streams it opened and the responses it read must have carried nothing the
 * spec does not allow.
 */
export function withArchivist(title: string, body: (world: () => ArchivistWorld) => void, options: ArchivistWorldOptions = {}): void {
  describe(title, () => {
    let world: ArchivistWorld | undefined;
    beforeAll(async () => {
      world = await ArchivistWorld.create(options);
    });
    afterAll(async () => {
      await world?.close();
    });
    afterEach((context) => {
      if (context.task.result?.state === 'fail') console.error(`Archivist output:\n${world?.archivist.output.join('\n')}`);
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!);
  });
}

/** A text annotation's parts, as `mark:create-request` takes them. */
export function highlight(resourceId: string, exact: string, start: number): Record<string, unknown> {
  return {
    motivation: 'highlighting',
    target: {
      source: resourceId,
      selector: [
        { type: 'TextPositionSelector', start, end: start + exact.length },
        { type: 'TextQuoteSelector', exact },
      ],
    },
  };
}

/** An anchored-text entry's body for `text`, one word per line of the page. */
export function anchoredEntry(text: string): Omit<ExtractedText, 'kind' | 'items'> & { lines: unknown[] } {
  const lines: unknown[] = [];
  let offset = 0;
  for (const [index, word] of text.split(' ').entries()) {
    lines.push({ p: 1, y: 700 - index * 14, h: 12, words: [[72, word.length * 6, offset, offset + word.length]] });
    offset += word.length + 1;
  }
  return { text, lines, method: 'ocr' };
}

/** The shard table every implementation runs. */
export function shardCases(): Array<{ why: string; key: string; shard: string }> {
  return (JSON.parse(readFileSync(join(SPEC_SOURCE, 'archivist/shard-cases.json'), 'utf8')) as { cases: Array<{ why: string; key: string; shard: string }> }).cases;
}
