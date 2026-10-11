/**
 * A Weaver world: a Weaver process and everything it meets. That is an
 * Archivist world (a knowledge base, a real Archivist that records and
 * answers, a gateway, the trusted issuer), the Weaver's own service account at
 * that issuer, and a real neo4j, cleared when the world is made.
 *
 * Cases meet the Weaver in the three places the rest of Semiont does: in the
 * graph it writes, read here as the Librarian reads it; on the bus, where it
 * signals what it has applied and answers a rebuild; and at its health port.
 * Nothing is recorded but through the Archivist, as people, workers and
 * services record: the Weaver is given the events the record gives it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, inject } from 'vitest';
import { Neo4jGraphDatabase } from '@semiont/graph';
import { ArchivistWorld, type Answer, type StoredEvent } from './archivist-world';
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
  'frame:entity-type-added',
];

export interface Applied {
  resourceId: string;
  sequenceNumber: number;
}

export class WeaverWorld {
  private weaverProcess: WeaverProcess | undefined;

  private constructor(
    /** The knowledge base: where a case records, and reads the record. */
    readonly kb: ArchivistWorld,
    /** The graph, as a reader of it reads it. */
    readonly graph: Neo4jGraphDatabase,
    readonly service: WeaverService,
    readonly settings: WeaverSettings,
    private readonly env: WeaverEnvironment,
    private home: string,
    private readonly signals: BusStream,
  ) {}

  static async create(service: WeaverService): Promise<WeaverWorld> {
    const { host, password } = inject('graphDatabase');
    const secret = randomBytes(24).toString('hex');
    const kb = await ArchivistWorld.create({ gitSync: false, accounts: { [WEAVER_CLIENT]: { secret, roles: [SERVICE_ROLE] } } });

    const neo4j = { uri: `bolt://${host}:7687`, username: 'neo4j', database: 'neo4j' };
    const graph = new Neo4jGraphDatabase({ ...neo4j, password });
    await graph.connect();
    await graph.clearDatabase();

    // A standing stream of what the Weaver says it has applied, open before any Weaver is.
    const { token } = await kb.world.agent('conformance', 'weaver-watch', [SERVICE_ROLE]);
    const signals = await kb.world.subscribe(token, { clientId: randomUUID(), global: ['weave:applied'] }, undefined, true);

    const world = new WeaverWorld(
      kb,
      graph,
      service,
      { gatewayUrl: kb.world.origin, issuer: kb.world.issuer.origin, graph: { ...neo4j, passwordEnv: GRAPH_PASSWORD } },
      { SEMIONT_OIDC_CLIENT_ID: WEAVER_CLIENT, SEMIONT_OIDC_CLIENT_SECRET: secret, [GRAPH_PASSWORD]: password },
      mkdtempSync(join(tmpdir(), 'conformance-weaver-')),
      signals,
    );
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

  /** Start the Weaver, and wait until both of its boot passes have ended. */
  async start(): Promise<void> {
    if (this.weaverProcess) throw new Error('a Weaver is already running in this world');
    this.weaverProcess = await startWeaver(this.launch());
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

  /**
   * A reader of the graph that has read nothing yet. The world's own keeps
   * the vocabulary it first read, as a long-lived reader does; a case that
   * asks what the vocabulary is NOW asks one of these.
   */
  async freshReader<T>(read: (graph: Neo4jGraphDatabase) => Promise<T>): Promise<T> {
    const { host, password } = inject('graphDatabase');
    const graph = new Neo4jGraphDatabase({ uri: `bolt://${host}:7687`, username: 'neo4j', database: 'neo4j', password });
    await graph.connect();
    try {
      return await read(graph);
    } finally {
      await graph.disconnect();
    }
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
    await this.graph.disconnect();
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
