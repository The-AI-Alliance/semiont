/**
 * A world: everything one gateway needs around it — the trusted issuer, a
 * fake Archivist, a broker when the plane is NATS — and the gateway itself,
 * with the tokens a case signs in with. `eachPlane` runs a file's cases
 * against a world on each signal plane and fails any case whose streams
 * carried a message the spec does not allow.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect } from 'vitest';
import { startArchivist, type FakeArchivist } from './archivist';
import { startBroker, type Broker, type BrokerOptions } from './nats';
import { defaultSettings, startGateway, type GatewayEnvironment, type GatewayProcess, type GatewaySettings, type Plane } from './gateway';
import { call, type Reply } from './http';
import { freePort } from './net';
import { startIssuer, type IssuerServer } from './issuer';
import { SERVICE_ROLE } from './roles';
import { kbIdentity } from './spec';
import { subscribe, type BusFrame, type BusStream, type SubscribeBody } from './stream';

export const PLANES: readonly Plane[] = ['in-process', 'nats'];

/** The service account the gateway reaches the Archivist with. */
export const GATEWAY_CLIENT = 'semiont-gateway';
/** A service account for participants the suite plays — the Archivist's bus half, a worker. */
export const PARTICIPANT_CLIENT = 'conformance-participant';

export interface WorldOptions {
  /** Change the gateway's settings before it starts. */
  settings?: (s: GatewaySettings) => GatewaySettings;
  /** Add to (or, with `undefined`, remove from) the gateway's environment. */
  env?: GatewayEnvironment;
  /** How the NATS plane's broker is started. */
  broker?: BrokerOptions;
}

export class World {
  readonly kb = kbIdentity();
  private readonly streams: BusStream[] = [];
  /** Streams that outlive a case — a participant set up for the whole file. */
  private readonly standing: BusStream[] = [];
  private readonly extraGateways: GatewayProcess[] = [];

  private constructor(
    readonly plane: Plane,
    readonly issuer: IssuerServer,
    readonly archivist: FakeArchivist,
    readonly broker: Broker | undefined,
    readonly env: GatewayEnvironment,
    public gateway: GatewayProcess,
  ) {}

  static async create(plane: Plane, options: WorldOptions = {}): Promise<World> {
    const kb = kbIdentity();
    const secret = randomBytes(24).toString('hex');
    const issuer = await startIssuer(kb.resource, {
      [GATEWAY_CLIENT]: { secret, roles: [SERVICE_ROLE] },
    });
    const archivist = await startArchivist(issuer, kb.resource);
    const broker = plane === 'nats' ? await startBroker(options.broker) : undefined;
    const env: GatewayEnvironment = {
      JWT_SECRET: randomBytes(32).toString('hex'),
      SEMIONT_OIDC_CLIENT_ID: GATEWAY_CLIENT,
      SEMIONT_OIDC_CLIENT_SECRET: secret,
      ...options.env,
    };
    const base = await defaultSettings({
      kb: { name: kb.name, domain: kb.domain },
      issuer: issuer.origin,
      archivist: { host: archivist.host, port: archivist.port },
      plane,
      ...(broker ? { natsUrl: broker.url } : {}),
    });
    const settings = options.settings ? options.settings(base) : base;
    const gateway = await startGateway({ settings, env });
    return new World(plane, issuer, archivist, broker, env, gateway);
  }

  get origin(): string {
    return this.gateway.origin;
  }

  /** A second gateway on this world's issuer, Archivist and broker, configured as the first — another replica. */
  async replica(): Promise<GatewayProcess> {
    const port = await freePort();
    const settings = { ...this.gateway.settings, port, publicUrl: `http://127.0.0.1:${port}` };
    const replica = await startGateway({ settings, env: this.env });
    this.extraGateways.push(replica);
    return replica;
  }

  /** Stop this world's gateway and start it again on the same port and settings. */
  async restart(): Promise<void> {
    const settings = this.gateway.settings;
    await this.gateway.stop();
    this.gateway = await startGateway({ settings, env: this.env });
  }

  /**
   * A token signed with this gateway's own signing key — the head of its
   * JWT_SECRET ring — or with `key`: what a case forges to see the gateway
   * refuse what it would never have minted.
   */
  signed(claims: Record<string, unknown>, key = this.env.JWT_SECRET!.split(',')[0]!.trim()): Promise<string> {
    return new SignJWT(claims).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(new TextEncoder().encode(key));
  }

  /** A person's issuer token, for this knowledge base. */
  person(sub: string, claims: Record<string, unknown> = {}): Promise<string> {
    return this.issuer.person(sub, claims);
  }

  /** The DID the gateway names a person by, as the `bearerAuth` scheme states it. */
  personDid(sub: string): string {
    return `${this.kb.did}:users:${sub}`;
  }

  /** A software agent's token, minted by the gateway for a service account with `roles`. */
  async agent(provider: string, model: string, roles: string[] = [SERVICE_ROLE], origin = this.origin): Promise<{ token: string; did: string }> {
    const service = await this.issuer.service(PARTICIPANT_CLIENT, roles);
    const reply = await call(origin, 'POST', '/api/tokens/agent', { token: service, json: { provider, model } });
    if (reply.status !== 200) throw new Error(`agent token refused: ${reply.status} ${reply.text}`);
    return reply.json as { token: string; did: string };
  }

  /** Open a stream; fails unless the gateway answers 200. Checked for violations after the case. */
  async subscribe(token: string, body: SubscribeBody, origin = this.origin, standing = false): Promise<BusStream> {
    const result = await subscribe(origin, token, body);
    if (!result.stream) throw new Error(`subscribe answered ${result.status}: ${result.text}`);
    (standing ? this.standing : this.streams).push(result.stream);
    // The stream is open once the first message — the first ping, after any
    // replay — has arrived; before that a frame could race the subscription.
    await result.stream.next('the stream to catch up', () => true, 10_000);
    return result.stream;
  }

  /** Open a stream without waiting for it to catch up (a replay case reads what comes first). */
  async open(token: string, body: SubscribeBody, origin = this.origin): Promise<BusStream> {
    const result = await subscribe(origin, token, body);
    if (!result.stream) throw new Error(`subscribe answered ${result.status}: ${result.text}`);
    this.streams.push(result.stream);
    return result.stream;
  }

  emit(token: string, body: Record<string, unknown>, origin = this.origin): Promise<Reply> {
    return call(origin, 'POST', '/bus/emit', { token, json: body });
  }

  /**
   * A participant the suite plays: subscribed to `channels`, answering each
   * frame with what `answer` returns (a channel and payload, emitted with the
   * frame's correlationId). It stands for the rest of the file.
   */
  async responder(
    channels: string[],
    answer: (frame: BusFrame) => { channel: string; payload: Record<string, unknown> } | undefined | Promise<{ channel: string; payload: Record<string, unknown> } | undefined>,
    origin = this.origin,
  ): Promise<{ stream: BusStream; token: string; clientId: string }> {
    // A sidecar reaches the bus as a software agent, with a token the gateway minted.
    const { token } = await this.agent('conformance', 'participant', [SERVICE_ROLE], origin);
    const clientId = randomUUID();
    const stream = await this.subscribe(token, { clientId, global: channels }, origin, true);
    stream.on((message) => {
      const frame = message.frame;
      if (!frame || !channels.includes(frame.channel)) return;
      void (async () => {
        const reply = await answer(frame);
        if (!reply) return;
        await this.emit(token, {
          channel: reply.channel,
          payload: reply.payload,
          ...(frame.correlationId ? { correlationId: frame.correlationId } : {}),
          clientId,
        }, origin);
      })();
    });
    return { stream, token, clientId };
  }

  /**
   * Every violation since the last call — carried by the streams a case
   * opened, which are then closed, and by the standing ones, and anything the
   * gateway sent the Archivist, or the stand-in answered, outside its spec.
   */
  drain(): string[] {
    const violations = [...this.streams, ...this.standing].flatMap((s) => s.violations.splice(0));
    violations.push(...this.archivist.violations.splice(0));
    for (const s of this.streams) s.close();
    this.streams.length = 0;
    return violations;
  }

  async close(): Promise<void> {
    this.drain();
    for (const s of this.standing) s.close();
    for (const g of this.extraGateways) await g.stop();
    await this.gateway.stop();
    await this.broker?.stop();
    await this.archivist.close();
    await this.issuer.close();
  }
}

/**
 * Run `body`'s cases against a world on each plane. After every case, the
 * streams it opened must have carried nothing the spec does not allow.
 */
export function eachPlane(title: string, body: (world: () => World, plane: Plane) => void, options: WorldOptions = {}, planes: readonly Plane[] = PLANES): void {
  describe.each(planes)(`${title} (%s plane)`, (plane) => {
    let world: World | undefined;
    beforeAll(async () => {
      world = await World.create(plane, options);
    });
    afterAll(async () => {
      await world?.close();
    });
    afterEach((context) => {
      // A failing case shows what the gateway said while it ran.
      if (context.task.result?.state === 'fail') console.error(`gateway output:\n${world?.gateway.output.join('\n')}`);
      expect(world?.drain() ?? []).toEqual([]);
    });
    body(() => world!, plane);
  });
}
