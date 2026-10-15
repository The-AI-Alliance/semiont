/**
 * A Librarian world: a Librarian process and everything it meets. That is an
 * Archivist world (a knowledge base, a real Archivist that records and
 * answers and writes the views, a gateway, the trusted issuer); the two
 * services that write what a Librarian reads, a Weaver and a Smelter, each
 * with a service account of its own; a real neo4j and a real Qdrant, both
 * cleared when the world is made and when it is closed; a stand-in for the
 * model of each of the Librarian's two actors; and two stand-ins for the
 * embedding provider, one the Librarian asks and one the Smelter asks, which
 * give the same text the same vector.
 *
 * Cases meet the Librarian where the rest of Semiont does: on the bus, as a
 * person who is signed in asks it and reads its reply; at its providers; at
 * its health port; and in what it writes to its output. Nothing is put in the
 * graph or the index but by the Weaver and the Smelter, from what a case
 * records through the Archivist: what the Librarian reads is what the real
 * writers wrote. A case stages a store that lags by stopping its writer.
 *
 * One read does not reach the real Archivist by itself. A Librarian reads a
 * resource's anchored text from the gateway, and the gateway of an Archivist
 * world asks the harness's stand-in Archivist. For every resource a case
 * makes, the world has the stand-in answer what the real Archivist answers.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, afterEach, beforeAll, describe, expect, inject } from 'vitest';
import type { components, EventMap } from '@semiont/core';
import { ArchivistWorld, sha256, unstamped, type BusClient } from './archivist-world';
import {
  refusedLibrarianBoot,
  startLibrarian,
  type LibrarianEnvironment,
  type LibrarianLaunch,
  type LibrarianProcess,
  type LibrarianSettings,
} from './librarian-process';
import { eventually, freePort } from './net';
import { startOllama, type StandInOllama } from './ollama';
import { startOllamaEmbed, type StandInEmbedder } from './ollama-embed';
import { QDRANT_PORT, vectorIndex, type VectorIndex } from './qdrant';
import { SERVICE_ROLE } from './roles';
import { startSmelter, type SmelterLaunch, type SmelterProcess } from './smelter-process';
import { errorsOf, registry, spec } from './spec';
import type { BusStream } from './stream';
import { startWeaver, type WeaverLaunch, type WeaverProcess } from './weaver-process';
import { FOLLOWED } from './weaver-world';

/** The service accounts of the three services, at the issuer. */
export const LIBRARIAN_CLIENT = 'semiont-librarian';
const WEAVER_CLIENT = 'semiont-weaver';
const SMELTER_CLIENT = 'semiont-smelter';

/** The variable the settings of the Librarian and of the Weaver name for the graph database's password. */
const GRAPH_PASSWORD = 'NEO4J_PASSWORD';

/** The models the world's Librarian is told of. Each stand-in answers for any. */
export const MATCHER_MODEL = 'conformance-matcher';
export const GATHERER_MODEL = 'conformance-gatherer';
export const EMBEDDING_MODEL = 'conformance-embedder';

/** How long the world's Librarian waits for a resource's vectors to settle, and the floor of its semantic fallback: what a deployment that states neither is given. */
export const SETTLE_TIMEOUT_MS = 15_000;
export const SEMANTIC_FLOOR = 0.6;

/** Who records and who asks, where a case does not say. */
const PERSON = 'ada';

// ── The eight operations ───────────────────────────────────────────────────

/**
 * What a Librarian answers: each request channel, with the channel of its
 * result and of its failure. The types of a request and of its replies are
 * read from this table, and `create` holds the table to the bus registry.
 */
export const OPERATIONS = {
  'match:search-requested': ['match:search-results', 'match:search-failed'],
  'match:resources-requested': ['match:resources-result', 'match:resources-failed'],
  'match:limits-requested': ['match:limits-result', 'match:limits-failed'],
  'gather:requested': ['gather:complete', 'gather:failed'],
  'gather:resource-requested': ['gather:resource-complete', 'gather:resource-failed'],
  'gather:summary-requested': ['gather:summary-result', 'gather:summary-failed'],
  'gather:referenced-by-requested': ['gather:referenced-by-result', 'gather:referenced-by-failed'],
  'gather:limits-requested': ['gather:limits-result', 'gather:limits-failed'],
} as const satisfies Record<string, readonly [keyof EventMap, keyof EventMap]>;

export type Operation = keyof typeof OPERATIONS;

/** A payload as a case writes one: an id is the string a case holds, and every other member is as the spec types it. */
export type Plain<T> = T extends string & { readonly __brand: string }
  ? string
  : T extends readonly (infer Item)[]
    ? Plain<Item>[]
    : T extends object
      ? { [Member in keyof T]: Plain<T[Member]> }
      : T;

/** What an operation is asked with. */
export type Asked<O extends Operation> = Plain<EventMap[O]>;
/** What an operation's result channel carries. */
export type Answered<O extends Operation> = EventMap[(typeof OPERATIONS)[O][0]];
/** What an operation's failure channel carries. */
export type Failed<O extends Operation> = EventMap[(typeof OPERATIONS)[O][1]];
/** The one reply to a request: its result, or its failure. */
export type Reply<O extends Operation> = { ok: true; reply: Answered<O> } | { ok: false; failure: Failed<O> };

/** A decision a Smelter signals on `smelt:settled`. */
export type Settled = components['schemas']['SmeltSettled'];
/** What a Weaver signals on `weave:applied`. */
export interface Applied {
  resourceId: string;
  sequenceNumber: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What the registry's schema for `channel` says against `payload`: undefined
 * when the payload is what the channel carries. An `envelope` channel carries
 * its schema under `response`.
 */
function against(channel: string, payload: unknown): string | undefined {
  const row = registry().channels.find((c) => c.channel === channel);
  if (row === undefined) return 'the registry does not declare the channel';
  if (row.schema === undefined || (row.shape !== 'schema' && row.shape !== 'envelope')) return 'the registry names no schema for the channel';
  const carried = row.shape === 'envelope' ? (isObject(payload) ? payload['response'] : undefined) : payload;
  const validate = spec().component(row.schema);
  return validate(carried) ? undefined : `not a ${row.schema}: ${errorsOf(validate)}`;
}

/** Whether `payload` is what the registry says `channel` carries. */
function holds<T>(channel: string, payload: unknown): payload is T {
  return against(channel, payload) === undefined;
}

/** Fail unless `OPERATIONS` is the registry's own account of the `match:` and `gather:` operations. */
function heldToRegistry(): void {
  const declared = registry().operations.filter((op) => op.request.startsWith('match:') || op.request.startsWith('gather:'));
  const stated = Object.entries(OPERATIONS).map(([request, [result, failure]]) => `${request} ${result} ${failure}`).sort();
  const registered = declared.map((op) => `${op.request} ${op.result} ${op.failure}`).sort();
  if (stated.join('\n') !== registered.join('\n')) {
    throw new Error(`the world's table of a Librarian's operations is not the registry's:\nthe world: ${stated.join(', ')}\nthe registry: ${registered.join(', ')}`);
  }
}

/** What a case may change of how the world's Librarian is launched. */
type Change = Partial<Pick<LibrarianLaunch, 'settings' | 'env'>>;

interface Parts {
  kb: ArchivistWorld;
  /** How the Librarian is started: its line of `LIBRARIAN_SERVICES`. */
  command: readonly string[];
  settings: LibrarianSettings;
  env: LibrarianEnvironment;
  home: string;
  port: number;
  matcher: StandInOllama;
  gatherer: StandInOllama;
  embedder: StandInEmbedder;
  smelterEmbedder: StandInEmbedder;
  weaver: WeaverLaunch;
  smelter: SmelterLaunch;
  index: VectorIndex;
  signals: BusStream;
  hand: Driver;
  database: string;
}

export class LibrarianWorld {
  /** The knowledge base: where a case records, and reads the record. */
  readonly kb: ArchivistWorld;
  /** What the world's Librarian is told. */
  readonly settings: LibrarianSettings;
  /** The stand-in for the Matcher's model: what a case scripts of it, and the prompts it was sent. */
  readonly matcher: StandInOllama;
  /** The stand-in for the Gatherer's model: what a case scripts of it, and the prompts it was sent. */
  readonly gatherer: StandInOllama;
  /** The stand-in for the Librarian's embedding provider: what the Librarian asked it. */
  readonly embedder: StandInEmbedder;
  /** The stand-in for the Smelter's embedding provider. */
  readonly smelterEmbedder: StandInEmbedder;

  private librarianProcess: LibrarianProcess | undefined;
  private weaverProcess: WeaverProcess | undefined;
  private smelterProcess: SmelterProcess | undefined;
  private lastOutput: string[] = [];
  private lastWeaverOutput: string[] = [];
  private lastSmelterOutput: string[] = [];
  /** The people the running case has recorded or asked as, each on a stream that is closed when the case ends. */
  private readonly people = new Map<string, BusClient>();
  /** What each resource a case made holds, as it was uploaded. */
  private readonly contents = new Map<string, string | Buffer>();

  private constructor(private readonly parts: Parts) {
    this.kb = parts.kb;
    this.settings = parts.settings;
    this.matcher = parts.matcher;
    this.gatherer = parts.gatherer;
    this.embedder = parts.embedder;
    this.smelterEmbedder = parts.smelterEmbedder;
  }

  static async create(command: readonly string[]): Promise<LibrarianWorld> {
    heldToRegistry();
    const graphDatabase = inject('graphDatabase');
    const vectorDatabase = inject('vectorDatabase');
    const weaverService = inject('weaverServices')['python'];
    const smelterCommand = inject('smelterServices')['python'];
    if (!weaverService || !smelterCommand) throw new Error('the librarian suite starts the Python Weaver and the Python Smelter, and harness/paths.ts does not name both');

    const secrets = { librarian: randomBytes(24).toString('hex'), weaver: randomBytes(24).toString('hex'), smelter: randomBytes(24).toString('hex') };
    const kb = await ArchivistWorld.create({
      gitSync: false,
      accounts: {
        [LIBRARIAN_CLIENT]: { secret: secrets.librarian, roles: [SERVICE_ROLE] },
        [WEAVER_CLIENT]: { secret: secrets.weaver, roles: [SERVICE_ROLE] },
        [SMELTER_CLIENT]: { secret: secrets.smelter, roles: [SERVICE_ROLE] },
      },
    });
    const matcher = await startOllama();
    const gatherer = await startOllama();
    const embedder = await startOllamaEmbed();
    const smelterEmbedder = await startOllamaEmbed();

    // A standing stream of what the Weaver says it has applied and the Smelter says it has decided, open before either runs.
    const { token } = await kb.world.agent('conformance', 'librarian-watch', [SERVICE_ROLE]);
    const signals = await kb.world.subscribe(token, { clientId: randomUUID(), global: ['weave:applied', 'smelt:settled'] }, undefined, true);
    signals.on((message) => {
      const frame = message.frame;
      if (!frame) return;
      const said = against(frame.channel, unstamped(frame.payload));
      if (said !== undefined) signals.violations.push(`${frame.channel} carried a payload that is ${said}: ${JSON.stringify(frame.payload).slice(0, 400)}`);
    });

    const graph = { uri: `bolt://${graphDatabase.host}:7687`, username: 'neo4j', database: 'neo4j', passwordEnv: GRAPH_PASSWORD };
    const gatewayUrl = kb.world.origin;
    const issuer = kb.world.issuer.origin;
    const archivist = { host: '127.0.0.1', port: kb.settings.port };
    const world = new LibrarianWorld({
      kb,
      command,
      settings: {
        gatewayUrl,
        issuer,
        kbName: kb.world.kb.name,
        // The state volume is the one the Archivist writes the views into.
        stateHome: kb.dirs.stateHome,
        archivist,
        graph: { type: 'neo4j', ...graph },
        vectors: { type: 'qdrant', host: vectorDatabase.host, port: QDRANT_PORT },
        embedding: { type: 'ollama', model: EMBEDDING_MODEL, baseUrl: embedder.origin },
        matcher: { type: 'ollama', model: MATCHER_MODEL, baseUrl: matcher.origin },
        gatherer: { type: 'ollama', model: GATHERER_MODEL, baseUrl: gatherer.origin },
        settleTimeoutMs: SETTLE_TIMEOUT_MS,
        semanticFloor: SEMANTIC_FLOOR,
      },
      env: { SEMIONT_OIDC_CLIENT_ID: LIBRARIAN_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secrets.librarian, [GRAPH_PASSWORD]: graphDatabase.password },
      home: mkdtempSync(join(tmpdir(), 'conformance-librarian-')),
      // Its document tells a Librarian its health port, and each world's is told a free one.
      port: await freePort(),
      matcher,
      gatherer,
      embedder,
      smelterEmbedder,
      weaver: {
        service: weaverService,
        settings: { gatewayUrl, issuer, graph },
        env: { SEMIONT_OIDC_CLIENT_ID: WEAVER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secrets.weaver, [GRAPH_PASSWORD]: graphDatabase.password },
        home: mkdtempSync(join(tmpdir(), 'conformance-librarian-weaver-')),
      },
      smelter: {
        command: smelterCommand,
        settings: {
          gatewayUrl,
          issuer,
          archivist,
          vectors: { type: 'qdrant', host: vectorDatabase.host, port: QDRANT_PORT },
          embedding: { type: 'ollama', model: EMBEDDING_MODEL, baseUrl: smelterEmbedder.origin },
          chunking: { chunkSize: 512, overlap: 64 },
          // The store's directory is the one the Archivist is configured to read.
          anchoredTextDir: kb.dirs.anchoredTextDir,
          pdfsAtOnce: 1,
        },
        env: { SEMIONT_OIDC_CLIENT_ID: SMELTER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secrets.smelter },
        home: mkdtempSync(join(tmpdir(), 'conformance-librarian-smelter-')),
      },
      index: vectorIndex(vectorDatabase.host),
      signals,
      hand: neo4j.driver(graph.uri, neo4j.auth.basic(graph.username, graphDatabase.password)),
      database: graph.database,
    });
    try {
      // Both stores are emptied before either writer runs, and the writers run before the reader does.
      await world.clearStores();
      await world.startWeaver();
      await world.startSmelter();
      await world.startLibrarian();
    } catch (error) {
      // What was started is stopped, and the failure that is reported is the first one.
      await world.close().catch(() => undefined);
      throw error;
    }
    return world;
  }

  // ── The Librarian ─────────────────────────────────────────────────────────

  /** The running Librarian. */
  get librarian(): LibrarianProcess {
    if (!this.librarianProcess) throw new Error('the case stopped the Librarian and has not started it again');
    return this.librarianProcess;
  }

  /** Every line the Librarian has written: the running one's, or those of the one that ran last. */
  get output(): string[] {
    return this.librarianProcess?.output ?? this.lastOutput;
  }

  /** What a case launches a Librarian of its own with: this world's, changed as the case says. */
  launch(change: Change = {}): LibrarianLaunch {
    return { command: this.parts.command, settings: this.settings, env: this.parts.env, home: this.parts.home, port: this.parts.port, ...change };
  }

  /**
   * Start the Librarian, as this world launches one or as a case changes
   * that, and wait until its health answers and it answers on the bus. Its
   * health says its stream to the gateway is asked for, not that it is open;
   * until it is, a request reaches no one.
   */
  async startLibrarian(change: Change = {}): Promise<void> {
    if (this.librarianProcess) throw new Error('a Librarian is already running in this world');
    this.librarianProcess = await startLibrarian(this.launch(change));
    const probe = await this.person(PERSON);
    await eventually('the Librarian to answer on the bus', 30_000, async () => {
      const answer = await probe.request('gather:referenced-by-requested', { resourceId: 'asked-of-no-resource' }, 5_000).catch(() => undefined);
      return answer === undefined || answer.payload['code'] === 'peer-unavailable' ? undefined : true;
    });
  }

  /** SIGTERM, and wait: its exit code. */
  async stopLibrarian(): Promise<number | null> {
    const stopping = this.librarian;
    const code = await stopping.stop();
    this.lastOutput = stopping.output;
    this.librarianProcess = undefined;
    return code;
  }

  /** Stop the Librarian and start it again, as this world launches one or as a case changes that. */
  async restartLibrarian(change: Change = {}): Promise<void> {
    await this.stopLibrarian();
    await this.startLibrarian(change);
  }

  /**
   * A Librarian that must refuse to start, launched as `change` says beside
   * this world's: its exit code and its output. The world's own Librarian is
   * stopped first: both are given the world's one health port.
   */
  async refused(change: Change, timeoutMs = 60_000): Promise<{ code: number | null; output: string }> {
    if (this.librarianProcess) throw new Error("the world's Librarian is running: stop it before starting one that must refuse, since both would answer on one health port");
    const home = mkdtempSync(join(tmpdir(), 'conformance-librarian-refused-'));
    try {
      return await refusedLibrarianBoot({ ...this.launch(change), home }, timeoutMs);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  // ── The two writers ───────────────────────────────────────────────────────

  /** Every line the Weaver has written: the running one's, or those of the one that ran last. */
  get weaverOutput(): string[] {
    return this.weaverProcess?.output ?? this.lastWeaverOutput;
  }

  /** Every line the Smelter has written: the running one's, or those of the one that ran last. */
  get smelterOutput(): string[] {
    return this.smelterProcess?.output ?? this.lastSmelterOutput;
  }

  /** Start the Weaver and wait until both of its boot passes have ended: it then holds in the graph what the record held when it started. */
  async startWeaver(): Promise<void> {
    if (this.weaverProcess) throw new Error('a Weaver is already running in this world');
    this.weaverProcess = await startWeaver(this.parts.weaver);
  }

  /** SIGTERM, and wait: its exit code. What is recorded while it is stopped is not in the graph until it is started again. */
  async stopWeaver(): Promise<number | null> {
    if (!this.weaverProcess) throw new Error('the Weaver is not running in this world');
    const code = await this.weaverProcess.stop();
    this.lastWeaverOutput = this.weaverProcess.output;
    this.weaverProcess = undefined;
    return code;
  }

  /** Start the Smelter and wait until its reconcile has ended: it then holds in the index what the record held when it started. */
  async startSmelter(): Promise<void> {
    if (this.smelterProcess) throw new Error('a Smelter is already running in this world');
    this.smelterProcess = await startSmelter(this.parts.smelter);
  }

  /** SIGTERM, and wait: its exit code. What is recorded while it is stopped has no vectors, and is not signalled as settled, until it is started again. */
  async stopSmelter(): Promise<number | null> {
    if (!this.smelterProcess) throw new Error('the Smelter is not running in this world');
    const code = await this.smelterProcess.stop();
    this.lastSmelterOutput = this.smelterProcess.output;
    this.smelterProcess = undefined;
    return code;
  }

  /** The index the Smelter writes, read by the suite's own calls. */
  get index(): Omit<VectorIndex, 'clear'> {
    return this.parts.index;
  }

  /** Empty the graph database and the index, as wiped volumes leave them. Only while neither writer runs. */
  private async clearStores(): Promise<void> {
    if (this.weaverProcess || this.smelterProcess) throw new Error('the stores are cleared only while neither the Weaver nor the Smelter runs');
    await this.parts.hand.executeQuery('MATCH (n) DETACH DELETE n', {}, { database: this.parts.database });
    await this.parts.index.clear();
  }

  // ── What a case records, as a person, through the Archivist ───────────────

  private async person(sub: string): Promise<BusClient> {
    let who = this.people.get(sub);
    if (!who) {
      who = await this.kb.person(sub);
      this.people.set(sub, who);
    }
    return who;
  }

  /** The DID a person is named by: who a reply says made a thing. */
  personDid(sub = PERSON): string {
    return this.kb.world.personDid(sub);
  }

  /** Upload `content` as a resource: its id, once the record holds it. A text unless `format` says otherwise. */
  async created(content: string | Buffer, options: { name?: string; format?: string; by?: string } = {}): Promise<string> {
    const resourceId = await this.kb.created(this.personDid(options.by), {
      name: options.name ?? 'A resource',
      storageUri: `file://librarian/${randomUUID()}`,
      format: options.format ?? 'text/plain',
      content,
    });
    this.contents.set(resourceId, content);
    // The gateway of an Archivist world reads a resource's anchored text from the harness's stand-in Archivist.
    // What the stand-in answers for this resource is what the real Archivist answers when it is asked.
    this.kb.world.archivist.anchoredTexts.set(resourceId, () => this.kb.anchoredText(resourceId));
    return resourceId;
  }

  /** A resource's entity types, as the record holds them now. */
  entityTypes(resourceId: string): string[] {
    const view = this.kb.view(resourceId);
    if (view === undefined) throw new Error(`the record holds no resource ${resourceId}`);
    return view.resource.entityTypes ?? [];
  }

  /** Give a resource an entity type, having put the type in the knowledge base's vocabulary; resolves once the record holds it. */
  async tagged(resourceId: string, entityType: string, by = PERSON): Promise<void> {
    const who = await this.person(by);
    const current = this.entityTypes(resourceId);
    if (current.includes(entityType)) throw new Error(`${resourceId} already has the entity type ${entityType}: nothing would be recorded`);
    // An entity type joins the vocabulary before a resource is given it: the Archivist refuses one that has not.
    const vocabulary = this.kb.projection<components['schemas']['EntityTypesProjection']>('entitytypes.json')?.entityTypes ?? [];
    if (!vocabulary.includes(entityType)) await who.ask('frame:add-entity-type', { tag: entityType });
    await who.ask('mark:update-entity-types', { resourceId, currentEntityTypes: current, updatedEntityTypes: [...current, entityType] });
  }

  /** Archive a resource; resolves once the record holds it. */
  async archived(resourceId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('mark:archive', { resourceId });
  }

  /**
   * The target of an annotation on the first place `exact` occurs in a text
   * resource a case made: where it is, counted in code points, and what it
   * quotes.
   */
  private target(resourceId: string, exact: string): Record<string, unknown> {
    const content = this.contents.get(resourceId);
    if (typeof content !== 'string') throw new Error(`${resourceId} is not a text this world uploaded: a case annotates the texts it made`);
    const at = content.indexOf(exact);
    if (at < 0) throw new Error(`${resourceId} does not hold ${JSON.stringify(exact)}`);
    const start = Array.from(content.slice(0, at)).length;
    return {
      source: resourceId,
      selector: [
        { type: 'TextPositionSelector', start, end: start + Array.from(exact).length },
        { type: 'TextQuoteSelector', exact },
      ],
    };
  }

  private async annotation(resourceId: string, motivation: string, exact: string, by: string): Promise<string> {
    const answer = await (await this.person(by)).ask('mark:create-request', { resourceId, request: { motivation, target: this.target(resourceId, exact) } });
    return String(answer['annotationId']);
  }

  /** A highlight of `exact` in a text resource: its id, once the record holds it. */
  highlighted(resourceId: string, exact: string, by = PERSON): Promise<string> {
    return this.annotation(resourceId, 'highlighting', exact, by);
  }

  /**
   * A reference on `exact` in a text resource, which links nowhere yet: its
   * id, once the record holds it and holds each of `entityTypes` as an entity
   * tag in its body.
   */
  async referenced(resourceId: string, exact: string, options: { entityTypes?: readonly string[]; by?: string } = {}): Promise<string> {
    const by = options.by ?? PERSON;
    const annotationId = await this.annotation(resourceId, 'linking', exact, by);
    const tags = (options.entityTypes ?? []).map((value) => ({ op: 'add', item: { type: 'TextualBody', value, purpose: 'tagging' } }));
    if (tags.length > 0) await (await this.person(by)).ask('bind:update-body', { resourceId, annotationId, operations: tags });
    return annotationId;
  }

  /** Bind a reference to another resource: resolves once the record holds the link in the reference's body. */
  async bound(resourceId: string, annotationId: string, toResourceId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('bind:update-body', {
      resourceId,
      annotationId,
      operations: [{ op: 'add', item: { type: 'SpecificResource', source: toResourceId, purpose: 'linking' } }],
    });
  }

  /** Remove an annotation; resolves once the record holds it. */
  async unannotated(resourceId: string, annotationId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('mark:delete', { resourceId, annotationId });
  }

  // ── What the two writers say they have done ───────────────────────────────

  /** Every `weave:applied` the Weaver has signalled since the world was made, oldest first; of one resource when one is named. */
  appliedSignals(resourceId?: string): Applied[] {
    return this.parts.signals
      .frames('weave:applied')
      .map((frame) => ({ resourceId: String(frame.payload['resourceId']), sequenceNumber: Number(frame.payload['sequenceNumber']) }))
      .filter((signal) => resourceId === undefined || signal.resourceId === resourceId);
  }

  /** Every decision the Smelter has signalled on `smelt:settled` since the world was made, oldest first; of one resource when one is named. */
  settledSignals(resourceId?: string): Settled[] {
    return this.parts.signals
      .frames('smelt:settled')
      .map((frame): unknown => unstamped(frame.payload))
      .filter((signal): signal is Settled => holds<Settled>('smelt:settled', signal))
      .filter((signal) => resourceId === undefined || signal.resourceId === resourceId);
  }

  /**
   * Wait until the Weaver signals that it has applied everything it follows
   * of what the record holds now for each of `resourceIds`: the graph then
   * holds each resource and its annotations as the record does.
   */
  async woven(...resourceIds: string[]): Promise<void> {
    for (const resourceId of resourceIds) {
      const followed = this.kb.stored(resourceId).filter((event) => FOLLOWED.includes(event.type));
      const last = followed[followed.length - 1];
      if (last === undefined) throw new Error(`the record holds no event a Weaver follows for ${resourceId}`);
      await eventually(`weave:applied for ${resourceId} to reach ${last.metadata.sequenceNumber}`, 20_000, () =>
        this.appliedSignals(resourceId).find((signal) => signal.sequenceNumber >= last.metadata.sequenceNumber),
      );
    }
  }

  /**
   * Wait until the Smelter signals its decision about the content a resource
   * was uploaded with: that decision, `indexed` or `skipped`. The index holds
   * the resource's vectors once it is `indexed`.
   */
  settled(resourceId: string, timeoutMs = 20_000): Promise<Settled> {
    const content = this.contents.get(resourceId);
    if (content === undefined) throw new Error(`${resourceId} is not a resource this world uploaded`);
    const checksum = sha256(content);
    return eventually(`smelt:settled of ${resourceId} at ${checksum}`, timeoutMs, () => this.settledSignals(resourceId).find((signal) => signal.contentChecksum === checksum));
  }

  /** Wait until each of `resourceIds` is woven and settled: both stores hold what the record holds of it. */
  async ready(...resourceIds: string[]): Promise<void> {
    await this.woven(...resourceIds);
    for (const resourceId of resourceIds) await this.settled(resourceId);
  }

  // ── What a Librarian is asked ─────────────────────────────────────────────

  /**
   * Ask the Librarian one of its eight operations, as a person who is signed
   * in, and read the one reply: its result or its failure, each held to what
   * the registry says its channel carries. A reply that is neither in time
   * fails the case.
   */
  async ask<O extends Operation>(operation: O, payload: Asked<O>, options: { as?: string; timeoutMs?: number } = {}): Promise<Reply<O>> {
    const [result, failure] = OPERATIONS[operation];
    const sent: unknown = payload;
    if (!isObject(sent)) throw new Error(`${operation} is asked with an object`);
    const answer = await (await this.person(options.as ?? PERSON)).request(operation, sent, options.timeoutMs ?? 30_000);
    const carried: unknown = answer.payload;
    if (answer.ok) {
      if (!holds<Answered<O>>(result, carried)) throw new Error(`${result} carried a payload that is ${against(result, carried)}: ${JSON.stringify(carried).slice(0, 400)}`);
      return { ok: true, reply: carried };
    }
    if (!holds<Failed<O>>(failure, carried)) throw new Error(`${failure} carried a payload that is ${against(failure, carried)}: ${JSON.stringify(carried).slice(0, 400)}`);
    return { ok: false, failure: carried };
  }

  /** Ask an operation the Librarian must answer on its result channel: what that channel carried. */
  async answered<O extends Operation>(operation: O, payload: Asked<O>, options: { as?: string; timeoutMs?: number } = {}): Promise<Answered<O>> {
    const reply = await this.ask(operation, payload, options);
    if (!reply.ok) throw new Error(`${operation} failed, and should have been answered: ${JSON.stringify(reply.failure)}`);
    return reply.reply;
  }

  /** Ask an operation the Librarian must fail: what its failure channel carried. */
  async failed<O extends Operation>(operation: O, payload: Asked<O>, options: { as?: string; timeoutMs?: number } = {}): Promise<Failed<O>> {
    const reply = await this.ask(operation, payload, options);
    if (reply.ok) throw new Error(`${operation} was answered, and should have failed: ${JSON.stringify(reply.reply).slice(0, 400)}`);
    return reply.failure;
  }

  // ── Between cases, and at the end ─────────────────────────────────────────

  /**
   * Every violation since the last call: carried by the streams the case
   * opened, which are then closed, or asked of a stand-in. What the case
   * scripted of the stand-ins, and what they recorded, is forgotten.
   */
  drain(): string[] {
    this.people.clear();
    const standIns = [this.matcher, this.gatherer, this.embedder, this.smelterEmbedder];
    const violations = [...this.kb.drain(), ...this.parts.signals.violations.splice(0), ...standIns.flatMap((standIn) => standIn.violations.splice(0))];
    for (const standIn of standIns) standIn.reset();
    return violations;
  }

  /** Stop the three services, leave both stores empty for the next file, and close everything the world made. */
  async close(): Promise<void> {
    try {
      if (this.librarianProcess) await this.stopLibrarian();
      if (this.smelterProcess) await this.stopSmelter();
      if (this.weaverProcess) await this.stopWeaver();
      await this.clearStores();
    } finally {
      await this.parts.hand.close();
      for (const standIn of [this.matcher, this.gatherer, this.embedder, this.smelterEmbedder]) await standIn.close();
      await this.kb.close();
      for (const home of [this.parts.home, this.parts.weaver.home, this.parts.smelter.home]) rmSync(home, { recursive: true, force: true });
    }
  }
}

/**
 * Run `body`'s cases against one Librarian world for each implementation of
 * the Librarian. After every case, the streams it opened must have carried
 * nothing the spec does not allow, and no stand-in must have been asked what
 * it does not serve or what no case scripted.
 */
export function eachLibrarian(title: string, body: (world: () => LibrarianWorld) => void): void {
  describe.each(Object.entries(inject('librarianServices')))(`${title} (the %s Librarian)`, (_implementation, command) => {
    let world: LibrarianWorld | undefined;
    beforeAll(async () => {
      world = await LibrarianWorld.create(command);
    }, 300_000);
    afterAll(async () => {
      await world?.close();
    }, 120_000);
    afterEach((context) => {
      if (context.task.result?.state === 'fail') {
        console.error(`Librarian output:\n${world?.output.join('\n')}`);
        console.error(`Weaver output:\n${world?.weaverOutput.slice(-40).join('\n')}`);
        console.error(`Smelter output:\n${world?.smelterOutput.slice(-40).join('\n')}`);
        console.error(`Archivist output:\n${world?.kb.archivist.output.slice(-40).join('\n')}`);
      }
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!);
  });
}
