/**
 * A Weaver world: a Weaver process and everything it meets. That is an
 * Archivist world (a knowledge base, a real Archivist that records and
 * answers, a gateway, the trusted issuer), the Weaver's own service account at
 * that issuer, and a real neo4j, cleared when the world is made.
 *
 * Cases meet the Weaver in the three places the rest of Semiont does: in the
 * graph it writes; on the bus, where it signals what it has applied and
 * answers a rebuild; and at its health port. Nothing is recorded but through
 * the Archivist, as people, workers and services record: the Weaver is given
 * the events the record gives it.
 *
 * The graph is read by the world itself, in Cypher, and each row by the
 * harness's own reading of one (graph-codec.ts). That reader writes nothing,
 * and a Weaver is the graph's one writer. What a case does to the database
 * behind a Weaver's back (empty it, lose an annotation from it), the world
 * does itself, in Cypher too.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j, { type Driver } from 'neo4j-driver';
import { afterAll, afterEach, beforeAll, describe, expect, inject } from 'vitest';
import type { Annotation, ResourceDescriptor } from '@semiont/core';
import { ArchivistWorld, type Answer, type StoredEvent } from './archivist-world';
import { isRow, isStrings, readAnnotation, readResource, type Row } from './graph-codec';
import { eventually } from './net';
import { SERVICE_ROLE } from './roles';
import type { BusStream } from './stream';
import { refusedWeaverBoot, startWeaver, type WeaverEnvironment, type WeaverLaunch, type WeaverProcess, type WeaverService, type WeaverSettings } from './weaver-process';

/** The Weaver's service account at the issuer. */
export const WEAVER_CLIENT = 'semiont-weaver';

/** The variable the Weaver's settings name for the graph database's password. */
const GRAPH_PASSWORD = 'NEO4J_PASSWORD';

/**
 * The recorded events a Weaver follows (WEAVER.md § What it follows). Every
 * other event of a resource's stream passes it by, and moves no mark of its.
 */
export const FOLLOWED: readonly string[] = [
  'yield:created',
  'mark:archived',
  'mark:unarchived',
  'mark:added',
  'mark:removed',
  'mark:body-updated',
  'mark:entity-tag-added',
  'mark:entity-tag-removed',
];

export interface Applied {
  resourceId: string;
  sequenceNumber: number;
}

/** An annotation's row, with the names its tag edges go to. */
const TAGGED = 'OPTIONAL MATCH (a)-[:TAGGED_AS]->(tag:EntityType) WITH a, collect(tag.name) AS tags RETURN properties(a) AS row, tags';

/**
 * A stub is a link's target the graph has not been given yet: an id and
 * nothing else. It is no resource the graph holds, and no read answers one.
 */
const HELD = 'coalesce(d.stub, false) = false';

/**
 * A column of an answer, as what the statement returns there. The driver
 * types every column `any`, so each is taken as unknown and checked.
 */
function rowIn(column: string, value: unknown): Row {
  if (!isRow(value)) throw new Error(`the graph answered ${column} as something other than a node's properties: ${JSON.stringify(value)}`);
  return value;
}

function stringsIn(column: string, value: unknown): string[] {
  if (!isStrings(value)) throw new Error(`the graph answered ${column} as something other than a list of strings: ${JSON.stringify(value)}`);
  return value;
}

function stringIn(column: string, value: unknown): string {
  if (typeof value !== 'string') throw new Error(`the graph answered ${column} as something other than a string: ${JSON.stringify(value)}`);
  return value;
}

/** A count, which the driver answers as its own Integer. */
function countIn(column: string, value: unknown): number {
  if (!neo4j.isInt(value)) throw new Error(`the graph answered ${column} as something other than an integer: ${String(value)}`);
  return value.toNumber();
}

/**
 * The graph, as the suite reads it: its own Cypher, on a connection of its
 * own, and its own reading of each row (graph-codec.ts). It writes nothing.
 */
export class GraphReader {
  constructor(
    private readonly hand: Driver,
    private readonly database: string,
  ) {}

  private async asked(statement: string, parameters: Record<string, string>) {
    const { records } = await this.hand.executeQuery(statement, parameters, { database: this.database });
    return records;
  }

  private async annotations(matched: string, parameters: Record<string, string>): Promise<Annotation[]> {
    const records = await this.asked(`${matched} ${TAGGED}`, parameters);
    return records.map((record) => readAnnotation(rowIn('row', record.get('row')), stringsIn('tags', record.get('tags'))));
  }

  /** A resource the graph holds, or undefined. */
  async resource(resourceId: string): Promise<ResourceDescriptor | undefined> {
    const [record] = await this.asked(`MATCH (d:Resource {id: $resourceId}) WHERE ${HELD} RETURN properties(d) AS row`, { resourceId });
    return record === undefined ? undefined : readResource(rowIn('row', record.get('row')));
  }

  /** The ids of the resources the graph holds under a name. */
  async resourcesNamed(name: string): Promise<string[]> {
    const records = await this.asked(`MATCH (d:Resource {name: $name}) WHERE ${HELD} RETURN properties(d) AS row`, { name });
    return records.map((record) => readResource(rowIn('row', record.get('row')))['@id']);
  }

  /** An annotation the graph holds, or undefined. */
  async annotation(annotationId: string): Promise<Annotation | undefined> {
    const [annotation] = await this.annotations('MATCH (a:Annotation {id: $annotationId})', { annotationId });
    return annotation;
  }

  /** The annotations on a resource, in no promised order. */
  annotationsOn(resourceId: string): Promise<Annotation[]> {
    return this.annotations('MATCH (a:Annotation {resourceId: $resourceId})', { resourceId });
  }

  /** The annotations, on any resource, that link to a resource. */
  referencesTo(resourceId: string): Promise<Annotation[]> {
    return this.annotations('MATCH (a:Annotation)-[:REFERENCES]->(:Resource {id: $resourceId})', { resourceId });
  }

  /** The resources a resource's annotations link to, each with the ids of the annotations that link to it. */
  async linksFrom(resourceId: string): Promise<Array<{ to: ResourceDescriptor; by: string[] }>> {
    const records = await this.asked(
      `MATCH (:Resource {id: $resourceId})<-[:BELONGS_TO]-(a:Annotation)-[:REFERENCES]->(d:Resource) WHERE ${HELD} WITH d, collect(a.id) AS by RETURN properties(d) AS row, by`,
      { resourceId },
    );
    return records.map((record) => ({ to: readResource(rowIn('row', record.get('row'))), by: stringsIn('by', record.get('by')) }));
  }

  /** How many resources have each entity type. */
  async entityTypeCounts(): Promise<Array<{ type: string; count: number }>> {
    const records = await this.asked('MATCH (d:Resource) UNWIND d.entityTypes AS type RETURN type, count(*) AS count', {});
    return records.map((record) => ({ type: stringIn('type', record.get('type')), count: countIn('count', record.get('count')) }));
  }
}

export class WeaverWorld {
  private weaverProcess: WeaverProcess | undefined;

  private constructor(
    /** The knowledge base: where a case records, and reads the record. */
    readonly kb: ArchivistWorld,
    /** The graph, as the suite reads it. */
    readonly graph: GraphReader,
    readonly service: WeaverService,
    readonly settings: WeaverSettings,
    private readonly env: WeaverEnvironment,
    private home: string,
    private readonly signals: BusStream,
    /** The world's own connection to the database, for what it does there itself. */
    private readonly hand: Driver,
    private readonly database: string,
  ) {}

  static async create(service: WeaverService): Promise<WeaverWorld> {
    const { host, password } = inject('graphDatabase');
    const secret = randomBytes(24).toString('hex');
    const kb = await ArchivistWorld.create({ gitSync: false, accounts: { [WEAVER_CLIENT]: { secret, roles: [SERVICE_ROLE] } } });

    const at = { uri: `bolt://${host}:7687`, username: 'neo4j', database: 'neo4j' };
    const hand = neo4j.driver(at.uri, neo4j.auth.basic(at.username, password));

    // A standing stream of what the Weaver says it has applied, open before any Weaver is.
    const { token } = await kb.world.agent('conformance', 'weaver-watch', [SERVICE_ROLE]);
    const signals = await kb.world.subscribe(token, { clientId: randomUUID(), global: ['weave:applied'] }, undefined, true);

    const world = new WeaverWorld(
      kb,
      new GraphReader(hand, at.database),
      service,
      { gatewayUrl: kb.world.origin, issuer: kb.world.issuer.origin, graph: { ...at, passwordEnv: GRAPH_PASSWORD } },
      { SEMIONT_OIDC_CLIENT_ID: WEAVER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secret, [GRAPH_PASSWORD]: password },
      mkdtempSync(join(tmpdir(), 'conformance-weaver-')),
      signals,
      hand,
      at.database,
    );
    await world.clean();
    await world.start();
    return world;
  }

  /** The running Weaver. */
  get weaver(): WeaverProcess {
    if (!this.weaverProcess) throw new Error('the case stopped the Weaver and has not started it again');
    return this.weaverProcess;
  }

  /** What a case launches a Weaver of its own with: this world's, changed as the case says. */
  launch(change: Partial<Pick<WeaverLaunch, 'settings' | 'env' | 'home'>> = {}): WeaverLaunch {
    return { service: this.service, settings: this.settings, env: this.env, home: this.home, ...change };
  }

  /** Start the Weaver, as this world launches one or as a case changes that, and wait until both of its boot passes have ended. */
  async start(change: Partial<Pick<WeaverLaunch, 'settings' | 'env'>> = {}): Promise<void> {
    if (this.weaverProcess) throw new Error('a Weaver is already running in this world');
    this.weaverProcess = await startWeaver(this.launch(change));
  }

  /** SIGTERM, and wait: its exit code. */
  async stop(): Promise<number | null> {
    const code = await this.weaver.stop();
    this.weaverProcess = undefined;
    return code;
  }

  /** Stop the Weaver and start it again in the same home: it finds what it kept. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop the Weaver and start one that has kept nothing: a new home, as a new container has. */
  async replace(): Promise<void> {
    await this.stop();
    rmSync(this.home, { recursive: true, force: true });
    this.home = mkdtempSync(join(tmpdir(), 'conformance-weaver-'));
    await this.start();
  }

  /** A Weaver that must refuse to start, launched as `change` says beside this world's. */
  refused(change: Partial<Pick<WeaverLaunch, 'settings' | 'env'>>): Promise<{ code: number | null; output: string }> {
    return refusedWeaverBoot({ ...this.launch(change), home: mkdtempSync(join(tmpdir(), 'conformance-weaver-refused-')) });
  }

  // ── What the world does in the database itself ────────────────────────────

  private async cypher(statement: string, parameters: Record<string, string>): Promise<void> {
    await this.hand.executeQuery(statement, parameters, { database: this.database });
  }

  /** Empty the database: every node, and with it every edge. */
  async clean(): Promise<void> {
    await this.cypher('MATCH (n) DETACH DELETE n', {});
  }

  /** Take one annotation out of the graph, edges and all, as one lost behind a Weaver's back is. */
  async lose(annotationId: string): Promise<void> {
    await this.cypher('MATCH (a:Annotation {id: $id}) DETACH DELETE a', { id: annotationId });
  }

  // ── What it says it has applied ───────────────────────────────────────────

  /** Every `weave:applied` the Weaver has signalled, oldest first. */
  appliedSignals(resourceId?: string): Applied[] {
    return this.signals
      .frames('weave:applied')
      .map((frame) => ({ resourceId: String(frame.payload['resourceId']), sequenceNumber: Number(frame.payload['sequenceNumber']) }))
      .filter((signal) => resourceId === undefined || signal.resourceId === resourceId);
  }

  /** Wait until the Weaver signals it has applied `resourceId` up to `sequenceNumber`. */
  applied(resourceId: string, sequenceNumber: number, timeoutMs = 20_000): Promise<Applied> {
    return eventually(`weave:applied for ${resourceId} to reach ${sequenceNumber}`, timeoutMs, () =>
      this.appliedSignals(resourceId).find((signal) => signal.sequenceNumber >= sequenceNumber),
    );
  }

  /** The sequence of the last event a Weaver follows in a resource's stream, as the record holds it now. */
  lastFollowed(resourceId: string): number {
    const followed = this.kb.stored(resourceId).filter((event) => FOLLOWED.includes(event.type));
    if (followed.length === 0) throw new Error(`the record holds no event a Weaver follows for ${resourceId}`);
    return followed[followed.length - 1]!.metadata.sequenceNumber;
  }

  /** Wait until the Weaver has applied everything it follows of what the record holds for each of `resourceIds`. */
  async caughtUp(...resourceIds: string[]): Promise<void> {
    for (const resourceId of resourceIds) await this.applied(resourceId, this.lastFollowed(resourceId));
  }

  /** The record's events of one type for a resource, oldest first. */
  recorded(resourceId: string, type: string): StoredEvent[] {
    return this.kb.stored(resourceId).filter((event) => event.type === type);
  }

  // ── What it is asked ──────────────────────────────────────────────────────

  /** Ask the Weaver to rebuild one resource, or the whole graph, as a service asks. */
  async rebuild(resourceId?: string): Promise<Answer> {
    const asker = await this.kb.sidecar('rebuild');
    return asker.request('weave:rebuild', resourceId === undefined ? {} : { resourceId }, 60_000);
  }

  drain(): string[] {
    return [...this.kb.drain(), ...this.signals.violations.splice(0)];
  }

  async close(): Promise<void> {
    if (this.weaverProcess) await this.weaverProcess.stop();
    await this.hand.close();
    await this.kb.close();
    rmSync(this.home, { recursive: true, force: true });
  }
}

/**
 * Run `body`'s cases against one Weaver world for each implementation of the
 * Weaver. After every case, the streams it opened must have carried nothing
 * the spec does not allow.
 */
export function eachWeaver(title: string, body: (world: () => WeaverWorld) => void): void {
  describe.each(Object.entries(inject('weaverServices')))(`${title} (the %s Weaver)`, (_implementation, service) => {
    let world: WeaverWorld | undefined;
    beforeAll(async () => {
      world = await WeaverWorld.create(service);
    }, 180_000);
    afterAll(async () => {
      await world?.close();
    });
    afterEach((context) => {
      if (context.task.result?.state === 'fail') {
        console.error(`Weaver output:\n${world?.weaver.output.join('\n')}`);
        console.error(`Archivist output:\n${world?.kb.archivist.output.slice(-40).join('\n')}`);
      }
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!);
  });
}
