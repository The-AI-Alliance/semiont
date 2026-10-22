/**
 * A Smelter world: a Smelter process and everything it meets. That is an
 * Archivist world (a knowledge base, a real Archivist that records and
 * answers, a gateway, the trusted issuer), the Smelter's own service account
 * at that issuer, a real Qdrant, cleared when the world is made and when it
 * is closed, and a stand-in for its embedding provider. The anchored-text
 * store is the Archivist's: the Smelter mounts none of it, and keeps it on
 * the Archivist's surface.
 *
 * Cases meet the Smelter where the rest of Semiont does: in the index it
 * writes and in the anchored-text store, each read here by the suite's own
 * hand; on the bus, where it signals what it has decided and answers a
 * rebuild; at its health port; at its provider; and in what it writes to its
 * output. Nothing is recorded but through the Archivist, as people record: the
 * Smelter is given the events the record gives it, and reads the bytes the
 * Archivist serves.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject } from 'vitest';
import type { components } from '@semiont/core';
import { ArchivistWorld, sha256, shardOf, unstamped, type Answer, type BusClient } from './archivist-world';
import { eventually } from './net';
import { startOllamaEmbed, type StandInEmbedder } from './ollama-embed';
import { QDRANT_PORT, vectorIndex, type VectorIndex } from './qdrant';
import { SERVICE_ROLE } from './roles';
import {
  CURSORS,
  refusedSmelterBoot,
  startSmelter,
  type SmelterEnvironment,
  type SmelterHealth,
  type SmelterLaunch,
  type SmelterProcess,
  type SmelterSettings,
} from './smelter-process';
import { errorsOf, spec } from './spec';
import type { BusStream } from './stream';

/** The Smelter's service account at the issuer. */
export const SMELTER_CLIENT = 'semiont-smelter';

/** The model the world's Smelter is told to embed with. The stand-in answers for any. */
export const EMBEDDING_MODEL = 'conformance-embedder';

/** Who records, where a case does not say. */
const PERSON = 'ada';

/** A decision a Smelter signals on `smelt:settled`. */
export type Settled = components['schemas']['SmeltSettled'];

/** One entry of the anchored-text store. */
export type AnchoredTextEntry = components['schemas']['AnchoredTextEntry'];

/** What a case may change of how the world's Smelter is launched. */
type Change = Partial<Pick<SmelterLaunch, 'settings' | 'env'>>;

export class SmelterWorld {
  private smelterProcess: SmelterProcess | undefined;
  private lastOutput: string[] = [];
  /** The people the running case has recorded as, each on a stream that is closed when the case ends. */
  private readonly people = new Map<string, BusClient>();

  private constructor(
    /** The knowledge base: where a case records, and reads the record. */
    readonly kb: ArchivistWorld,
    private readonly wholeIndex: VectorIndex,
    /** The stand-in for the Smelter's embedding provider: what it was sent, and what a case scripts of it. */
    readonly provider: StandInEmbedder,
    private readonly command: readonly string[],
    readonly settings: SmelterSettings,
    private readonly env: SmelterEnvironment,
    private readonly home: string,
    private readonly signals: BusStream,
  ) {}

  static async create(command: readonly string[]): Promise<SmelterWorld> {
    const { host } = inject('vectorDatabase');
    const secret = randomBytes(24).toString('hex');
    const kb = await ArchivistWorld.create({ gitSync: false, accounts: { [SMELTER_CLIENT]: { secret, roles: [SERVICE_ROLE] } } });
    const provider = await startOllamaEmbed();

    // A standing stream of what the Smelter says it has decided, open before any Smelter is.
    const { token } = await kb.world.agent('conformance', 'smelter-watch', [SERVICE_ROLE]);
    const signals = await kb.world.subscribe(token, { clientId: randomUUID(), global: ['smelt:settled'] }, undefined, true);
    signals.on((message) => {
      const frame = message.frame;
      if (frame?.channel !== 'smelt:settled') return;
      const validate = spec().component('SmeltSettled');
      if (!validate(unstamped(frame.payload))) {
        signals.violations.push(`smelt:settled carried a payload that is not a SmeltSettled (${errorsOf(validate)}): ${JSON.stringify(frame.payload).slice(0, 400)}`);
      }
    });

    const world = new SmelterWorld(
      kb,
      vectorIndex(host),
      provider,
      command,
      {
        gatewayUrl: kb.world.origin,
        issuer: kb.world.issuer.origin,
        archivist: { host: '127.0.0.1', port: kb.settings.port },
        vectors: { type: 'qdrant', host, port: QDRANT_PORT },
        embedding: { type: 'ollama', model: EMBEDDING_MODEL, baseUrl: provider.origin },
        chunking: { chunkSize: 512, overlap: 64 },
        pdfsAtOnce: 1,
      },
      { SEMIONT_OIDC_CLIENT_ID: SMELTER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secret },
      mkdtempSync(join(tmpdir(), 'conformance-smelter-')),
      signals,
    );
    try {
      await world.clearIndex();
      await world.start();
    } catch (error) {
      // What was started is stopped, and the failure that is reported is the first one.
      await world.close().catch(() => undefined);
      throw error;
    }
    return world;
  }

  // ── The process ───────────────────────────────────────────────────────────

  /** The running Smelter. */
  get smelter(): SmelterProcess {
    if (!this.smelterProcess) throw new Error('the case stopped the Smelter and has not started it again');
    return this.smelterProcess;
  }

  /** Every line the Smelter has written: the running one's, or those of the one that ran last. */
  get output(): string[] {
    return this.smelterProcess?.output ?? this.lastOutput;
  }

  /** What a case launches a Smelter of its own with: this world's, changed as the case says. */
  launch(change: Change = {}): SmelterLaunch {
    return { command: this.command, settings: this.settings, env: this.env, home: this.home, ...change };
  }

  /**
   * Start the Smelter, as this world launches one or as a case changes that,
   * and wait until its start has ended, however it ended. Each start is of a
   * container made again, as every `semiont start` makes one: no cursor of an
   * earlier start is left, so every resource the record holds is started by a
   * reconcile (SMELTER.md § Reconcile). With `until` `serving`, wait only
   * until its health answers: its reconcile may still be at work, and
   * `reconciled()` waits for it.
   */
  async start(change: Change = {}, until: 'serving' | 'started' = 'started'): Promise<void> {
    if (this.smelterProcess) throw new Error('a Smelter is already running in this world');
    rmSync(join(this.launch(change).home, CURSORS), { force: true });
    this.smelterProcess = await startSmelter(this.launch(change), until);
  }

  private stopped(): void {
    this.lastOutput = this.smelter.output;
    this.smelterProcess = undefined;
  }

  /** SIGTERM, and wait: its exit code. */
  async stop(): Promise<number | null> {
    const code = await this.smelter.stop();
    this.stopped();
    return code;
  }

  /** SIGKILL, and wait: the Smelter ends with nothing settled on its way out. */
  async crash(): Promise<void> {
    await this.smelter.crash();
    this.stopped();
  }

  /** Stop the Smelter and start it again. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * A Smelter that must refuse to start, launched as `change` says beside
   * this world's: its exit code and its output. The world's own Smelter is
   * stopped first: a Smelter's health port is a constant.
   */
  async refused(change: Change): Promise<{ code: number | null; output: string }> {
    if (this.smelterProcess) throw new Error("the world's Smelter is running: stop it before starting one that must refuse, since both would answer on one health port");
    const home = mkdtempSync(join(tmpdir(), 'conformance-smelter-refused-'));
    try {
      return await refusedSmelterBoot({ ...this.launch(change), home });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  /** Wait until the Smelter's reconcile has ended, however it ended: its health then. */
  reconciled(timeoutMs = 60_000): Promise<SmelterHealth> {
    return eventually("the Smelter's reconcile to end", timeoutMs, async () => {
      const health = await this.smelter.health();
      return health.reconcile.phase === 'done' || health.reconcile.phase === 'failed' ? health : undefined;
    });
  }

  /** Wait until the Smelter's health says it has applied at least `count` events since it started: its health then. */
  applied(count: number, timeoutMs = 20_000): Promise<SmelterHealth> {
    return eventually(`the Smelter to have applied ${count} event(s)`, timeoutMs, async () => {
      const health = await this.smelter.health();
      return health.eventsProcessed >= count ? health : undefined;
    });
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

  /** Where the record says a resource's content is stored. */
  private storageUri(resourceId: string): string {
    const view = this.kb.view(resourceId);
    const uri = view === undefined ? undefined : [view.resource.representations].flat()[0]?.storageUri;
    if (uri === undefined) throw new Error(`the record holds no stored content for ${resourceId}`);
    return uri;
  }

  /** The file of the working tree that holds a resource's content: a case removes it to leave the resource's bytes unreadable. */
  contentFile(resourceId: string): string {
    return this.kb.contentPath(this.storageUri(resourceId));
  }

  /** A resource's entity types, as the record holds them now. */
  entityTypes(resourceId: string): string[] {
    const view = this.kb.view(resourceId);
    if (view === undefined) throw new Error(`the record holds no resource ${resourceId}`);
    return view.resource.entityTypes ?? [];
  }

  /** Upload `content` as a resource of the media type `format`: its id, once the record holds it. */
  created(content: string | Buffer, format: string, options: { name?: string; by?: string } = {}): Promise<string> {
    return this.kb.created(this.kb.world.personDid(options.by ?? PERSON), {
      name: options.name ?? 'A resource',
      storageUri: `file://smelter/${randomUUID()}`,
      format,
      content,
    });
  }

  /** Give a resource new content, which is put where its content is stored and recorded by `yield:update`: the new content's checksum, once the record holds it. */
  async updated(resourceId: string, content: string | Buffer, by = PERSON): Promise<string> {
    const uri = this.storageUri(resourceId);
    this.kb.write(uri, content);
    const checksum = sha256(content);
    await (await this.person(by)).ask('yield:update', { resourceId, storageUri: uri, contentChecksum: checksum, byteSize: Buffer.byteLength(content) });
    return checksum;
  }

  /** Archive a resource; resolves once the record holds it. */
  async archived(resourceId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('mark:archive', { resourceId });
  }

  /** Unarchive a resource; resolves once the record holds it. */
  async unarchived(resourceId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('mark:unarchive', { resourceId });
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

  /** Take an entity type from a resource; resolves once the record holds it. */
  async untagged(resourceId: string, entityType: string, by = PERSON): Promise<void> {
    const current = this.entityTypes(resourceId);
    if (!current.includes(entityType)) throw new Error(`${resourceId} does not have the entity type ${entityType}: nothing would be recorded`);
    await (await this.person(by)).ask('mark:update-entity-types', { resourceId, currentEntityTypes: current, updatedEntityTypes: current.filter((type) => type !== entityType) });
  }

  private async annotation(resourceId: string, target: Record<string, unknown>, options: { motivation?: string; body?: unknown; by?: string }): Promise<string> {
    const request = { motivation: options.motivation ?? 'highlighting', target, ...(options.body === undefined ? {} : { body: options.body }) };
    const answer = await (await this.person(options.by ?? PERSON)).ask('mark:create-request', { resourceId, request });
    return String(answer['annotationId']);
  }

  /**
   * An annotation on a resource whose target quotes `exact`: its id, once the
   * record holds it. The target says what it quotes and not where: a Smelter
   * reads the quotation and nothing else of a target.
   */
  annotated(resourceId: string, exact: string, options: { motivation?: string; body?: unknown; by?: string } = {}): Promise<string> {
    return this.annotation(resourceId, { type: 'SpecificResource', source: resourceId, selector: { type: 'TextQuoteSelector', exact } }, options);
  }

  /** An annotation of a resource as a whole, which quotes no text: its id, once the record holds it. */
  annotatedWhole(resourceId: string, options: { motivation?: string; body?: unknown; by?: string } = {}): Promise<string> {
    return this.annotation(resourceId, { source: resourceId }, options);
  }

  /** Give an annotation's body an entity tag for each of `entityTypes`, after whatever it states; resolves once the record holds it. */
  async bodyTagged(resourceId: string, annotationId: string, entityTypes: readonly string[], by = PERSON): Promise<void> {
    const operations = entityTypes.map((value) => ({ op: 'add', item: { type: 'TextualBody', value, purpose: 'tagging' } }));
    await (await this.person(by)).ask('bind:update-body', { resourceId, annotationId, operations });
  }

  /** Remove an annotation; resolves once the record holds it. */
  async unannotated(resourceId: string, annotationId: string, by = PERSON): Promise<void> {
    await (await this.person(by)).ask('mark:delete', { resourceId, annotationId });
  }

  // ── What it says it has decided ───────────────────────────────────────────

  /** Every decision the Smelter has signalled on `smelt:settled` since the world was made, oldest first; of one resource when one is named. */
  settledSignals(resourceId?: string): Settled[] {
    return this.signals
      .frames('smelt:settled')
      .map((frame) => unstamped(frame.payload) as unknown as Settled)
      .filter((signal) => resourceId === undefined || signal.resourceId === resourceId);
  }

  /** Wait for the nth decision the Smelter signals of a resource, its first unless said: that decision. */
  settled(resourceId: string, nth = 1, timeoutMs = 20_000): Promise<Settled> {
    return eventually(`smelt:settled number ${nth} of ${resourceId}`, timeoutMs, () => this.settledSignals(resourceId)[nth - 1]);
  }

  /**
   * Know that the nth decision of a resource, its first unless said, is not
   * signalled within `withinMs`. It watches for that long, and fails at once
   * when the decision comes.
   */
  async unsettled(resourceId: string, nth = 1, withinMs = 3_000): Promise<void> {
    const deadline = Date.now() + withinMs;
    for (;;) {
      const signal = this.settledSignals(resourceId)[nth - 1];
      if (signal !== undefined) throw new Error(`expected no smelt:settled number ${nth} of ${resourceId} within ${withinMs} ms, and got ${JSON.stringify(signal)}`);
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  // ── What it is asked ──────────────────────────────────────────────────────

  /** Ask the Smelter to derive anchored text again, of one resource or of every one, as a service asks: its answer. */
  async rebuildAnchors(resourceId?: string): Promise<Answer> {
    const asker = await this.kb.sidecar('rebuild-anchors');
    return asker.request('smelt:rebuild-anchors', resourceId === undefined ? {} : { resourceId }, 60_000);
  }

  // ── The index ─────────────────────────────────────────────────────────────

  /** The index, read and changed by the suite's own hand. It is cleared by `clearIndex()`, and only there. */
  get index(): Omit<VectorIndex, 'clear'> {
    return this.wholeIndex;
  }

  /**
   * Clear the index: every collection gone, as a wiped volume leaves it. Only
   * while no Smelter runs: one that is running made its collections when it
   * connected, and its next write would fail.
   */
  async clearIndex(): Promise<void> {
    if (this.smelterProcess) throw new Error('the index is cleared only while no Smelter runs: stop it first, and start it again afterwards');
    await this.wholeIndex.clear();
  }

  // ── The anchored-text store ───────────────────────────────────────────────

  private get store(): string {
    return this.kb.dirs.anchoredTextDir;
  }

  private entryPath(checksum: string): string {
    return join(this.store, ...shardOf(checksum).split('/'), `${checksum}.json`);
  }

  /** Every file of the anchored-text store, by its path from the store's directory, sorted. */
  anchoredFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string, from: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const name = from === '' ? entry.name : `${from}/${entry.name}`;
        if (entry.isDirectory()) walk(join(dir, entry.name), name);
        else files.push(name);
      }
    };
    walk(this.store, '');
    return files.sort();
  }

  /** The stamp the store's writer states, in the file `STAMP`; undefined when it states none. */
  anchoredStamp(): string | undefined {
    const path = join(this.store, 'STAMP');
    return existsSync(path) ? readFileSync(path, 'utf8').trim() : undefined;
  }

  /** The store's entry for bytes of this checksum, held to the `AnchoredTextEntry` schema; undefined when it has none. */
  anchoredEntry(checksum: string): AnchoredTextEntry | undefined {
    const path = this.entryPath(checksum);
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const validate = spec().component('AnchoredTextEntry');
    if (!validate(parsed)) throw new Error(`${path} is not an AnchoredTextEntry (${errorsOf(validate)})`);
    return parsed as AnchoredTextEntry;
  }

  /** Take the entry for bytes of this checksum out of the store, behind a Smelter's back. */
  loseAnchoredEntry(checksum: string): void {
    const path = this.entryPath(checksum);
    if (!existsSync(path)) throw new Error(`the anchored-text store has no entry for ${checksum} to lose`);
    rmSync(path);
  }

  /**
   * Empty the anchored-text store, its stamp included, as a wiped volume
   * leaves it. Only while no Smelter runs: a writer states its stamp once.
   */
  clearAnchoredText(): void {
    if (this.smelterProcess) throw new Error('the anchored-text store is cleared only while no Smelter runs: stop it first, and start it again afterwards');
    for (const name of readdirSync(this.store)) rmSync(join(this.store, name), { recursive: true, force: true });
  }

  // ── Between cases, and at the end ─────────────────────────────────────────

  /**
   * Every violation since the last call: carried by the streams the case
   * opened, which are then closed, or asked of the provider. What the case
   * scripted of the provider, and what the provider recorded, is forgotten.
   */
  drain(): string[] {
    this.people.clear();
    const violations = [...this.kb.drain(), ...this.signals.violations.splice(0), ...this.provider.violations.splice(0)];
    this.provider.reset();
    return violations;
  }

  /** Stop the Smelter, leave the index empty for the next file, and close everything the world made. */
  async close(): Promise<void> {
    try {
      if (this.smelterProcess) await this.stop();
      await this.wholeIndex.clear();
    } finally {
      await this.provider.close();
      await this.kb.close();
      rmSync(this.home, { recursive: true, force: true });
    }
  }
}

/**
 * Run `body`'s cases against one Smelter world for each implementation of the
 * Smelter. After every case, the streams it opened must have carried nothing
 * the spec does not allow, and the provider must have been asked nothing it
 * does not serve.
 */
export function eachSmelter(title: string, body: (world: () => SmelterWorld) => void): void {
  describe.each(Object.entries(inject('smelterServices')))(`${title} (the %s Smelter)`, (_implementation, command) => {
    let world: SmelterWorld | undefined;
    beforeAll(async () => {
      world = await SmelterWorld.create(command);
    }, 180_000);
    afterAll(async () => {
      await world?.close();
    });
    afterEach((context) => {
      if (context.task.result?.state === 'fail') {
        console.error(`Smelter output:\n${world?.output.join('\n')}`);
        console.error(`Archivist output:\n${world?.kb.archivist.output.slice(-40).join('\n')}`);
      }
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!);
  });
}
