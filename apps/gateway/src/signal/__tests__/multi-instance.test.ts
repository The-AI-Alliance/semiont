/**
 * The multi-replica capability PROOF harness (SIGNAL-PLANE P3) — two
 * gateway-compositions over one core-only broker, the JOB-QUEUE-DRIVER
 * multi-instance test as template.
 *
 * THE POINT OF THIS FILE IS ITS FAILURES. The cross-replica claim question
 * (Open question 3 — "formally open; not evenly balanced") is decided
 * AGAINST this proof: properties that today's replica-local composition
 * cannot satisfy are encoded with `test.fails` — executed, inverted, never
 * skipped — so each flips LOUDLY to a hard failure the moment P3's design
 * lands and must then be promoted to a plain `test`. Green here without
 * promotion means someone fixed the behavior and forgot the spec.
 *
 * What writing this harness surfaced (2026-09-15), sharper than the
 * cross-replica question: TWO composition holes that bite at ONE instance
 * on `type = "nats"` — the emit route dispatches through `plane.ingest`
 * alone, and two consumers still listen only to the in-process EventBus the
 * NATS driver never feeds:
 *
 *  - **H0 — the ledger's tap** (`createCorrelationRegistry(eventBus)`,
 *    routes/bus.ts): claims are never marked answered, retention never
 *    fires. Delivery works; accounting and reconnect recovery do not.
 *    Live-gate tells: empty `pendingReplies` recovery, the 256 unanswered
 *    cap filling over a long session, `[bus CLAIM-EXPIRED]` for answered
 *    requests.
 *  - **H2 — the gateway-resident handlers** (`registerGatewayBusHandlers`,
 *    make-meaning service.ts:454): NOTHING in production calls
 *    `plane.subscribeHandlers`, so an HTTP-emitted `job:create` reaches the
 *    broker and no handler — every job flow times out at the full 30 s
 *    (observers is undefined under NATS, so the unanswerable-request
 *    fast-fail correctly stays silent). Same fate: `job:claim`,
 *    `job:cancel-requested`, `bind:update-body`; and `job:complete` /
 *    `job:fail` / `job:report-progress` still broadcast to clients but no
 *    longer update job state — those three are DUAL-mode (client fan-out
 *    AND at-most-once handler) when P3 wires them.
 *
 * MIRROR HAZARD, deliberately temporary: `makeInstance` hand-wires the
 * ledger + entitlement filter the way `routes/bus.ts` does. P3's GREEN must
 * extract that composition into ONE shared helper consumed by both the
 * route and this harness — two copies of the wiring is exactly the drift
 * this plan exists to end.
 */
import { afterAll, describe, test, expect } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EventBus } from '@semiont/core';
import type { SignalPlane } from '../interface';
import { toReplyAddress } from '../interface';
import { createNatsSignalPlane } from '../nats';
import { createCorrelationRegistry } from '../ledger';
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

interface Instance {
  name: string;
  plane: SignalPlane;
  registry: ReturnType<typeof createCorrelationRegistry>;
  /** Emit-as-claim, as the /bus/emit route does it. */
  emitRequest(channel: string, cid: string, clientId: string, payload?: Record<string, unknown>): void;
  /** A reply/broadcast ingest, as any responder's emit. */
  ingest(channel: string, payload: unknown, scope?: string): void;
  /** A subscribed client with the route's entitlement filter, THIS instance's ledger. */
  client(clientId: string, channels: string[]): { frames: Array<{ channel: string; payload: unknown }>; close(): void };
  teardown(): void;
}

const PRINCIPAL = 'did:web:test:users:p3';

async function makeInstance(name: string, servers: string): Promise<Instance> {
  // The bus exists because the ledger's tap subscribes it — WHICH THE NATS
  // DRIVER DOES NOT FEED. That inertness is H0's subject, not an oversight.
  const bus = new EventBus();
  const plane = await createNatsSignalPlane({ servers, reconnect: false });
  const registry = createCorrelationRegistry(bus);
  return {
    name,
    plane,
    registry,
    emitRequest(channel, cid, clientId, payload = {}) {
      const outcome = registry.claim(cid, clientId, PRINCIPAL);
      expect(outcome, `${name}: claim ${cid}`).toBe('ok');
      plane.ingest(channel, { ...payload, correlationId: cid, _userId: PRINCIPAL });
    },
    ingest(channel, payload, scope) {
      plane.ingest(channel, payload, scope);
    },
    client(clientId, channels) {
      const frames: Array<{ channel: string; payload: unknown }> = [];
      const sub = plane.subscribeClient({
        address: toReplyAddress(clientId),
        global: channels,
        scoped: [],
        onFrame: (channel, payload) => {
          // The route's entitlement gate, verbatim in miniature: an
          // unscoped correlated frame passes only if THIS instance's ledger
          // says this client owns it (see the mirror-hazard note above).
          if (isCorrelatedChannel(channel)) {
            const cid = (payload as { correlationId?: unknown } | null)?.correlationId;
            if (typeof cid !== 'string') return;
            const owner = registry.owner(cid);
            if (!owner || owner.clientId !== clientId || owner.principalDid !== PRINCIPAL) return;
          }
          frames.push({ channel, payload });
        },
      });
      return { frames, close: () => sub.close() };
    },
    teardown() {
      registry.dispose();
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
      b.ingest('beckon:focus', { n: 1 });
      await settle(() => ca.frames.length >= 1 && cb.frames.length >= 1);
      expect(ca.frames.length, 'client on A').toBeGreaterThanOrEqual(1);
      expect(cb.frames.length, 'client on B').toBeGreaterThanOrEqual(1);
      ca.close();
      cb.close();
    } finally {
      done();
    }
  });

  test('H3: a handler-mode command executes on ONE instance, never both (job:create probe)', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const seenA: unknown[] = [];
      const seenB: unknown[] = [];
      const ha = a.plane.subscribeHandlers('gateways', ['job:create'], (_c, p) => seenA.push(p));
      const hb = b.plane.subscribeHandlers('gateways', ['job:create'], (_c, p) => seenB.push(p));
      const sent = Array.from({ length: 10 }, (_, i) => ({ i }));
      for (const [i, p] of sent.entries()) (i % 2 ? a : b).ingest('job:create', p);
      await settle(() => seenA.length + seenB.length >= sent.length);
      const inA = new Set(seenA.map((p) => JSON.stringify(p)));
      for (const p of seenB) {
        expect(inA.has(JSON.stringify(p)), `frame ${JSON.stringify(p)} executed on BOTH instances`).toBe(false);
      }
      expect(seenA.length + seenB.length).toBeLessThanOrEqual(sent.length);
      ha.close();
      hb.close();
    } finally {
      done();
    }
  });

  // ── The failures that ARE the finding ────────────────────────────────

  test.fails('H0 (single instance!): a claimed request answered over NATS marks the claim and retains the reply', async () => {
    const { a, done } = await twoInstances();
    try {
      const client = a.client('client-h0', ['gather:summary-result']);
      a.emitRequest('gather:requested', 'cid-h0', 'client-h0');
      a.ingest('gather:summary-result', { correlationId: 'cid-h0', summary: 'answered' });
      await settle(() => client.frames.length >= 1);
      // Delivery works. The LEDGER heard nothing: its tap watches the
      // in-process bus the NATS driver never feeds.
      expect(client.frames.length).toBeGreaterThanOrEqual(1);
      expect(a.registry.occupancy().retainedReplies, 'retention').toBe(1);
      expect(a.registry.lookupReply('cid-h0', 'client-h0', PRINCIPAL), 'pendingReplies recovery').toBeDefined();
      client.close();
    } finally {
      done();
    }
  });

  test.fails('H2: production wires the gateway-resident handlers through the plane', async () => {
    // A wiring CENSUS, not behavior — the honest instrument until P3
    // extracts the shared route/harness composition (the mirror-hazard note
    // above), at which point this must become a behavioral test through
    // that helper. `registerGatewayBusHandlers` subscribes the in-process
    // EventBus; under a broker plane those subscriptions starve unless some
    // production module bridges them via `plane.subscribeHandlers`. Today:
    // nobody does.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.join(here, '..', '..', '..', '..', '..');
    const callers: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules') await walk(p);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          // CODE, not prose — a comment MENTIONING the verb must not satisfy
          // a required-presence census.
          const stripped = (await fs.readFile(p, 'utf-8'))
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '');
          if (stripped.includes('.subscribeHandlers(')) callers.push(path.relative(root, p));
        }
      }
    };
    await walk(path.join(root, 'apps', 'gateway', 'src'));
    await walk(path.join(root, 'packages', 'make-meaning', 'src'));
    // The drivers implement the verb; implementing is not calling.
    const productionCallers = callers.filter(
      (p) => !p.endsWith(path.join('signal', 'in-process.ts')) && !p.endsWith(path.join('signal', 'nats.ts')),
    );
    expect(productionCallers, 'no production caller bridges handler channels onto the plane').not.toEqual([]);
  });

  test.fails('H1: request claimed via B delivers its reply to the client subscribed on A', async () => {
    const { a, b, done } = await twoInstances();
    try {
      const client = a.client('client-h1', ['gather:summary-result']);
      // The LB sent the emit to B: the claim lives in B's ledger. A's
      // entitlement filter asks A's ledger, which has never heard of it.
      b.emitRequest('gather:requested', 'cid-h1', 'client-h1');
      b.ingest('gather:summary-result', { correlationId: 'cid-h1', summary: 'from-b' });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'reply delivered across instances').toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      done();
    }
  });

  test.fails('H6: the reply is emitted via an instance that does NOT hold the claim', async () => {
    const { a, b, done } = await twoInstances();
    try {
      // The discriminator the plan names (P3 property 2): handler mode makes
      // "reply at a non-claim-holder" a coin flip per request at N=2, and a
      // harness that emits replies via the holder would pass a replica-local
      // design without ever exercising this. Claim on B; the responder's
      // emit AND the client both ride A.
      const client = a.client('client-h6', ['gather:summary-result']);
      b.emitRequest('gather:requested', 'cid-h6', 'client-h6');
      a.ingest('gather:summary-result', { correlationId: 'cid-h6', summary: 'from-non-holder' });
      await settle(() => client.frames.length >= 1);
      expect(client.frames.length, 'reply from a non-claim-holder instance').toBeGreaterThanOrEqual(1);
      client.close();
    } finally {
      done();
    }
  });

  test.fails('H5: reply recovery survives reconnecting to the OTHER instance', async () => {
    const { a, b, done } = await twoInstances();
    try {
      b.emitRequest('gather:requested', 'cid-h5', 'client-h5');
      b.ingest('gather:summary-result', { correlationId: 'cid-h5', summary: 'kept' });
      await settle(() => b.registry.occupancy().retainedReplies >= 1);
      // The client reconnects to A and probes pendingReplies there.
      expect(a.registry.lookupReply('cid-h5', 'client-h5', PRINCIPAL), 'recovery on the other instance').toBeDefined();
    } finally {
      done();
    }
  });
});
