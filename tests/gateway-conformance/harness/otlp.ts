/**
 * An OTLP/HTTP receiver: collects the spans a gateway exports as JSON, and
 * each metric's name with the attribute keys and values its data points carried, so a
 * case can check the names the observability contract
 * (docs/system/administration/OBSERVABILITY.md) promises.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedSpan {
  name: string;
  kind: number;
  service: string | undefined;
  attributes: Record<string, unknown>;
  traceId: string;
  parentSpanId: string | undefined;
}

export interface OtlpReceiver {
  readonly endpoint: string;
  readonly spans: ReceivedSpan[];
  /** Metric name → every attribute key seen on its data points. */
  readonly metrics: Map<string, Set<string>>;
  /** Metric name → every value its sum and gauge data points carried, in arrival order. */
  readonly values: Map<string, number[]>;
  close(): Promise<void>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** OTLP's AnyValue, reduced to the scalar it carries. */
function valueOf(v: unknown): unknown {
  if (!isObject(v)) return undefined;
  return v['stringValue'] ?? v['intValue'] ?? v['boolValue'] ?? v['doubleValue'];
}

function attributes(kvs: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of list(kvs)) if (isObject(kv) && typeof kv['key'] === 'string') out[kv['key']] = valueOf(kv['value']);
  return out;
}

export async function startOtlp(): Promise<OtlpReceiver> {
  const spans: ReceivedSpan[] = [];
  const metrics = new Map<string, Set<string>>();
  const values = new Map<string, number[]>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
                const keys = metrics.get(name) ?? new Set<string>();
                metrics.set(name, keys);
                for (const kind of ['sum', 'gauge', 'histogram']) {
                  const data = m[kind];
                  if (!isObject(data)) continue;
                  for (const point of list(data['dataPoints'])) {
                    if (!isObject(point)) continue;
                    for (const key of Object.keys(attributes(point['attributes']))) keys.add(key);
                    // OTLP/JSON carries an int64 as a string.
                    const value = Number(point['asInt'] ?? point['asDouble']);
                    if (kind !== 'histogram' && Number.isFinite(value)) values.set(name, [...(values.get(name) ?? []), value]);
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
    values,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
