/**
 * A service, or an SDK, held to the telemetry the spec lists for it
 * (specs/src/service-telemetry/telemetry.json, specs/src/sdk-telemetry/telemetry.json),
 * from what its OTLP receiver got, in both directions.
 */
import { isDeepStrictEqual } from 'node:util';
import { kbDid } from '@semiont/core';
import { eventually } from './net';
import type { OtlpReceiver } from './otlp';
import { resourceKeys, sdkTelemetry, spanPattern, telemetry, type Telemetry, type TelemetryRow, type TelemetryService } from './spec';

/** OTLP's span kinds, by the names the spec uses. */
export const SPAN_KIND: Record<string, number> = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 };

/** A resource's attributes, as a failing case shows them. */
const shown = (resource: Record<string, unknown>): string => `{${Object.keys(resource).sort().map((key) => `${key}=${String(resource[key])}`).join(', ')}}`;

/**
 * Everything a receiver got, by name, for a failing case to show: each span
 * with its kind, the resources it came under and what its attributes
 * carried, and each metric with its instrument, what its attributes carried
 * and the resources it came under. A bus span's attributes, and an id, show
 * only that they were carried.
 */
export function received(otlp: OtlpReceiver): string {
  const spans = new Map<string, { kind: number; attributes: Set<string>; resources: Set<string> }>();
  for (const span of otlp.spans) {
    const name = span.name.replace(/^(bus\.(?:emit|recv)):.*$/, '$1:{channel}');
    const seen = spans.get(name) ?? { kind: span.kind, attributes: new Set<string>(), resources: new Set<string>() };
    for (const [key, value] of Object.entries(span.attributes)) seen.attributes.add(`${key}=${name.startsWith('bus.') || key.endsWith('.id') ? '…' : String(value)}`);
    seen.resources.add(shown(span.resource));
    spans.set(name, seen);
  }
  const metrics = [...otlp.metrics].map(
    ([name, metric]) =>
      `${name} [${[...metric.instruments].join(',')}] ${[...metric.attributes].map(([key, values]) => `${key}=${key === 'bus.channel' ? '…' : [...values].sort().join('|')}`).join(' ')} resource=${metric.resources.map(shown).join('|')}`,
  );
  return [
    'spans:',
    ...[...spans].map(([name, s]) => `  ${name} kind=${s.kind} resource=${[...s.resources].join('|')} ${[...s.attributes].sort().join(' ')}`),
    'metrics:',
    ...metrics.sort().map((m) => `  ${m}`),
  ].join('\n');
}

/** The rows a service's cases must make it export: always, or by their traffic, on `plane` where rows name planes. */
export function expectedOn(rows: TelemetryRow[], plane?: string): TelemetryRow[] {
  return rows.filter((r) => (r.when === 'export' || r.when === 'traffic') && (!r.planes || (plane !== undefined && r.planes.includes(plane))));
}

/** The resource attribute a service names the knowledge base it serves by. */
const KB = 'semiont.kb';

/**
 * Wait for every row `service` must export to arrive at `otlp`, with every
 * attribute not marked `only`; then return what arrived that the spec does not
 * list for it — a span or metric no row of its names, of another kind, or
 * carrying an attribute or value outside its row; or exported under a
 * resource that carries other keys than the table's `resource` lists for it,
 * or names another knowledge base than `kb`. `kb` is the domain of the
 * knowledge base the case's document handed the service, or null where its
 * document names none; which it is must be what the table says of the
 * service. Judged on everything the receiver got, so run it after the cases
 * that make the traffic.
 */
export async function outsideTheTable(otlp: OtlpReceiver, service: TelemetryService, kb: string | null, plane?: string): Promise<string[]> {
  const keys = resourceKeys(service);
  if (keys.includes(KB) && kb === null) throw new Error(`the table says the ${service} names its knowledge base in its resource (${KB}), and the case handed it none`);
  if (!keys.includes(KB) && kb !== null) throw new Error(`the case handed the ${service} the knowledge base ${kb}, and the table says its resource names none`);
  const unlisted = await heldTo(otlp, telemetry(service), `the ${service}`, plane, true);

  const resources: Array<{ resource: Record<string, unknown>; spans: number; metrics: number }> = [];
  const under = (resource: Record<string, unknown>) => {
    const known = resources.find((r) => isDeepStrictEqual(r.resource, resource));
    if (known) return known;
    const seen = { resource, spans: 0, metrics: 0 };
    resources.push(seen);
    return seen;
  };
  for (const span of otlp.spans) under(span.resource).spans += 1;
  for (const metric of otlp.metrics.values()) for (const resource of metric.resources) under(resource).metrics += 1;
  for (const { resource, spans, metrics } of resources) {
    const what = `the resource ${shown(resource)}, of ${spans} spans and ${metrics} metrics,`;
    for (const key of Object.keys(resource)) if (!keys.includes(key)) unlisted.push(`${what} carries ${key}, which the spec does not list for the ${service}`);
    for (const key of keys) if (!(key in resource)) unlisted.push(`${what} does not carry ${key}, which the spec lists for the ${service}`);
    if (kb !== null && KB in resource && resource[KB] !== kbDid(kb)) unlisted.push(`${what} names the knowledge base ${String(resource[KB])}, not ${kbDid(kb)}`);
  }
  return unlisted;
}

/**
 * The same for an SDK, from what its driver exported, against
 * specs/src/sdk-telemetry/telemetry.json — with one difference. A service is
 * its whole process, so anything it exports that no row names is a finding. A
 * driver's process is the SDK and whatever else the driver runs, so what no
 * row names is not the SDK's to answer for; what arrives under a row's name is.
 * A driver that uses one `transport` alone is held to that transport's rows.
 */
export function outsideTheSdkTable(otlp: OtlpReceiver, transport?: string): Promise<string[]> {
  return heldTo(otlp, sdkTelemetry(transport), 'an SDK', undefined, false);
}

async function heldTo(otlp: OtlpReceiver, { spans, metrics }: Telemetry, who: string, plane: string | undefined, whole: boolean): Promise<string[]> {
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
      if (whole) unlisted.push(`a span ${span.name}, which the spec does not list for ${who}`);
      continue;
    }
    if (span.kind !== SPAN_KIND[row.kind]) unlisted.push(`${span.name} is of kind ${span.kind}, not ${row.kind}`);
    outside(span.name, row, new Map(Object.entries(span.attributes).map(([k, v]) => [k, new Set([String(v)])])));
  }
  for (const [name, metric] of otlp.metrics) {
    const row = metrics.find((r) => r.name === name);
    if (!row) {
      if (whole) unlisted.push(`a metric ${name}, which the spec does not list for ${who}`);
      continue;
    }
    for (const instrument of metric.instruments) if (instrument !== row.kind) unlisted.push(`${name} arrived as a ${instrument}, not a ${row.kind}`);
    outside(name, row, metric.attributes);
  }
  return [...new Set(unlisted)];
}
