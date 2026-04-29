/**
 * Jaeger evidence capture for e2e tests.
 *
 * Companion to the `bus` fixture. Where `bus` captures `[bus OP]` lines
 * from the frontend's console (Tier 1 grep timeline), this fixture
 * pulls the corresponding **distributed spans** from Jaeger (Tier 2)
 * and attaches them to the Playwright report — so a failing test's
 * artifact bundle includes the cross-process trace tree.
 *
 * The bus log emits `trace=<first8>` — the first 8 hex of the W3C
 * trace-id. Jaeger's query API doesn't accept prefixes, so we query by
 * service + time window and filter results by the captured prefixes.
 *
 * Configuration via env vars (with sensible defaults):
 *   - `JAEGER_QUERY_URL`  — Jaeger UI/Query base URL.
 *                           Default: `http://192.168.64.16:16686`
 *   - `JAEGER_SERVICES`   — Comma-separated services to query.
 *                           Default: `semiont-backend,semiont-worker,semiont-smelter,semiont-frontend`
 *   - `JAEGER_ATTACH`     — `failure` (default), `always`, or `off`.
 *                           Controls when the fixture attaches spans
 *                           to the Playwright report.
 *
 * Limitations:
 *   - Frontend doesn't currently emit OTel spans by default — the
 *     captured trace prefixes are mostly backend-originated. The
 *     fixture still queries the frontend service in case it's added
 *     later.
 *   - Trace-id prefixes have a small chance of collision (8 hex = 32
 *     bits, so within a single test window collisions are unlikely
 *     but not impossible). We surface every trace whose ID starts
 *     with one of the captured prefixes; false positives are cheap
 *     diagnostic noise, not silent failures.
 */

import { promises as fs } from 'fs';
import type { TestInfo } from '@playwright/test';
import type { BusLogCapture } from './bus-log';

const JAEGER_QUERY_URL = process.env.JAEGER_QUERY_URL ?? 'http://192.168.64.16:16686';

const JAEGER_SERVICES = (
  process.env.JAEGER_SERVICES ??
  'semiont-backend,semiont-worker,semiont-smelter,semiont-frontend'
).split(',').map((s) => s.trim()).filter(Boolean);

type AttachMode = 'failure' | 'always' | 'off';
const JAEGER_ATTACH: AttachMode =
  (process.env.JAEGER_ATTACH as AttachMode) ?? 'failure';

interface JaegerSpan {
  traceID: string;
  spanID: string;
  operationName: string;
  startTime: number;
  duration: number;
  references?: { refType: string; traceID: string; spanID: string }[];
  tags?: { key: string; type: string; value: unknown }[];
  process?: { serviceName: string };
}

interface JaegerTrace {
  traceID: string;
  spans: JaegerSpan[];
  processes: Record<string, { serviceName: string }>;
}

interface JaegerTracesResponse {
  data: JaegerTrace[];
}

/** Captured at test entry; queried on teardown. */
export class JaegerCapture {
  readonly startedAtMs: number;

  constructor() {
    this.startedAtMs = Date.now();
  }
}

/**
 * Fetch traces for one service in the [start, end] window.
 *
 * Jaeger's `/api/traces` endpoint takes microsecond timestamps and a
 * `lookback` it ignores when both `start` and `end` are present. We
 * cap the result with a generous limit; tests rarely produce more than
 * a few dozen traces.
 */
async function fetchTracesForService(
  service: string,
  startUs: number,
  endUs: number,
): Promise<JaegerTrace[]> {
  const url = new URL(`${JAEGER_QUERY_URL}/api/traces`);
  url.searchParams.set('service', service);
  url.searchParams.set('start', String(startUs));
  url.searchParams.set('end', String(endUs));
  url.searchParams.set('limit', '500');
  // Jaeger's API requires a lookback parameter even when start/end are set.
  url.searchParams.set('lookback', 'custom');

  const response = await fetch(url.toString()).catch(() => null);
  if (!response || !response.ok) return [];
  const body = (await response.json().catch(() => null)) as JaegerTracesResponse | null;
  return body?.data ?? [];
}

/** Filter traces whose ID starts with any of the captured prefixes. */
function filterByPrefix(traces: JaegerTrace[], prefixes: Set<string>): JaegerTrace[] {
  if (prefixes.size === 0) return [];
  return traces.filter((t) => {
    const p8 = t.traceID.slice(0, 8);
    return prefixes.has(p8);
  });
}

/**
 * Build the per-test evidence package: traces from every configured
 * service in the test's time window, with prefix-matching to the bus
 * log when the frontend exports OTel spans.
 *
 * Two captures, ordered by relevance:
 *
 *   - **matched** — traces whose ID prefix-matches a `[bus … trace=…]`
 *     line the frontend emitted. Tightest correlation; empty when the
 *     frontend doesn't have an OTel SDK initialized.
 *   - **window** — every trace from every service that overlapped the
 *     test's time window. Always populated (when Jaeger has data).
 *     Useful when the frontend isn't OTel-instrumented and we still
 *     want the cross-service span tree for the test.
 */
async function gatherEvidence(
  bus: BusLogCapture,
  startedAtMs: number,
): Promise<{
  prefixesSeen: string[];
  servicesQueried: string[];
  matched: { service: string; traces: JaegerTrace[] }[];
  window: { service: string; traces: JaegerTrace[] }[];
  unmatchedPrefixes: string[];
}> {
  const prefixes = new Set<string>();
  for (const e of bus.entries) {
    if (e.trace) prefixes.add(e.trace);
  }
  // Pad the time window: bus events captured *before* the spans' OTel
  // export pipeline flushes them. Add 5s of slack on each side.
  const startUs = (startedAtMs - 5_000) * 1000;
  const endUs = (Date.now() + 5_000) * 1000;

  const results = await Promise.all(
    JAEGER_SERVICES.map(async (service) => {
      const all = await fetchTracesForService(service, startUs, endUs);
      const matched = filterByPrefix(all, prefixes);
      return { service, all, matched };
    }),
  );

  const matched = results
    .map(({ service, matched }) => ({ service, traces: matched }))
    .filter((r) => r.traces.length > 0);
  const window = results
    .map(({ service, all }) => ({ service, traces: all }))
    .filter((r) => r.traces.length > 0);

  const matchedPrefixes = new Set<string>();
  for (const { traces } of matched) {
    for (const t of traces) matchedPrefixes.add(t.traceID.slice(0, 8));
  }
  const unmatchedPrefixes = [...prefixes].filter((p) => !matchedPrefixes.has(p));

  return {
    prefixesSeen: [...prefixes],
    servicesQueried: JAEGER_SERVICES,
    matched,
    window,
    unmatchedPrefixes,
  };
}

/**
 * Attach Jaeger evidence to the Playwright test report if appropriate.
 * Called from the fixture's teardown.
 */
export async function attachJaegerEvidence(
  testInfo: TestInfo,
  bus: BusLogCapture,
  jaeger: JaegerCapture,
): Promise<void> {
  if (JAEGER_ATTACH === 'off') return;
  const failed = testInfo.status !== testInfo.expectedStatus;
  if (JAEGER_ATTACH === 'failure' && !failed) return;

  const evidence = await gatherEvidence(bus, jaeger.startedAtMs);
  const endedAtMs = Date.now();
  const matchedCount = evidence.matched.reduce((n, m) => n + m.traces.length, 0);
  const windowCount = evidence.window.reduce((n, m) => n + m.traces.length, 0);
  const summary = {
    test: testInfo.title,
    status: testInfo.status,
    // Absolute ISO timestamps so a host-side post-process (e.g.
    // `tests/e2e/scripts/slice-container-logs.mjs`) can slice container
    // logs to the precise test window without re-deriving from the
    // Playwright report.
    startedAtIso: new Date(jaeger.startedAtMs).toISOString(),
    endedAtIso: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - jaeger.startedAtMs,
    jaegerQueryUrl: JAEGER_QUERY_URL,
    prefixesSeen: evidence.prefixesSeen,
    servicesQueried: evidence.servicesQueried,
    matchedTraceCount: matchedCount,
    windowTraceCount: windowCount,
    unmatchedPrefixes: evidence.unmatchedPrefixes,
  };

  // Write through `testInfo.outputPath` and attach by `path` (rather
  // than `body`). Playwright's HTML reporter is more reliable about
  // surfacing path-attached files than body-attached strings — body
  // attachments from fixture teardowns sometimes don't make it into
  // the report's attachment list.
  await writeAttachment(testInfo, 'jaeger-summary.json', JSON.stringify(summary, null, 2));

  // Prefer matched (tightest correlation) when available; fall back to
  // the full time-window capture so the developer always gets a usable
  // span tree even when the frontend isn't OTel-instrumented.
  const traces = evidence.matched.length > 0 ? evidence.matched : evidence.window;
  if (traces.length === 0) return;

  const filenameStem = evidence.matched.length > 0 ? 'jaeger-matched-traces' : 'jaeger-window-traces';
  await writeAttachment(
    testInfo,
    `${filenameStem}.json`,
    JSON.stringify(traces, null, 2),
  );

  const traceLinks = traces
    .flatMap((m) => m.traces.map((t) => `${JAEGER_QUERY_URL}/trace/${t.traceID}`))
    .join('\n');
  await writeAttachment(testInfo, 'jaeger-trace-links.txt', traceLinks);
}

async function writeAttachment(testInfo: TestInfo, name: string, body: string): Promise<void> {
  const filePath = testInfo.outputPath(name);
  try {
    await fs.writeFile(filePath, body, 'utf8');
    const contentType = name.endsWith('.json') ? 'application/json' : 'text/plain';
    await testInfo.attach(name, { path: filePath, contentType });
  } catch (err) {
    // Surface the failure so a missing artifact is visible without
    // silently swallowing the cause. Don't rethrow — losing evidence
    // shouldn't fail an otherwise-passing test.
    // eslint-disable-next-line no-console
    console.error(`[jaeger-fixture] attach ${name} failed:`, err);
  }
}
