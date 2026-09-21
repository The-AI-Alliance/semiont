/**
 * The multi-replica capability PROOF (SIGNAL-PLANE P3 — GREEN 2026-09-15;
 * re-pointed at the dispatcher for EXTRACT-JOBS P2/P3).
 *
 * Two full gateway-side compositions over one core-only broker, each built
 * from the SAME modules production boots: `compositionFor` (plane + ledger +
 * the standing tap + claim announcements). The `job:*` handlers the gateway
 * used to host — reconnected to a remote plane by `bridgeGatewayHandlers` —
 * moved to the DISPATCHER (EXTRACT-JOBS): a fan-out service that subscribes its
 * roster through /bus/subscribe and answers on its own bus, exactly like the
 * Archivist. It is composed here the same way the Archivist is, through
 * `serviceOver` + `attachServicePumps` over its REAL DISPATCHER_INBOUND/OUTBOUND
 * rosters — no bridge, because there is no gateway-resident island left to
 * reconnect.
 *
 * What each proves (the plan's property numbering):
 *  - H0  (found at RED): the ledger is plane-fed — answered/retention work
 *        over a broker at N=1;
 *  - H1  (property 1): a request claimed via B delivers to a client on A —
 *        claim announcements converge the ledgers;
 *  - H2  (property 3, re-pointed): an HTTP-shaped `job:create` claimed at A
 *        reaches the single dispatcher attached at B and its `job:created`
 *        reply crosses the broker back to the requester at A — the
 *        plane-crossing round trip (EXTRACT-JOBS C3) that took the stack down
 *        twice in September, at unit grain;
 *  - H4  (property 4): broadcasts reach clients on both instances;
 *  - H5  (property 5): reply recovery (`pendingReplies`) answers from the
 *        OTHER instance;
 *  - H6  (property 2): the reply is emitted via an instance that does NOT
 *        hold the claim — the discriminator replica-local designs die on;
 *  - H7  (found LIVE, post-GREEN): a gateway-internal `busRequest` rides
 *        the plane primitive and reaches a remote bus-client actor — the
 *        `yield:create` starvation bug as a test;
 *  - H7b : the Archivist roster answers EVERY operation it claims, across
 *        the broker;
 *  - H8  (found LIVE, post-GREEN; re-pointed): the DISPATCHER's outbound pump
 *        carries its raw-bus `job:queued` announcement across the broker to a
 *        worker-shaped client on the other instance — the worker starvation
 *        bug as a test, now proving the pump that replaced the bridge;
 *  - H9  : the REAL worker manifest hears the queue announcement (composition
 *        grain);
 *  - H10 : `job:queued` reaches the worker manifest and NOT a default client
 *        (audience).
 *
 * RETIRED at EXTRACT-JOBS P3 — the old H3 ("a bridged handler command executes
 * on ONE gateway instance, never both"). That at-most-once was a property of
 * the gateway HANDLER GROUP (`plane.subscribeHandlers`), which existed only
 * because the handlers lived in the horizontally-scaled gateway. They now live
 * in the dispatcher — a fan-out /bus/subscribe client, of which the deploy runs
 * one — and the handler-group primitive itself is still exercised by
 * `conformance.test.ts`. Execute-once for job WORK is the JetStream queue's
 * `claimNextJob`, proven in the jobs conformance suite — not a plane property.
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
  ARCHIVIST_INBOUND_CHANNELS,
  ARCHIVIST_OUTBOUND_CHANNELS,
  DISPATCHER_INBOUND_CHANNELS,
  DISPATCHER_OUTBOUND_CHANNELS,
  attachServicePumps,
  type PumpTransport,
} from '@semiont/make-meaning';
import { WORKER_CHANNELS, WORKER_CONSUMED_BROADCASTS } from '@semiont/jobs';
import { toReplyAddress, type PlaneEnvelope, type SignalPlane } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { compositionFor, type SignalComposition } from '../composition';
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
  teardown(): void;
}

async function makeInstance(name: string, servers: string): Promise<Instance> {
  // The bus backs the gateway's internal `busRequest` primitive (H7). The
  // job:* handlers that once rode this bus behind `bridgeGatewayHandlers` are
  // gone (EXTRACT-JOBS P3): a gateway hosts no handler island, so there is
  // nothing to bridge. Services attach as their own `serviceOver` compositions.
  const bus = new EventBus();
  const plane = await createNatsSignalPlane({ servers, reconnect: false });
  const composition = compositionFor(bus, plane);

  return {
    name,
    composition,
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
    teardown() {
      composition.dispose();
      plane.dispose();
      bus.destroy();
    },
  };
}

/**
 * A roster-based service as it composes itself: its real inbound/outbound sets
 * through `attachServicePumps`, over a plane-backed stand-in for HttpTransport.
 *
 * Parameterised by roster rather than hardcoded to one service, so a case can
 * ask the same question of whichever service owns the channels it cares about.
 */
function serviceOver(
  plane: SignalPlane,
  name: string,
  inbound: readonly (keyof EventMap)[],
  outbound: readonly (keyof EventMap)[],
): { localBus: EventBus; close(): void } {
  const localBus = new EventBus();
  const subjects = new Map<string, Subject<BusFrame<unknown>>>();
  const subjectFor = (channel: string) => {
    let s = subjects.get(channel);
    if (!s) { s = new Subject<BusFrame<unknown>>(); subjects.set(channel, s); }
    return s;
  };

  const sub = plane.subscribeClient({
    address: toReplyAddress(`tier2-${name}`),
    global: [...inbound],
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

  const pumps = attachServicePumps({ transport, localBus, inbound, outbound, logger: { error: () => {} } });

  return {
    localBus,
    close() {
      for (const p of pumps) p.unsubscribe();
      sub.close();
      localBus.destroy();
    },
  };
}

/** The Archivist roster, composed as its real service. */
const archivistOver = (plane: SignalPlane) =>
  serviceOver(plane, 'archivist', ARCHIVIST_INBOUND_CHANNELS, ARCHIVIST_OUTBOUND_CHANNELS);

/**
 * The Dispatcher (EXTRACT-JOBS): its REAL inbound/outbound rosters through
 * `serviceOver`, plus a mini `job:create` handler on its local bus — the
 * production shape in miniature. A `job:create` relayed in by the inbound pump
 * is answered with `job:created`, which the OUTBOUND pump carries back to the
 * plane (DISPATCHER_OUTBOUND_CHANNELS derives that reply from BUS_OPERATIONS).
 * `handled` records the correlationIds it saw, so a double-relay is caught.
 */
function dispatcherOver(plane: SignalPlane): {
  handled: { correlationId?: string }[];
  localBus: EventBus;
  close(): void;
} {
  const svc = serviceOver(plane, 'dispatcher', DISPATCHER_INBOUND_CHANNELS, DISPATCHER_OUTBOUND_CHANNELS);
  const handled: { correlationId?: string }[] = [];
  svc.localBus.frames('job:create').subscribe(({ correlationId }) => {
    handled.push({ correlationId });
    svc.localBus.emit('job:created', { response: { jobId: `job-${correlationId}` } } as never, { correlationId });
  });
  return { handled, localBus: svc.localBus, close: svc.close };
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

  test('H2: a job:create claimed at A reaches the dispatcher at B and its job:created returns to the requester', async () => {
    const { a, b, done } = await twoInstances();
    try {
      // One dispatcher, attached at B — the deployed shape. A worker's request
      // is claimed and ingested at A; it must cross the broker to B, be handled,
      // and its reply cross back to the requester on A. This is the plane round
      // trip C3 names — the path that took the stack down twice in September.
      const dispatcher = dispatcherOver(b.composition.plane);
      // B's dispatcher subscription must be REGISTERED before the request is
      // published (core NATS is at-most-once), the same barrier H7 uses.
      await b.composition.plane.flush();

      const client = a.client('client-h2', ['job:created']);
      a.emitRequest('job:create', 'cid-h2', 'client-h2', { jobType: 'generate', params: {} });
      await settle(() => client.frames.length >= 1);
      expect(dispatcher.handled.length, 'the dispatcher handled it exactly once').toBe(1);
      expect(dispatcher.handled[0]!.correlationId, "with the requester's correlationId").toBe('cid-h2');
      expect(client.frames.length, 'reply delivered to the requester').toBeGreaterThanOrEqual(1);
      expect(client.frames[0]!.channel).toBe('job:created');
      dispatcher.close();
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

  test('H8: the dispatcher pump carries its job:queued announcement to a worker on the other instance', async () => {
    // The worker starvation bug as a test
    // (.plans/bugs/job-queued-classified-in-process-starves-workers.md):
    // the queue DRIVER emits `job:queued` on the dispatcher's raw bus, and its
    // old fallthrough classification ('in-process') made the OLD gateway bridge
    // drop it silently — workers heard nothing, forever. The bridge is gone
    // (EXTRACT-JOBS P3); the crossing is now the DISPATCHER's outbound pump, and
    // `job:queued` rides it as the one declared stray in
    // DISPATCHER_OUTBOUND_CHANNELS.
    const { a, b, done } = await twoInstances();
    try {
      const dispatcher = dispatcherOver(a.composition.plane);
      const worker = b.client('worker-h8', ['job:queued']);
      await settle(() => {
        if (worker.frames.length >= 1) return true;
        // Emit on the dispatcher's LOCAL bus — the queue driver's shape; the
        // outbound pump is what must carry it to the plane. Re-announced each
        // poll: the driver re-announces on a timer in production, so repetition
        // is the honest model too.
        dispatcher.localBus.emit('job:queued', { jobId: 'job-h8', jobType: 'generate' } as never);
        return false;
      });
      expect(worker.frames.length, 'worker heard the announcement').toBeGreaterThanOrEqual(1);
      expect(worker.frames[0]!.channel).toBe('job:queued');
      dispatcher.close();
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
        // in production, so repetition is the honest model too. The frame's
        // real sender is the dispatcher's outbound pump (H8); here the subject
        // is the RECEIVING worker's manifest, so the frame is put on the plane
        // directly.
        a.ingest('job:queued', { jobId: 'job-h9', jobType: 'generate' });
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
        a.ingest('job:queued', { jobId: 'job-h10', jobType: 'generate' });
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
