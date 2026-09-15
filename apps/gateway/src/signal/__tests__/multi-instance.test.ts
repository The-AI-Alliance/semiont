/**
 * The multi-replica capability PROOF (SIGNAL-PLANE P3 — GREEN 2026-09-15).
 *
 * Two full gateway-side compositions over one core-only broker, each built
 * from the SAME modules production boots: `compositionFor` (plane + ledger +
 * the standing tap + claim announcements) and `bridgeGatewayHandlers` (the
 * handler island reconnected, both directions, driving the make-meaning
 * channel lists). The P3 RED harness hand-mirrored this wiring and carried
 * five `test.fails`; every one is promoted here — a regression in any fails
 * hard, not quietly.
 *
 * What each proves (the plan's property numbering):
 *  - H0  (found at RED): the ledger is plane-fed — answered/retention work
 *        over a broker at N=1;
 *  - H1  (property 1): a request claimed via B delivers to a client on A —
 *        claim announcements converge the ledgers;
 *  - H2  (found at RED; property 3's composition grain): an HTTP-shaped
 *        `job:create` reaches a bridged gateway-resident handler EXACTLY
 *        once across replicas, and its reply crosses back to the requester;
 *  - H3  (property 3, plane grain): handler-mode at-most-once across
 *        connections;
 *  - H4  (property 4): broadcasts reach clients on both instances;
 *  - H5  (property 5): reply recovery (`pendingReplies`) answers from the
 *        OTHER instance;
 *  - H6  (property 2): the reply is emitted via an instance that does NOT
 *        hold the claim — the discriminator replica-local designs die on.
 *
 * Ordering note: a claim announcement and its request leave one connection
 * in order, so every subscriber sees claim-before-request (and B-published
 * replies after B-published claims). H6's reply leaves a DIFFERENT
 * connection — the one recorded race — so the harness, like reality, lets
 * the claim land (`awaitClaim`) before the reply is emitted.
 */
import { afterAll, describe, test, expect } from 'vitest';
import { EventBus } from '@semiont/core';
import { GATEWAY_HANDLER_CHANNELS, GATEWAY_HANDLER_EMITS } from '@semiont/make-meaning';
import { toReplyAddress } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { compositionFor, type SignalComposition } from '../composition';
import { bridgeGatewayHandlers } from '../bridge';
import { isCorrelatedChannel } from '../channels';
import { natsFixture } from './nats-fixture';

/** Generous async settling: poll, never assume synchronous delivery. */
async function settle(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 15));
  }
}

const PRINCIPAL = 'did:web:test:users:p3';

interface Instance {
  name: string;
  composition: SignalComposition;
  /** `job:create` commands this instance's bridged handler executed. */
  handled: unknown[];
  /** Emit-as-claim, as the /bus/emit route does it. */
  emitRequest(channel: string, cid: string, clientId: string, payload?: Record<string, unknown>): void;
  /** A reply/broadcast ingest, as any responder's emit. */
  ingest(channel: string, payload: unknown, scope?: string): void;
  /** A subscribed client behind the route's entitlement gate (the SHARED
   *  `mayDeliver`, one copy in the ledger). */
  client(clientId: string, channels: string[]): { frames: Array<{ channel: string; payload: unknown }>; close(): void };
  /** Wait until this instance's ledger knows the claim. */
  awaitClaim(cid: string): Promise<void>;
  teardown(): void;
}

async function makeInstance(name: string, servers: string): Promise<Instance> {
  const bus = new EventBus();
  const plane = await createNatsSignalPlane({ servers, reconnect: false });
  const composition = compositionFor(bus, plane);
  const bridge = bridgeGatewayHandlers(plane, bus, GATEWAY_HANDLER_CHANNELS, GATEWAY_HANDLER_EMITS);

  // The gateway-resident handler, in miniature: subscribes THIS instance's
  // bus (as registerGatewayBusHandlers does) and answers on it — the bridge
  // carries both directions.
  const handled: unknown[] = [];
  bus.get('job:create').subscribe((command) => {
    handled.push(command);
    bus.get('job:created').next({ correlationId: command.correlationId, response: { jobId: `job-${command.correlationId}` } });
  });

  return {
    name,
    composition,
    handled,
    emitRequest(channel, cid, clientId, payload = {}) {
      const outcome = composition.claim(cid, clientId, PRINCIPAL);
      expect(outcome, `${name}: claim ${cid}`).toBe('ok');
      composition.plane.ingest(channel, { ...payload, correlationId: cid, _userId: PRINCIPAL });
    },
    ingest(channel, payload, scope) {
      composition.plane.ingest(channel, payload, scope);
    },
    client(clientId, channels) {
      const frames: Array<{ channel: string; payload: unknown }> = [];
      const sub = composition.plane.subscribeClient({
        address: toReplyAddress(clientId),
        global: channels,
        scoped: [],
        onFrame: (channel, payload, frameScope) => {
          if (
            frameScope === undefined &&
            isCorrelatedChannel(channel) &&
            !composition.mayDeliver(channel, payload, clientId, PRINCIPAL)
          ) {
            return;
          }
          frames.push({ channel, payload });
        },
      });
      return { frames, close: () => sub.close() };
    },
    async awaitClaim(cid) {
      await settle(() => composition.owner(cid) !== undefined);
      expect(composition.owner(cid), `${name}: claim ${cid} visible`).toBeDefined();
    },
    teardown() {
      bridge.close();
      composition.dispose();
      plane.dispose();
      bus.destroy();
    },
  };
}

async function twoInstances(): Promise<{ a: Instance; b: Instance; done(): void }> {
  const { servers } = await natsFixture();
  const a = await makeInstance('A', servers);
  const b = await makeInstance('B', servers);
  return { a, b, done: () => { a.teardown(); b.teardown(); } };
}

afterAll(async () => {
  const fixture = await natsFixture().catch(() => undefined);
  fixture?.stop();
});

describe('P3 — two gateway-compositions over one broker', () => {
  test('H4: a broadcast reaches clients on BOTH instances', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const ca = a.client('client-a', ['beckon:focus']);
      const cb = b.client('client-b', ['beckon:focus']);
      // Emit-until-seen: a publish can beat the subscriptions' server-side
      // registration (no barrier exists in the seam, deliberately), and a
      // missed broadcast never retries. Duplicates are contract-tolerated,
      // so repeating the emit is the honest barrier.
      await settle(() => {
        if (ca.frames.length >= 1 && cb.frames.length >= 1) return true;
        b.ingest('beckon:focus', { n: 1 });
        return false;
      });
      expect(ca.frames.length, 'client on A').toBeGreaterThanOrEqual(1);
      expect(cb.frames.length, 'client on B').toBeGreaterThanOrEqual(1);
      ca.close();
      cb.close();
    } finally {
      done();
    }
  });

  test('H3: a bridged handler command executes on ONE instance, never both', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const cids = Array.from({ length: 10 }, (_, i) => `cid-h3-${i}`);
      for (const [i, cid] of cids.entries()) {
        (i % 2 ? a : b).emitRequest('job:create', cid, 'client-h3', { jobType: 'generate', params: {} });
      }
      await settle(() => a.handled.length + b.handled.length >= cids.length);
      const seen = [...a.handled, ...b.handled].map((c) => (c as { correlationId: string }).correlationId);
      expect(seen.length, 'each command executed').toBe(cids.length);
      expect(new Set(seen).size, 'no command executed on BOTH instances').toBe(cids.length);
    } finally {
      done();
    }
  });

  test('H0 (single instance): a claimed request answered over NATS marks the claim and retains the reply', async () => {
    const { a, done } = await twoInstances();
    try {
      const client = a.client('client-h0', ['gather:summary-result']);
      a.emitRequest('gather:requested', 'cid-h0', 'client-h0');
      a.ingest('gather:summary-result', { correlationId: 'cid-h0', summary: 'answered' });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'delivered').toBeGreaterThanOrEqual(1);
      await settle(() => a.composition.occupancy().retainedReplies >= 1);
      expect(a.composition.occupancy().retainedReplies, 'retention').toBe(1);
      expect(a.composition.lookupReply('cid-h0', 'client-h0', PRINCIPAL), 'pendingReplies recovery').toBeDefined();
      client.close();
    } finally {
      done();
    }
  });

  test('H2: an HTTP-shaped job:create reaches a bridged handler once, and its reply returns to the requester', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const client = a.client('client-h2', ['job:created']);
      a.emitRequest('job:create', 'cid-h2', 'client-h2', { jobType: 'generate', params: {} });
      await settle(() => client.frames.length >= 1);
      expect(a.handled.length + b.handled.length, 'executed exactly once across replicas').toBe(1);
      expect(client.frames.length, 'reply delivered to the requester').toBeGreaterThanOrEqual(1);
      expect(client.frames[0]!.channel).toBe('job:created');
      client.close();
    } finally {
      done();
    }
  });

  test('H1: a request claimed via B delivers its reply to the client subscribed on A', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const client = a.client('client-h1', ['gather:summary-result']);
      b.emitRequest('gather:requested', 'cid-h1', 'client-h1');
      // A real reply follows a handler round-trip; a reply emitted
      // MICROSECONDS after its claim can beat the announcement to the other
      // instance and be refused once, permanently — the recorded race,
      // observed here when this line was missing. The harness models the
      // round-trip, not the pathological compression.
      await a.awaitClaim('cid-h1');
      b.ingest('gather:summary-result', { correlationId: 'cid-h1', summary: 'from-b' });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'reply delivered across instances').toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      done();
    }
  });

  test('H6: the reply is emitted via an instance that does NOT hold the claim', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const client = a.client('client-h6', ['gather:summary-result']);
      b.emitRequest('gather:requested', 'cid-h6', 'client-h6');
      // The reply leaves a DIFFERENT connection than the claim announcement
      // (the recorded race); like a real handler round-trip, it follows the
      // claim's arrival.
      await a.awaitClaim('cid-h6');
      a.ingest('gather:summary-result', { correlationId: 'cid-h6', summary: 'from-non-holder' });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'reply from a non-claim-holder instance').toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      done();
    }
  });

  test('H5: reply recovery answers from the OTHER instance', async () => {
    const { a, b, done } = await twoInstances();
    try {
      b.emitRequest('gather:requested', 'cid-h5', 'client-h5');
      b.ingest('gather:summary-result', { correlationId: 'cid-h5', summary: 'kept' });
      await settle(
        () =>
          a.composition.occupancy().retainedReplies >= 1 &&
          b.composition.occupancy().retainedReplies >= 1,
      );
      expect(b.composition.lookupReply('cid-h5', 'client-h5', PRINCIPAL), 'origin retains').toBeDefined();
      expect(a.composition.lookupReply('cid-h5', 'client-h5', PRINCIPAL), 'the OTHER instance answers recovery').toBeDefined();
    } finally {
      done();
    }
  });
});
