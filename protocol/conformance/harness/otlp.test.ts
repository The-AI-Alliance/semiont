/**
 * The receiver itself: an export OpenTelemetry's own serializers encode as
 * protobuf is read exactly as the same export encoded as JSON — spans with
 * their ids, kinds, attributes and resource; metrics with their instruments,
 * attributes, values and resources. This is what holds
 * harness/otlp-protobuf.ts to the OTLP protos. And each span and metric
 * reports the attributes of the resource it was exported under, as they were
 * sent.
 */
import { SpanKind, context, trace } from '@opentelemetry/api';
import { JsonMetricsSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { kbDid } from '@semiont/core';
import { expect, it } from 'vitest';
import { startOtlp, type OtlpReceiver } from './otlp';

/** A service's resource, naming a knowledge base whose domain holds `%`, `,` and `=`, which a DID passes through intact. */
const SERVICE = { 'service.name': 'otlp-receiver', 'service.version': '0.0.0', 'semiont.kb': kbDid('example.org%3A8443:kb,a=b') };
/** Another, naming no knowledge base. */
const ANOTHER = { 'service.name': 'otlp-receiver-too', 'service.version': '0.0.0' };

/** A reader whose collection the test asks for. */
class Collector extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

async function anExport(attributes: Record<string, string>) {
  const resource = resourceFromAttributes(attributes);
  const finished = new InMemorySpanExporter();
  const tracer = new TracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor({ exporter: finished })] }).getTracer('receiver');
  const parent = tracer.startSpan('bus.dispatch:beckon:focus', { kind: SpanKind.SERVER, attributes: { 'bus.channel': 'beckon:focus', count: 7, ratio: 0.5, flag: true } });
  tracer.startSpan('archivist.content.get', { kind: SpanKind.CLIENT, attributes: { 'peer.service': 'archivist' } }, trace.setSpan(context.active(), parent)).end();
  parent.end();

  const collector = new Collector();
  const meter = new MeterProvider({ resource, readers: [collector] }).getMeter('receiver');
  meter.createCounter('semiont.bus.emit').add(2, { 'bus.channel': 'beckon:focus' });
  meter.createUpDownCounter('semiont.sse.subscribers').add(-1);
  meter.createObservableGauge('semiont.runtime.heap').addCallback((observer) => {
    observer.observe(3.5, { 'heap.stat': 'used' });
    observer.observe(9, { 'heap.stat': 'rss' });
  });
  meter.createHistogram('semiont.inference.duration').record(4, { 'inference.outcome': 'success' });
  const { resourceMetrics } = await collector.collect();
  return { spans: finished.getFinishedSpans(), metrics: resourceMetrics };
}

async function send(receiver: OtlpReceiver, path: string, type: string, body: Uint8Array | undefined): Promise<void> {
  if (!body) throw new Error(`the serializer produced nothing for ${path}`);
  const reply = await fetch(`${receiver.endpoint}${path}`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) });
  expect(reply.status).toBe(200);
}

it('reads a protobuf export as it reads the same export sent as JSON', async () => {
  const { spans, metrics } = await anExport(SERVICE);
  const [asJson, asProtobuf] = [await startOtlp(), await startOtlp()];
  try {
    await send(asJson, '/v1/traces', 'application/json', JsonTraceSerializer.serializeRequest(spans));
    await send(asProtobuf, '/v1/traces', 'application/x-protobuf', ProtobufTraceSerializer.serializeRequest(spans));
    await send(asJson, '/v1/metrics', 'application/json', JsonMetricsSerializer.serializeRequest(metrics));
    await send(asProtobuf, '/v1/metrics', 'application/x-protobuf', ProtobufMetricsSerializer.serializeRequest(metrics));

    expect(asJson.spans.map((s) => s.name).sort()).toEqual(['archivist.content.get', 'bus.dispatch:beckon:focus']);
    expect(asProtobuf.spans).toEqual(asJson.spans);
    expect([...asJson.metrics.keys()].sort()).toEqual(['semiont.bus.emit', 'semiont.inference.duration', 'semiont.runtime.heap', 'semiont.sse.subscribers']);
    expect(asProtobuf.metrics).toEqual(asJson.metrics);
  } finally {
    await asJson.close();
    await asProtobuf.close();
  }
});

it('reports each span and metric with the attributes of the resource it was exported under, and a metric under each resource once', async () => {
  const one = await anExport(SERVICE);
  const another = await anExport(ANOTHER);
  for (const [type, traces, metrics] of [
    ['application/json', JsonTraceSerializer, JsonMetricsSerializer],
    ['application/x-protobuf', ProtobufTraceSerializer, ProtobufMetricsSerializer],
  ] as const) {
    const receiver = await startOtlp();
    try {
      await send(receiver, '/v1/traces', type, traces.serializeRequest(one.spans));
      await send(receiver, '/v1/metrics', type, metrics.serializeRequest(one.metrics));
      await send(receiver, '/v1/metrics', type, metrics.serializeRequest(one.metrics));
      await send(receiver, '/v1/metrics', type, metrics.serializeRequest(another.metrics));

      expect(receiver.spans.length, type).toBe(2);
      for (const span of receiver.spans) expect(span.resource, `${type}: ${span.name}`).toEqual(SERVICE);
      expect(receiver.metrics.size, type).toBe(4);
      for (const [name, metric] of receiver.metrics) expect(metric.resources, `${type}: ${name}`).toEqual([SERVICE, ANOTHER]);
    } finally {
      await receiver.close();
    }
  }
});
