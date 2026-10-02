/**
 * The telemetry the gateway exports, which dashboards and alerts are built on:
 * the spans and metrics specs/src/service-telemetry/telemetry.json lists for it,
 * exported over OTLP to the endpoint the standard OpenTelemetry environment
 * names, and the trace context carried onto bus frames (docs/protocol/EVENT-BUS.md
 * § Trace context). Each plane exports to a receiver of its own, and its last
 * case holds everything that receiver got to the table, in both directions.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { storedEvent } from '../harness/archivist';
import { call } from '../harness/http';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, operationFor, spanName, spec, telemetry } from '../harness/spec';
import { expectedOn, outsideTheTable } from '../harness/telemetry';
import { eachPlane, PLANES } from '../harness/world';
import type { Plane } from '../harness/gateway';

/** OTLP's span kinds. */
const SERVER = 2;
const CLIENT = 3;
const PRODUCER = 4;

const receivers = new Map<Plane, OtlpReceiver>();
beforeAll(async () => {
  for (const plane of PLANES) receivers.set(plane, await startOtlp());
});
afterAll(async () => {
  for (const receiver of receivers.values()) await receiver.close();
});
const receiverFor = (plane: Plane): OtlpReceiver => {
  const receiver = receivers.get(plane);
  if (!receiver) throw new Error(`no OTLP receiver for the ${plane} plane`);
  return receiver;
};

const traceparent = () => {
  const traceId = randomUUID().replaceAll('-', '');
  const spanId = randomUUID().replaceAll('-', '').slice(0, 16);
  return { traceId, spanId, header: `00-${traceId}-${spanId}-01` };
};

for (const onPlane of PLANES) {
eachPlane(
  'what the gateway exports',
  (world, plane) => {
    const otlp = () => receiverFor(plane);
    it('a traced emit is a bus.dispatch server span in the caller\'s trace, and its frames carry the trace on', async () => {
      const watcher = await world().subscribe(await world().person('watcher'), { clientId: randomUUID(), global: ['beckon:focus'] });
      const t = traceparent();
      const marker = randomUUID();
      const reply = await call(world().origin, 'POST', '/bus/emit', {
        token: await world().person('tracer'),
        json: { channel: 'beckon:focus', payload: { annotationId: marker } },
        headers: { traceparent: t.header },
      });
      expect(reply.status).toBe(202);
      const span = await eventually('the bus.dispatch span', 10_000, () =>
        otlp().spans.find((s) => s.name === spanName('bus.dispatch:{channel}', { channel: 'beckon:focus' }) && s.traceId === t.traceId),
      );
      expect(span.kind).toBe(SERVER);
      expect(span.parentSpanId).toBe(t.spanId);
      expect(span.attributes['bus.channel']).toBe('beckon:focus');
      expect(span.service).toBe('semiont-gateway');

      const frame = await watcher.frame('beckon:focus', (f) => f.payload['annotationId'] === marker);
      const carried = (frame.payload['_trace'] as { traceparent?: string } | undefined)?.traceparent ?? '';
      expect(carried.split('-')[1]).toBe(t.traceId);
    });

    it('a reply delivered to its requester is an sse.deliver producer span', async () => {
      const request = 'browse:resource-requested';
      const { result } = operationFor(request);
      await world().responder([request], () => ({
        channel: result,
        payload: { response: { resource: { '@context': 'https://schema.org/', '@id': 'x', name: 'x', representations: [] }, annotations: [], entityReferences: [] } },
      }));
      const alice = await world().person('alice');
      const clientId = randomUUID();
      const stream = await world().subscribe(alice, { clientId, global: [result] });
      const correlationId = randomUUID();
      await world().emit(alice, { channel: request, payload: { resourceId: 'r' }, correlationId, clientId });
      await stream.frame(result, (f) => f.correlationId === correlationId);
      const span = await eventually('the sse.deliver span', 10_000, () =>
        otlp().spans.find((s) => s.name === spanName('sse.deliver:{channel}', { channel: result }) && s.attributes['bus.cid'] === correlationId),
      );
      expect(span.kind).toBe(PRODUCER);
    });

    it('content reads and writes, descriptions and replay reads, are server spans with an archivist client span beneath', async () => {
      const token = await world().person('reader');
      const id = `res-${randomUUID()}`;
      world().archivist.resources.set(id, { storageUri: `file://${id}`, mediaType: 'text/plain' });
      world().archivist.content.set(`file://${id}`, Buffer.from('bytes'));
      const t = traceparent();
      await call(world().origin, 'GET', `/resources/${id}`, { token, headers: { traceparent: t.header } });
      const server = await eventually(spanName('content.get.server'), 10_000, () => otlp().spans.find((s) => s.name === spanName('content.get.server') && s.traceId === t.traceId));
      expect(server.kind).toBe(SERVER);
      const client = await eventually(spanName('archivist.content.get'), 10_000, () => otlp().spans.find((s) => s.name === spanName('archivist.content.get') && s.traceId === t.traceId));
      expect(client.kind).toBe(CLIENT);
      expect(client.attributes['peer.service']).toBe('archivist');

      const upload = new FormData();
      for (const [k, v] of Object.entries({ name: 'traced', format: 'text/plain', storageUri: `file://uploads/${randomUUID()}.txt` })) upload.set(k, v);
      upload.set('file', new Blob(['traced bytes'], { type: 'text/plain' }), 'traced.txt');
      const put = traceparent();
      const uploaded = await call(world().origin, 'POST', '/resources', { token, body: upload, headers: { traceparent: put.header } });
      expect(uploaded.status, uploaded.text).toBe(202);
      expect((await eventually(spanName('content.put.server'), 10_000, () => otlp().spans.find((s) => s.name === spanName('content.put.server') && s.traceId === put.traceId))).kind).toBe(SERVER);
      expect((await eventually(spanName('archivist.resources.record'), 10_000, () => otlp().spans.find((s) => s.name === spanName('archivist.resources.record') && s.traceId === put.traceId))).kind).toBe(CLIENT);

      world().archivist.descriptions.set(id, {
        resource: { '@context': 'https://schema.org/', '@id': id, name: 'traced', representations: [] },
        annotations: [],
        entityReferences: [],
      });
      const describe = traceparent();
      expect((await call(world().origin, 'GET', `/resources/${id}/jsonld`, { token, headers: { traceparent: describe.header } })).status).toBe(200);
      expect((await eventually(spanName('archivist.resources.describe'), 10_000, () => otlp().spans.find((s) => s.name === spanName('archivist.resources.describe') && s.traceId === describe.traceId))).kind).toBe(CLIENT);

      const scope = `res-${randomUUID()}`;
      world().archivist.events.set(scope, [storedEvent('mark:added', scope, 2)]);
      const replay = await world().open(token, { clientId: randomUUID(), scoped: [{ scope, channels: ['mark:added'], lastEventId: `p-${scope}-1` }] });
      await replay.next('the first ping', (m) => m.event === 'ping');
      const replaySpan = await eventually(spanName('archivist.events.replay'), 10_000, () => otlp().spans.find((s) => s.name === spanName('archivist.events.replay')));
      expect(replaySpan.kind).toBe(CLIENT);
    });

    it('exports the bus and subscriber metrics, with the attributes dashboards group them by', async () => {
      // Something to count for each: an emit, a subscriber, a resume gap, a
      // reply withheld from a subscriber that did not ask for it.
      const token = await world().person('metered');
      await world().emit(token, { channel: 'beckon:focus', payload: {} });
      const gap = await world().open(token, { clientId: randomUUID(), scoped: [{ scope: 'res-metered', channels: ['mark:added'], lastEventId: 'garbage' }] });
      await gap.next('the first ping', (m) => m.event === 'ping');
      const request = 'browse:resource-requested';
      const { result } = operationFor(request);
      const clientId = randomUUID();
      const correlationId = randomUUID();
      const owner = await world().subscribe(token, { clientId, global: [result] });
      await world().subscribe(await world().person('not-the-owner'), { clientId: randomUUID(), global: [result] });
      await world().emit(token, { channel: request, payload: { resourceId: 'r' }, correlationId, clientId });
      const participant = await world().agent('conformance', 'metered');
      await world().emit(participant.token, {
        channel: result,
        payload: { response: { resource: { '@context': 'https://schema.org/', '@id': 'x', name: 'x', representations: [] }, annotations: [], entityReferences: [] } },
        correlationId,
      });
      await owner.frame(result, (f) => f.correlationId === correlationId);

      // A request nothing answers: counted where the plane can count subscribers.
      await world().emit(token, { channel: 'browse:kb-requested', payload: {}, correlationId: randomUUID(), clientId: randomUUID() });

      // A burst past one principal's emit bucket: a refusal, counted by its reason.
      const { baseline } = spec().principalLimit<{ perSecond: number; burst: number }>('post', '/bus/emit', 'emitsPerPrincipal');
      const hasty = await world().person('hasty');
      await eventually('an emit refused past its bucket', 15_000, async () => {
        const replies = await Promise.all(Array.from({ length: baseline.burst }, () => world().emit(hasty, { channel: 'beckon:focus', payload: {} })));
        return replies.some((r) => r.status === 429) ? true : undefined;
      });

      // A request refused 401, for each reason one can be: no token, a token
      // the gateway did not sign and the issuer did not, a media token that is none.
      expect((await call(world().origin, 'GET', '/api/users/me')).status).toBe(401);
      expect((await call(world().origin, 'GET', '/api/users/me', { token: 'not-a-token' })).status).toBe(401);
      expect((await call(world().origin, 'GET', '/api/resources/res-metered?token=not-a-media-token')).status).toBe(401);
      const unauthenticated = await eventually('every reason a request is refused 401 for', 15_000, () => {
        const reasons = otlp().metrics.get(metricName('semiont.gateway.unauthenticated'))?.attributes.get('unauthenticated.reason');
        return reasons?.size === 3 ? reasons : undefined;
      });
      expect([...unauthenticated].sort()).toEqual(['invalid_media_token', 'invalid_token', 'missing_token']);

      for (const row of expectedOn(telemetry('gateway').metrics, plane).filter((r) => r.when === 'traffic')) {
        const seen = await eventually(`the ${row.name} metric`, 15_000, () => otlp().metrics.get(metricName(row.name)));
        for (const attribute of row.attributes.filter((a) => !a.only)) {
          await eventually(`${row.name} carrying ${attribute.key}`, 15_000, () => (seen.attributes.has(attribute.key) ? true : undefined));
        }
      }
    });

    // Last in its plane, and judged on everything this plane's cases made the
    // gateway export: run it with them, never alone.
    it('exports exactly the telemetry the spec lists: every row it can, and nothing else', async () => {
      expect(await outsideTheTable(otlp(), 'gateway', plane)).toEqual([]);
    });
  },
  {
    env: {
      // Read when the world starts, after the receivers above are listening.
      get OTEL_EXPORTER_OTLP_ENDPOINT() {
        return receiverFor(onPlane).endpoint;
      },
      OTEL_METRIC_EXPORT_INTERVAL: '500',
      OTEL_BSP_SCHEDULE_DELAY: '100',
    },
  },
  [onPlane],
);
}
