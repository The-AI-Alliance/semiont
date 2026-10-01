/**
 * A service held to the telemetry specs/src/service-telemetry/telemetry.json
 * lists for it, from what its OTLP receiver got, in both directions.
 */
import { eventually } from './net';
import type { OtlpReceiver } from './otlp';
import { spanPattern, telemetry, type Service, type TelemetryRow } from './spec';

/** OTLP's span kinds, by the names the spec uses. */
export const SPAN_KIND: Record<string, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };

/** The rows a service's cases must make it export: always, or by their traffic, on `plane` where rows name planes. */
export function expectedOn(rows: TelemetryRow[], plane?: string): TelemetryRow[] {
  return rows.filter((r) => (r.when === 'export' || r.when === 'traffic') && (!r.planes || (plane !== undefined && r.planes.includes(plane))));
}

/**
 * Wait for every row `service` must export to arrive at `otlp`, with every
 * attribute not marked `only`; then return what arrived that the spec does not
 * list for it — a span or metric no row of its names, of another kind, or
 * carrying an attribute or value outside its row. Judged on everything the
 * receiver got, so run it after the cases that make the traffic.
 */
export async function outsideTheTable(otlp: OtlpReceiver, service: Service, plane?: string): Promise<string[]> {
  const { spans, metrics } = telemetry(service);
  for (const row of expectedOn(spans, plane)) {
    const pattern = spanPattern(row);
    await eventually(`a ${row.name} span`, 15_000, () => otlp.spans.find((s) => pattern.test(s.name)));
    for (const attribute of row.attributes.filter((a) => !a.only)) {
      await eventually(`a ${row.name} span carrying ${attribute.key}`, 15_000, () =>
        otlp.spans.find((s) => pattern.test(s.name) && attribute.key in s.attributes),
      );
    }
  }
  for (const row of expectedOn(metrics, plane)) {
    const seen = await eventually(`the ${row.name} metric`, 15_000, () => otlp.metrics.get(row.name));
    for (const attribute of row.attributes.filter((a) => !a.only)) {
      await eventually(`${row.name} carrying ${attribute.key}`, 15_000, () => (seen.attributes.has(attribute.key) ? true : undefined));
    }
  }

  const unlisted: string[] = [];
  const outside = (what: string, row: TelemetryRow, attributes: Map<string, Set<string>>) => {
    for (const [key, values] of attributes) {
      const listed = row.attributes.find((a) => a.key === key);
      if (!listed) unlisted.push(`${what} carries ${key}, which the spec does not list`);
      else if (listed.values) for (const v of values) if (!listed.values.includes(v)) unlisted.push(`${what} carries ${key}=${v}, outside ${listed.values.join(', ')}`);
    }
  };
  for (const span of otlp.spans) {
    const row = spans.find((r) => spanPattern(r).test(span.name));
    if (!row) {
      unlisted.push(`a span ${span.name}, which the spec does not list for the ${service}`);
      continue;
    }
    if (span.kind !== SPAN_KIND[row.kind]) unlisted.push(`${span.name} is of kind ${span.kind}, not ${row.kind}`);
    outside(span.name, row, new Map(Object.entries(span.attributes).map(([k, v]) => [k, new Set([String(v)])])));
  }
  for (const [name, metric] of otlp.metrics) {
    const row = metrics.find((r) => r.name === name);
    if (!row) {
      unlisted.push(`a metric ${name}, which the spec does not list for the ${service}`);
      continue;
    }
    for (const instrument of metric.instruments) if (instrument !== row.kind) unlisted.push(`${name} arrived as a ${instrument}, not a ${row.kind}`);
    outside(name, row, metric.attributes);
  }
  return [...new Set(unlisted)];
}
