/**
 * The receiver itself: an export OpenTelemetry's own serializers encode as
 * protobuf is read exactly as the same export encoded as JSON — spans with
 * their ids, kinds and attributes; metrics with their instruments, attributes
 * and values. This is what holds harness/otlp-protobuf.ts to the OTLP protos.
 */
import { SpanKind, context, trace } from '@opentelemetry/api';
import { JsonMetricsSerializer, JsonTraceSerializer, ProtobufMetricsSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { expect, it } from 'vitest';
import { startOtlp, type OtlpReceiver } from './otlp';

/** A reader whose collection the test asks for. */
class Collector extends MetricReader {
  protected async onShutdown(): Promise<void> {}
  protected async onForceFlush(): Promise<void> {}
}

async function anExport() {
  const resource = resourceFromAttributes({ 'service.name': 'otlp-receiver' });
  const finished = new InMemorySpanExporter();
  const tracer = new BasicTracerProvider({ resource, spanProcessors: [new SimpleSpanProcessor(finished)] }).getTracer('receiver');
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
  meter.createHistogram('semiont.handler.duration').record(4, { actor: 'a' });
  const { resourceMetrics } = await collector.collect();
  return { spans: finished.getFinishedSpans(), metrics: resourceMetrics };
}

async function send(receiver: OtlpReceiver, path: string, type: string, body: Uint8Array | undefined): Promise<void> {
  if (!body) throw new Error(`the serializer produced nothing for ${path}`);
  const reply = await fetch(`${receiver.endpoint}${path}`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) });
  expect(reply.status).toBe(200);
}

it('reads a protobuf export as it reads the same export sent as JSON', async () => {
  const { spans, metrics } = await anExport();
  const [asJson, asProtobuf] = [await startOtlp(), await startOtlp()];
  try {
    await send(asJson, '/v1/traces', 'application/json', JsonTraceSerializer.serializeRequest(spans));
    await send(asProtobuf, '/v1/traces', 'application/x-protobuf', ProtobufTraceSerializer.serializeRequest(spans));
    await send(asJson, '/v1/metrics', 'application/json', JsonMetricsSerializer.serializeRequest(metrics));
    await send(asProtobuf, '/v1/metrics', 'application/x-protobuf', ProtobufMetricsSerializer.serializeRequest(metrics));

    expect(asJson.spans.map((s) => s.name).sort()).toEqual(['archivist.content.get', 'bus.dispatch:beckon:focus']);
    expect(asProtobuf.spans).toEqual(asJson.spans);
    expect([...asJson.metrics.keys()].sort()).toEqual(['semiont.bus.emit', 'semiont.handler.duration', 'semiont.runtime.heap', 'semiont.sse.subscribers']);
    expect(asProtobuf.metrics).toEqual(asJson.metrics);
  } finally {
    await asJson.close();
    await asProtobuf.close();
  }
});
