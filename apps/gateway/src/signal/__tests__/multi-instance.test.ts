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
 *        hold the claim — the discriminator replica-local designs die on;
 *  - H7  (found LIVE, post-GREEN): a gateway-internal `busRequest` rides
 *        the plane primitive and reaches a remote bus-client actor — the
 *        `yield:create` starvation bug as a test;
 *  - H8  (found LIVE, post-GREEN): a queue driver's raw-bus `job:queued`
 *        announcement crosses the bridge to a worker-shaped client on the
 *        other instance — the worker starvation bug as a test.
 *
 * Ordering note: a claim announcement and its request leave one connection
 * in order, so every subscriber sees claim-before-request (and B-published
 * replies after B-published claims). H6's reply leaves a DIFFERENT
 * connection — the one recorded race — so the harness, like reality, lets
 * the claim land (`awaitClaim`) before the reply is emitted.
 */
import { afterAll, describe, test, expect } from 'vitest';
import { Subject } from 'rxjs';
import { EventBus, busRequest, BRIDGED_CHANNELS, BUS_OPERATIONS, type BusFrame, type BusOperationKey, type EventMap } from '@semiont/core';
import {
  GATEWAY_HANDLER_CHANNELS,
  GATEWAY_HANDLER_EMITS,
  ARCHIVIST_INBOUND_CHANNELS,
  ARCHIVIST_OUTBOUND_CHANNELS,
  attachServicePumps,
  type PumpTransport,
} from '@semiont/make-meaning';
import { JOB_QUEUE_EMITS, WORKER_CHANNELS, WORKER_CONSUMED_BROADCASTS } from '@semiont/jobs';
import { toReplyAddress, type PlaneEnvelope, type SignalPlane } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { compositionFor, type SignalComposition } from '../composition';
import { bridgeGatewayHandlers } from '../bridge';
import { isCorrelatedChannel } from '../channels';
import { requestPrimitiveFor } from '../request-primitive';
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
  handled: { correlationId?: string; command: unknown }[];
  /** Emit-as-claim, as the /bus/emit route does it. */
  emitRequest(channel: string, cid: string, clientId: string, payload?: Record<string, unknown>): void;
  /** A reply/broadcast ingest, as any responder's emit. */
  ingest(channel: string, payload: unknown, envelope?: PlaneEnvelope): void;
  /** A subscribed client behind the route's entitlement gate (the SHARED
   *  `mayDeliver`, one copy in the ledger). */
  client(clientId: string, channels: string[]): { frames: Array<{ channel: string; payload: unknown }>; close(): void };
  /** Wait until this instance's ledger knows the claim. */
  awaitClaim(cid: string): Promise<void>;
  /** A gateway-internal `busRequest` over the plane primitive — the
   *  ResourceOperations shape (`requestPrimitiveFor`). */
  request(operation: BusOperationKey, payload: Record<string, unknown>): Promise<unknown>;
  /** A raw emit on this instance's BUS — the queue drivers' shape; only the
   *  outbound bridge can carry it to the plane. */
  emitOnBus(channel: keyof EventMap, payload: unknown): void;
  teardown(): void;
}

async function makeInstance(name: string, servers: string): Promise<Instance> {
  const bus = new EventBus();
  const plane = await createNatsSignalPlane({ servers, reconnect: false });
  const composition = compositionFor(bus, plane);
  // The same union production composes (index.ts): handler emits PLUS the
  // queue drivers' announcements. H8 fails if either half goes missing.
  const bridge = bridgeGatewayHandlers(plane, bus, GATEWAY_HANDLER_CHANNELS, [
    ...GATEWAY_HANDLER_EMITS,
    ...JOB_QUEUE_EMITS,
  ]);

  // The gateway-resident handler, in miniature: subscribes THIS instance's
  // bus (as registerGatewayBusHandlers does) and answers on it — the bridge
  // carries both directions.
  const handled: { correlationId?: string; command: unknown }[] = [];
  bus.frames('job:create').subscribe(({ payload: command, correlationId }) => {
    // The KEY is what identifies the command here, and it rides the envelope —
    // recording the payload alone would make every command indistinguishable
    // and the "executed on exactly one instance" assertion vacuous.
    handled.push({ correlationId, command });
    bus.emit('job:created', { response: { jobId: `job-${correlationId}` } }, { correlationId });
  });

  return {
    name,
    composition,
    handled,
    emitRequest(channel, cid, clientId, payload = {}) {
      const outcome = composition.claim(cid, clientId, PRINCIPAL);
      expect(outcome, `${name}: claim ${cid}`).toBe('ok');
      composition.plane.ingest(channel, { ...payload, _userId: PRINCIPAL }, { meta: { correlationId: cid } });
    },
    ingest(channel, payload, envelope) {
      composition.plane.ingest(channel, payload, envelope);
    },
    client(clientId, channels) {
      const frames: Array<{ channel: string; payload: unknown }> = [];
      const sub = composition.plane.subscribeClient({
        address: toReplyAddress(clientId),
        global: channels,
        scoped: [],
        onFrame: (channel, payload, envelope) => {
          if (
            envelope.scope === undefined &&
            isCorrelatedChannel(channel) &&
            !composition.mayDeliver(channel, envelope.meta?.correlationId, clientId, PRINCIPAL)
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
    request(operation, payload) {
      return busRequest(requestPrimitiveFor(bus), operation, payload, 5_000);
    },
    emitOnBus(channel, payload) {
      bus.emit(channel, payload as never);
    },
    teardown() {
      bridge.close();
      composition.dispose();
      plane.dispose();
      bus.destroy();
    },
  };
}

/**
 * The Archivist as it composes itself: its real roster through
 * `attachServicePumps`, over a plane-backed stand-in for HttpTransport.
 */
function archivistOver(plane: SignalPlane): { localBus: EventBus; close(): void } {
  const localBus = new EventBus();
  const subjects = new Map<string, Subject<BusFrame<unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) { s = new Subject<BusFrame<unknown>>(); subjects.set(channel, s); }
    return s;
  };

  const sub = plane.subscribeClient({
    address: toReplyAddress('tier2-archivist'),
    global: [...ARCHIVIST_INBOUND_CHANNELS],
    scoped: [],
    onFrame: (channel, payload, envelope) =>
      subjectFor(channel).next({ payload, correlationId: envelope.meta?.correlationId } as BusFrame<unknown>),
  });

  const transport: PumpTransport = {
    frames: ((channel: string) => subjectFor(channel)) as PumpTransport['frames'],
    emit: ((channel: string, payload: unknown, envelope: { correlationId?: string }) => {
      plane.ingest(channel, payload, {
        meta: envelope?.correlationId ? { correlationId: envelope.correlationId } : {},
      });
      return 1;
    }) as PumpTransport['emit'],
  };

  const pumps = attachServicePumps({
    transport,
    localBus,
    inbound: ARCHIVIST_INBOUND_CHANNELS,
    outbound: ARCHIVIST_OUTBOUND_CHANNELS,
    logger: { error: () => {} },
  });

  return {
    localBus,
    close() {
      for (const p of pumps) p.unsubscribe();
      sub.close();
      localBus.destroy();
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
      const seen = [...a.handled, ...b.handled].map((h) => h.correlationId);
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
      a.ingest('gather:summary-result', { summary: 'answered' }, { meta: { correlationId: 'cid-h0' } });
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
      b.ingest('gather:summary-result', { summary: 'from-b' }, { meta: { correlationId: 'cid-h1' } });
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
      a.ingest('gather:summary-result', { summary: 'from-non-holder' }, { meta: { correlationId: 'cid-h6' } });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'reply from a non-claim-holder instance').toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      done();
    }
  });

  test('H7: a gateway-internal busRequest reaches a remote bus-client actor across the broker', async () => {
    // The yield:create starvation bug, as a test
    // (.plans/bugs/yield-create-unbridged-starves-resource-creation.md):
    // POST /resources ran busRequest over the RAW bus, which a remote plane
    // never feeds — the Stower, a bus CLIENT in the Archivist, heard
    // nothing and the create hung its full timeout. The fix is the plane
    // primitive (`requestPrimitiveFor`).
    //
    // The service side runs the Archivist's real roster and pumps, not a plane
    // subscriber on the two channels this test needs: a fake attached beneath
    // the wiring is green whatever the wiring does.
    const { a, b, done } = await twoInstances();
    try {
      const stower = archivistOver(b.composition.plane);
      stower.localBus.frames('yield:create').subscribe((frame) => {
        stower.localBus.emit('yield:create-ok', {
          response: { resourceId: 'urn:semiont:r-h7' },
        } as never, { correlationId: frame.correlationId });
      });

      // B's subscription must be REGISTERED before the request is published:
      // `subscribeClient` is synchronous, registering the interest with NATS is
      // not, and core NATS is at-most-once, so a frame published first is
      // DROPPED rather than delayed. The request then waits out its full
      // deadline for a reply that was never going to come, which is why raising
      // the timeout did not fix this (CI, 2026-09-16, `timed out after 5000ms
      // on yield:create-ok`).
      //
      // This was an emit-until-seen probe — a correlationId-less `yield:create`
      // repeated until the fake Stower saw one — which is probable rather than
      // certain and cost the handler a branch that existed only for the test.
      // `flush()` asks the question directly (SIGNAL-PLANE-FLUSH P3.3).
      await b.composition.plane.flush();

      const response = await a.request('yield:create', { name: 'h7' });
      expect(response).toEqual({ resourceId: 'urn:semiont:r-h7' });
      stower.close();
    } finally {
      done();
    }
  });

  test('H7b: the Archivist roster answers EVERY operation it claims, across the broker', async () => {
    // The whole roster, where at-most-once delivery is real: a channel missing
    // from the inbound set fails here rather than starving a live service.
    const { a, b, done } = await twoInstances();
    try {
      const stower = archivistOver(b.composition.plane);
      const answered = Object.entries(BUS_OPERATIONS).filter(
        ([request, op]) =>
          (ARCHIVIST_INBOUND_CHANNELS as readonly string[]).includes(request) &&
          (ARCHIVIST_OUTBOUND_CHANNELS as readonly string[]).includes(op.result),
      );
      expect(answered.length, 'the Archivist roster answers nothing — this would pass vacuously').toBeGreaterThan(0);

      for (const [request, op] of answered) {
        stower.localBus.frames(request as keyof EventMap).subscribe((frame) => {
          stower.localBus.emit(op.result, { response: { ok: request } } as never, {
            correlationId: frame.correlationId,
          });
        });
      }
      await b.composition.plane.flush();

      for (const [request] of answered) {
        const response = await a.request(request as BusOperationKey, { probe: request });
        expect(response, `${request} did not round-trip through the Archivist's real wiring`).toEqual({
          ok: request,
        });
      }
      stower.close();
    } finally {
      done();
    }
  });

  test('H8: a queue announcement on the bus reaches a worker-shaped client on the other instance', async () => {
    // The worker starvation bug as a test
    // (.plans/bugs/job-queued-classified-in-process-starves-workers.md):
    // the queue DRIVERS emit `job:queued` on the raw bus, and its old
    // fallthrough classification ('in-process') made the bridge's direction
    // filter drop it silently — workers heard nothing, forever. Now it is a
    // declared bridged broadcast and rides JOB_QUEUE_EMITS through the
    // outbound bridge.
    const { a, b, done } = await twoInstances();
    try {
      const worker = b.client('worker-h8', ['job:queued']);
      await settle(() => {
        if (worker.frames.length >= 1) return true;
        // Emit-until-seen, as H4: the queue driver re-announces on a timer
        // in production, so repetition is the honest model too.
        a.emitOnBus('job:queued', { jobId: 'job-h8', jobType: 'generate' });
        return false;
      });
      expect(worker.frames.length, 'worker heard the announcement').toBeGreaterThanOrEqual(1);
      expect(worker.frames[0]!.channel).toBe('job:queued');
      worker.close();
    } finally {
      done();
    }
  });

  test('H9: the REAL worker manifest hears the queue announcement (composition grain)', async () => {
    // The grain gap every bring-up bug of 2026-09-16 slipped through. H8
    // above proves the transport carries `job:queued` — but it composes its
    // client with `['job:queued']` hand-written into the subscription list,
    // so it is green whether or not any real worker subscribes that channel.
    // The outage was exactly that difference: the frame was on the broker and
    // the worker's own set did not name it. `lastQueuedEventAt: null` was the
    // only tell.
    //
    // So compose WORKER_CHANNELS itself — the set a worker process actually
    // constructs its transport with. Remove an entry from
    // WORKER_CONSUMED_BROADCASTS and this goes red while H8 stays green.
    const { a, b, done } = await twoInstances();
    try {
      const worker = b.client('worker-h9', [...WORKER_CHANNELS]);

      // Both declared broadcasts, because both are load-bearing and neither
      // is derivable from an operation: the queue announcement the adapter
      // races for, and the cooperative cancel of a RUNNING job — which is an
      // operation REQUEST channel the worker consumes and never answers, so
      // it is absent from BRIDGED_CHANNELS and reaches a worker only by being
      // named in the manifest.
      expect([...WORKER_CONSUMED_BROADCASTS].sort()).toEqual(
        ['job:cancel-requested', 'job:queued'],
      );

      await settle(() => {
        if (worker.frames.some((f) => f.channel === 'job:queued')) return true;
        // Emit-until-seen, as H4/H8: the queue driver re-announces on a timer
        // in production, so repetition is the honest model too.
        a.emitOnBus('job:queued', { jobId: 'job-h9', jobType: 'generate' });
        return false;
      });
      expect(
        worker.frames.some((f) => f.channel === 'job:queued'),
        'a worker composed from the real manifest heard the announcement',
      ).toBe(true);

      await settle(() => {
        if (worker.frames.some((f) => f.channel === 'job:cancel-requested')) return true;
        a.ingest('job:cancel-requested', { jobId: 'job-h9' }, { meta: { correlationId: 'cid-h9' } });
        return false;
      });
      expect(
        worker.frames.some((f) => f.channel === 'job:cancel-requested'),
        'the cooperative cancel reaches the same manifest-composed worker',
      ).toBe(true);

      worker.close();
    } finally {
      done();
    }
  });

  test('H10: job:queued reaches the worker manifest and NOT a default client (audience)', async () => {
    // The routing consequence of WIRE-CROSSING-MODEL P1, proven where it
    // actually happens rather than by comparing two lists.
    //
    // `job:queued` moved from `audience: everyone` to `audience: declared`
    // because the P0 audit found every browser subscribed it and none read
    // it, while the worker -- its only real consumer -- names it in its own
    // manifest. Two clients on one broker, each composed from the REAL set
    // its kind ships with, must therefore disagree about this one frame.
    //
    // Composed from the shipped constants, not hand-written lists: a
    // hand-written list would prove the transport works and say nothing about
    // what any real client subscribes, which is exactly the grain gap that
    // let the 2026-09-16 outage pass every test in the repo.
    const { a, b, done } = await twoInstances();
    try {
      const worker = b.client('worker-h10', [...WORKER_CHANNELS]);
      const browser = b.client('browser-h10', [...BRIDGED_CHANNELS]);

      await settle(() => {
        if (worker.frames.some((f) => f.channel === 'job:queued')) return true;
        a.emitOnBus('job:queued', { jobId: 'job-h10', jobType: 'generate' });
        return false;
      });
      expect(
        worker.frames.some((f) => f.channel === 'job:queued'),
        'the worker manifest declares job:queued, so the worker hears it',
      ).toBe(true);

      // The browser shares the broker and the instance; only its manifest
      // differs. Settling on the worker above means the frames have already
      // been published and delivered -- so this is a real absence, not a race
      // that has yet to resolve.
      expect(
        browser.frames.some((f) => f.channel === 'job:queued'),
        'a default client no longer auto-subscribes job:queued',
      ).toBe(false);

      worker.close();
      browser.close();
    } finally {
      done();
    }
  });

  test('H5: reply recovery answers from the OTHER instance', async () => {
    const { a, b, done } = await twoInstances();
    try {
      b.emitRequest('gather:requested', 'cid-h5', 'client-h5');
      // A's ledger tap must be REGISTERED on the broker before the reply is
      // published, or core NATS drops that frame for A and never retries it —
      // `settle` would then poll a condition that can never become true. The
      // claim becoming visible on A is the proof, and the same barrier H1 and
      // H6 use. Without it this test failed in CI on 2026-09-17 while passing
      // 12/12 locally, which is the signature of this race, not of a bug.
      await a.awaitClaim('cid-h5');
      b.ingest('gather:summary-result', { summary: 'kept' }, { meta: { correlationId: 'cid-h5' } });
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
