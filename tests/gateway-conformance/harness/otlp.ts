/**
 * An OTLP/HTTP receiver: collects the spans a gateway exports, and for each
 * metric the instrument it arrived as and the attributes and values its data
 * points carried, so a case can hold the gateway to the telemetry the spec
 * lists (specs/src/gateway-telemetry/telemetry.json). It reads either
 * encoding OTLP/HTTP has, by `Content-Type`, as a collector does.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { metricsRequest, traceRequest } from './otlp-protobuf';

export interface ReceivedSpan {
  name: string;
  kind: number;
  service: string | undefined;
  attributes: Record<string, unknown>;
  traceId: string;
  parentSpanId: string | undefined;
}

export interface ReceivedMetric {
  /** What its data points came as: `counter` (a monotonic sum), `up-down counter`, `gauge`, `histogram`. */
  readonly instruments: Set<string>;
  /** Attribute key → every value it carried. */
  readonly attributes: Map<string, Set<string>>;
  /** Every value its sum and gauge data points carried, in arrival order. */
  readonly values: number[];
}

export interface OtlpReceiver {
  readonly endpoint: string;
  readonly spans: ReceivedSpan[];
  readonly metrics: Map<string, ReceivedMetric>;
  close(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** OTLP's AnyValue, reduced to the scalar it carries; an int64, which JSON may carry as a string, as a number. */
function valueOf(v: unknown): unknown {
  if (!isObject(v)) return undefined;
  if (v['intValue'] !== undefined) return Number(v['intValue']);
  return v['stringValue'] ?? v['boolValue'] ?? v['doubleValue'];
}

function attributes(kvs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list(kvs)) if (isObject(kv) && typeof kv['key'] === 'string') out[kv['key']] = valueOf(kv['value']);
  return out;
}

export async function startOtlp(): Promise<OtlpReceiver> {
  const spans: ReceivedSpan[] = [];
  const metrics = new Map<string, ReceivedMetric>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const bytes = Buffer.concat(chunks);
        const protobuf = (req.headers['content-type'] ?? '').split(';')[0]!.trim() === 'application/x-protobuf';
        const body: unknown = !protobuf
          ? JSON.parse(bytes.toString('utf8'))
          : req.url === '/v1/traces'
            ? traceRequest(bytes)
            : metricsRequest(bytes);
        if (!isObject(body)) throw new Error('not an OTLP body');
        if (req.url === '/v1/traces') {
          for (const rs of list(body['resourceSpans'])) {
            if (!isObject(rs)) continue;
            const resource = rs['resource'];
            const service = str(attributes(isObject(resource) ? resource['attributes'] : undefined)['service.name']);
            for (const ss of list(rs['scopeSpans'])) {
              if (!isObject(ss)) continue;
              for (const span of list(ss['spans'])) {
                if (!isObject(span)) continue;
                spans.push({
                  name: str(span['name']) ?? '',
                  kind: typeof span['kind'] === 'number' ? span['kind'] : 0,
                  service,
                  attributes: attributes(span['attributes']),
                  traceId: str(span['traceId']) ?? '',
                  parentSpanId: str(span['parentSpanId']) || undefined,
                });
              }
            }
          }
        } else if (req.url === '/v1/metrics') {
          for (const rm of list(body['resourceMetrics'])) {
            if (!isObject(rm)) continue;
            for (const sm of list(rm['scopeMetrics'])) {
              if (!isObject(sm)) continue;
              for (const m of list(sm['metrics'])) {
                const name = isObject(m) ? str(m['name']) : undefined;
                if (!isObject(m) || !name) continue;
                const metric: ReceivedMetric = metrics.get(name) ?? { instruments: new Set<string>(), attributes: new Map<string, Set<string>>(), values: [] };
                metrics.set(name, metric);
                for (const kind of ['sum', 'gauge', 'histogram']) {
                  const data = m[kind];
                  if (!isObject(data)) continue;
                  metric.instruments.add(kind === 'sum' ? (data['isMonotonic'] === true ? 'counter' : 'up-down counter') : kind);
                  for (const point of list(data['dataPoints'])) {
                    if (!isObject(point)) continue;
                    for (const [key, value] of Object.entries(attributes(point['attributes']))) {
                      const seen = metric.attributes.get(key) ?? new Set<string>();
                      metric.attributes.set(key, seen.add(String(value)));
                    }
                    // OTLP/JSON carries an int64 as a string.
                    const value = Number(point['asInt'] ?? point['asDouble']);
                    if (kind !== 'histogram' && Number.isFinite(value)) metric.values.push(value);
                  }
                }
              }
            }
          }
        }
      } catch {
        // A body the receiver cannot read is reported by the case that finds nothing.
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    spans,
    metrics,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
