/**
 * The NATS Signal Plane driver (SIGNAL-PLANE P1) — CORE subjects only,
 * NEVER the JetStream API (D3: the plane is never consulted as a record;
 * this driver's abstinence is gated, and the conformance fixture runs its
 * server WITHOUT `-js`, so capture is structurally impossible there).
 *
 * THE SUBJECT MAPPING — stated ONCE, here, and gated (a hand-written second
 * statement anywhere is a mirror; the driver-boundary suite censuses the
 * `'sig.'` literal to this file):
 *
 *   global channel          sig.chan.<channel with ':' → '.'>
 *   scoped channel          sig.scope.<base64url(scope)>.<channel with ':' → '.'>
 *   reply-address inbox     sig.inbox.<base64url(address)>
 *
 * Constraints the mapping carries (Open question 1, resolved here):
 *  - `sig.` is DISJOINT from every JetStream stream filter — asserted against
 *    `JOBS_STREAM_SUBJECTS` (the one home of `jobs.>`), mutation-proven;
 *  - channel names ride the subject after ':' → '.' (their vocabulary has no
 *    dots, wildcards or whitespace — asserted at map time, loudly);
 *  - scopes and addresses are base64url-encoded WHOLE: resource ids carry
 *    dots and colons, and an unencoded scope would fracture into subject
 *    tokens. This also puts the `ReplyAddress` (today: the clientId) into
 *    subject space — the deliberate, recorded weakening: contained while
 *    only the gateway connects; live if D1a's Archivist exception is taken.
 *
 * Inbox subjects: SUBSCRIBED per `subscribeClient` address, PUBLISHED by
 * `deliver` — the P3 resolution of "which side publishes to an inbox": the
 * CLAIMING side does, announcing each accepted claim to the shared ledger
 * address so every replica's ledger converges (`signal/ledger.ts` owns that
 * policy; this driver moves envelopes). Per-client inboxes remain
 * subscribed-and-unpublished — replies stay channel-broadcast under the
 * gateway's entitlement gate. Frames arriving on an inbox carry an
 * `{ channel, payload }` envelope, since the subject no longer names the
 * channel.
 */
import { JSONCodec, connect, type NatsConnection, type Subscription } from 'nats';
import { getLogger } from '../logger';
import type {
  ClientSubscriptionSpec,
  IngestReceipt,
  OnFrame,
  PlaneSubscription,
  SignalPlane,
} from './interface';
import { resolveSignalPlaneOptions, type SignalPlaneOptions } from './options';

const getSignalLogger = () => getLogger().child({ component: 'signal' });

export const SIGNAL_SUBJECT_PREFIX = 'sig.';

const b64url = (raw: string): string => Buffer.from(raw, 'utf8').toString('base64url');

export function channelToken(channel: string): string {
  if (/[.*>\s]/.test(channel)) {
    // The vocabulary owns channel names; a name that cannot ride a subject
    // is a registry problem to surface, never to quietly encode around.
    throw new Error(`signal/nats: channel "${channel}" cannot map onto a subject token`);
  }
  return channel.replaceAll(':', '.');
}

export const subjectForChannel = (channel: string): string =>
  `${SIGNAL_SUBJECT_PREFIX}chan.${channelToken(channel)}`;

export const subjectForScoped = (scope: string, channel: string): string =>
  `${SIGNAL_SUBJECT_PREFIX}scope.${b64url(scope)}.${channelToken(channel)}`;

export const inboxSubjectFor = (address: string): string =>
  `${SIGNAL_SUBJECT_PREFIX}inbox.${b64url(address)}`;

interface InboxEnvelope {
  channel: string;
  payload: unknown;
}

export interface NatsSignalPlaneOptions extends SignalPlaneOptions {
  servers: string;
  /** Passed through to the client; the conformance fixture disables it. */
  reconnect?: boolean;
}

export async function createNatsSignalPlane(opts: NatsSignalPlaneOptions): Promise<SignalPlane> {
  const options = resolveSignalPlaneOptions(opts);
  const nc: NatsConnection = await connect({
    servers: opts.servers,
    // The plane's recovery story is "restart the broker manually" (Live
    // gate, broker-down protocol) — so the client retries FOREVER. The
    // library default (10 attempts, ~20 s) closed the connection
    // permanently in the first live broker-down run: every emit 500'd
    // even after the broker returned, and only a gateway restart would
    // have recovered. Found by the gate, 2026-09-15.
    maxReconnectAttempts: -1,
    ...(opts.reconnect === undefined ? {} : { reconnect: opts.reconnect }),
  });
  const codec = JSONCodec();
  const open = new Set<Subscription>();

  // The connection-status watcher (Live gate, broker-down protocol item 3:
  // degradation must produce a breadcrumb — "silence is itself a failure",
  // LIVENESS-AXIOMS L4). With infinite reconnect the first live outage was
  // QUIET: frames buffered client-side, callers got 202s, nothing logged.
  // These two lines are what an operator greps during a broker outage.
  // The loop ends when dispose() closes the connection.
  void (async () => {
    for await (const status of nc.status()) {
      if (status.type === 'disconnect') {
        getSignalLogger().warn(
          '[signal BROKER-DOWN] NATS connection lost; frames buffer client-side until reconnect',
          { servers: opts.servers },
        );
      } else if (status.type === 'reconnect') {
        getSignalLogger().info('[signal BROKER-RECONNECTED] NATS connection restored', {
          servers: opts.servers,
        });
      }
    }
  })();

  const track = (s: Subscription): Subscription => {
    open.add(s);
    return s;
  };
  const closeAll = (subs: Subscription[]) => {
    for (const s of subs) {
      s.unsubscribe();
      open.delete(s);
    }
  };

  return {
    ingest(channel, payload, scope): IngestReceipt {
      const subject = scope ? subjectForScoped(scope, channel) : subjectForChannel(channel);
      nc.publish(subject, codec.encode(payload));
      // A remote fabric cannot count observers: report nothing, never a
      // fabricated zero (see IngestReceipt).
      return {};
    },

    subscribeClient(spec: ClientSubscriptionSpec): PlaneSubscription {
      if (spec.scoped.length > options.maxScopes) {
        throw new Error(
          `signal plane: ${spec.scoped.length} scopes exceeds the per-subscription cap of ${options.maxScopes}`,
        );
      }
      const subs: Subscription[] = [];
      for (const channel of spec.global) {
        subs.push(
          track(
            nc.subscribe(subjectForChannel(channel), {
              callback: (_err, msg) => {
                if (_err) return;
                spec.onFrame(channel, codec.decode(msg.data), undefined);
              },
            }),
          ),
        );
      }
      for (const entry of spec.scoped) {
        for (const channel of entry.channels) {
          subs.push(
            track(
              nc.subscribe(subjectForScoped(entry.scope, channel), {
                callback: (_err, msg) => {
                  if (_err) return;
                  spec.onFrame(channel, codec.decode(msg.data), entry.scope);
                },
              }),
            ),
          );
        }
      }
      subs.push(
        track(
          nc.subscribe(inboxSubjectFor(spec.address), {
            callback: (_err, msg) => {
              if (_err) return;
              const envelope = codec.decode(msg.data) as InboxEnvelope;
              spec.onFrame(envelope.channel, envelope.payload, undefined);
            },
          }),
        ),
      );
      return { close: () => closeAll(subs) };
    },

    deliver(address, channel, payload): void {
      const envelope: InboxEnvelope = { channel, payload };
      nc.publish(inboxSubjectFor(address), codec.encode(envelope));
    },

    subscribeHandlers(group: string, channels: readonly string[], onFrame: OnFrame): PlaneSubscription {
      const subs: Subscription[] = [];
      for (const channel of channels) {
        subs.push(
          track(
            // The queue group IS handler mode: the server delivers each
            // frame to at most one member of the group, never two (D2).
            nc.subscribe(subjectForChannel(channel), {
              queue: group,
              callback: (_err, msg) => {
                if (_err) return;
                onFrame(channel, codec.decode(msg.data), undefined);
              },
            }),
          ),
        );
      }
      return { close: () => closeAll(subs) };
    },

    dispose() {
      for (const s of open) s.unsubscribe();
      open.clear();
      void nc.close().catch(() => {});
    },
  };
}

