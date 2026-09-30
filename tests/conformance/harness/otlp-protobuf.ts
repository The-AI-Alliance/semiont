/**
 * OTLP/HTTP's protobuf encoding, read into the shape its JSON encoding has, so
 * the receiver reads one shape whichever a gateway sends. Only the fields the
 * receiver reads are transcoded: resources' attributes; spans' ids, name,
 * kind and attributes; metrics' names, and their sums', gauges' and
 * histograms' data points with attributes and values.
 *
 * The field numbers are opentelemetry-proto's (collector/{trace,metrics}/v1,
 * trace/v1, metrics/v1, common/v1, resource/v1). harness/otlp.test.ts holds
 * this to OpenTelemetry's own serializers: the same export, encoded as JSON
 * and as protobuf by @opentelemetry/otlp-transformer, must read the same.
 */

type Json = Record<string, unknown>;

/** One field of a message: its number, and its value by wire type. */
interface Field {
  number: number;
  varint?: bigint;
  bytes?: Uint8Array;
  fixed64?: Uint8Array;
  fixed32?: Uint8Array;
}

function fields(buffer: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    let shift = 0n;
    for (;;) {
      if (at >= buffer.length) throw new Error('protobuf: a varint runs past the end');
      const byte = buffer[at++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7n;
    }
  };
  while (at < buffer.length) {
    const key = varint();
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (wire === 0) out.push({ number, varint: varint() });
    else if (wire === 1) {
      out.push({ number, fixed64: buffer.subarray(at, at + 8) });
      at += 8;
    } else if (wire === 2) {
      const length = Number(varint());
      out.push({ number, bytes: buffer.subarray(at, at + length) });
      at += length;
    } else if (wire === 5) {
      out.push({ number, fixed32: buffer.subarray(at, at + 4) });
      at += 4;
    } else throw new Error(`protobuf: wire type ${wire} is not one OTLP uses`);
    if (at > buffer.length) throw new Error('protobuf: a field runs past the end');
  }
  return out;
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes ?? new Uint8Array());
const hex = (bytes: Uint8Array | undefined) => Buffer.from(bytes ?? []).toString('hex');
const all = (message: Field[], number: number) => message.filter((f) => f.number === number);
const one = (message: Field[], number: number) => message.find((f) => f.number === number);
const double = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
const int64 = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);

/** common/v1 AnyValue, as OTLP/JSON writes it (an int64 as a string). */
function anyValue(bytes: Uint8Array | undefined): Json {
  const message = fields(bytes ?? new Uint8Array());
  const string = one(message, 1);
  if (string) return { stringValue: text(string.bytes) };
  const bool = one(message, 2);
  if (bool) return { boolValue: bool.varint !== 0n };
  const int = one(message, 3);
  if (int) return { intValue: BigInt.asIntN(64, int.varint ?? 0n).toString() };
  const dbl = one(message, 4);
  if (dbl?.fixed64) return { doubleValue: double(dbl.fixed64) };
  return {};
}

/** common/v1 KeyValue: key 1, value 2. */
const attributes = (message: Field[], number: number) =>
  all(message, number).map((kv) => {
    const pair = fields(kv.bytes!);
    return { key: text(one(pair, 1)?.bytes), value: anyValue(one(pair, 2)?.bytes) };
  });

/** resource/v1 Resource: attributes 1. */
const resource = (bytes: Uint8Array | undefined) => ({ attributes: attributes(fields(bytes ?? new Uint8Array()), 1) });

/** trace/v1 Span: trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6, attributes 9. */
function span(bytes: Uint8Array): Json {
  const message = fields(bytes);
  return {
    traceId: hex(one(message, 1)?.bytes),
    spanId: hex(one(message, 2)?.bytes),
    parentSpanId: hex(one(message, 4)?.bytes),
    name: text(one(message, 5)?.bytes),
    kind: Number(one(message, 6)?.varint ?? 0n),
    attributes: attributes(message, 9),
  };
}

/** metrics/v1 NumberDataPoint (as_double 4, as_int 6, attributes 7) or HistogramDataPoint (attributes 9). */
function dataPoint(bytes: Uint8Array, histogram: boolean): Json {
  const message = fields(bytes);
  if (histogram) return { attributes: attributes(message, 9) };
  const asDouble = one(message, 4);
  const asInt = one(message, 6);
  return {
    attributes: attributes(message, 7),
    ...(asDouble?.fixed64 ? { asDouble: double(asDouble.fixed64) } : {}),
    ...(asInt?.fixed64 ? { asInt: int64(asInt.fixed64).toString() } : {}),
  };
}

/** metrics/v1 Metric: name 1; gauge 5, sum 7 (is_monotonic 3), histogram 9 — each with data_points 1. */
function metric(bytes: Uint8Array): Json {
  const message = fields(bytes);
  const out: Json = { name: text(one(message, 1)?.bytes) };
  for (const [number, kind] of [[5, 'gauge'], [7, 'sum'], [9, 'histogram']] as const) {
    const data = one(message, number);
    if (!data) continue;
    const inner = fields(data.bytes!);
    out[kind] = {
      dataPoints: all(inner, 1).map((p) => dataPoint(p.bytes!, kind === 'histogram')),
      ...(kind === 'sum' ? { isMonotonic: one(inner, 3)?.varint === 1n } : {}),
    };
  }
  return out;
}

/** An ExportTraceServiceRequest (resource_spans 1 → resource 1, scope_spans 2 → spans 2), as OTLP/JSON. */
export function traceRequest(bytes: Uint8Array): Json {
  return {
    resourceSpans: all(fields(bytes), 1).map((rs) => {
      const message = fields(rs.bytes!);
      return {
        resource: resource(one(message, 1)?.bytes),
        scopeSpans: all(message, 2).map((ss) => ({ spans: all(fields(ss.bytes!), 2).map((s) => span(s.bytes!)) })),
      };
    }),
  };
}

/** An ExportMetricsServiceRequest (resource_metrics 1 → resource 1, scope_metrics 2 → metrics 2), as OTLP/JSON. */
export function metricsRequest(bytes: Uint8Array): Json {
  return {
    resourceMetrics: all(fields(bytes), 1).map((rm) => {
      const message = fields(rm.bytes!);
      return {
        resource: resource(one(message, 1)?.bytes),
        scopeMetrics: all(message, 2).map((sm) => ({ metrics: all(fields(sm.bytes!), 2).map((m) => metric(m.bytes!)) })),
      };
    }),
  };
}
