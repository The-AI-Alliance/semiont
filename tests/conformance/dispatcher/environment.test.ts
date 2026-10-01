/**
 * What each variable specs/src/service-environment/variables.json lists for the
 * dispatcher changes, seen from outside. Each case runs a dispatcher world of
 * its own with the environment it is about, and makes the dispatcher answer one
 * request: a `job:status-requested` for a job it does not have. Its service
 * account, SEMIONT_OIDC_CLIENT_ID and SEMIONT_OIDC_CLIENT_SECRET, is
 * boot.test.ts's.
 *
 * A span is told by what it carries rather than by name: its kind, and the
 * channel it is about.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DispatcherEnvironment } from '../harness/dispatcher';
import { DispatcherWorld } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver, type ReceivedSpan } from '../harness/otlp';
import { metricName } from '../harness/spec';

const REQUEST = 'job:status-requested';
const FAILURE = 'job:status-failed';
/** OTLP's span kinds. */
const PRODUCER = 4;
const CONSUMER = 5;

/** A dispatcher world with `env`, exporting to its own receiver. */
async function withDispatcherEnv(
  env: (otlp: OtlpReceiver) => DispatcherEnvironment,
  run: (world: DispatcherWorld, otlp: OtlpReceiver) => Promise<void>,
): Promise<void> {
  const otlp = await startOtlp();
  const world = await DispatcherWorld.create({ env: env(otlp) });
  try {
    await run(world, otlp);
  } finally {
    await world.close();
    await otlp.close();
  }
}

/** Make the dispatcher answer one request. */
async function ask(world: DispatcherWorld): Promise<void> {
  const answer = await (await world.person('environment')).status(`job-${randomUUID().replaceAll('-', '')}`);
  expect(answer.channel).toBe(FAILURE);
}

const about = (channel: string, kind: number) => (span: ReceivedSpan) => span.kind === kind && span.attributes['bus.channel'] === channel;

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the dispatcher's environment", () => {
  it('OTEL_SERVICE_NAME names the service its spans are exported under; semiont-dispatcher when unset', async () => {
    for (const [name, expected] of [[undefined, 'semiont-dispatcher'], ['conformance-renamed', 'conformance-renamed']] as const) {
      await withDispatcherEnv(
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_SERVICE_NAME: name }),
        async (world, otlp) => {
          await ask(world);
          const span = await eventually(`the ${REQUEST} it received`, 10_000, () => otlp.spans.find(about(REQUEST, CONSUMER)));
          expect(span.service).toBe(expected);
        },
      );
    }
  });

  it('with OTEL_EXPORTER_OTLP_ENDPOINT, a reply is sent in the trace of the request it answers', async () => {
    await withDispatcherEnv(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (world, otlp) => {
        await ask(world);
        const received = await eventually(`the ${REQUEST} it received`, 10_000, () => otlp.spans.find(about(REQUEST, CONSUMER)));
        const sent = await eventually(`the ${FAILURE} it sent`, 10_000, () => otlp.spans.find(about(FAILURE, PRODUCER)));
        expect(sent.traceId).toBe(received.traceId);
      },
    );
  });

  it('OTEL_SDK_DISABLED=true exports nothing, though an endpoint is set', async () => {
    await withDispatcherEnv(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_SDK_DISABLED: 'true' }),
      async (world, otlp) => {
        await ask(world);
        await settle(2_000);
        expect(otlp.spans).toEqual([]);
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it("OTEL_CONSOLE_EXPORTER=true, with no endpoint, writes its spans to the dispatcher's output", async () => {
    await withDispatcherEnv(
      () => ({ OTEL_CONSOLE_EXPORTER: 'true', OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (world) => {
        await ask(world);
        await eventually(`a span about ${REQUEST} in the output`, 10_000, () =>
          world.dispatcher.output.some((l) => l.includes(REQUEST) && !l.startsWith('{')) ? true : undefined,
        );
      },
    );
  });

  it('OTEL_METRICS_EXPORTER=console writes metrics to the output, and spans still reach the endpoint', async () => {
    await withDispatcherEnv(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_METRICS_EXPORTER: 'console' }),
      async (world, otlp) => {
        await ask(world);
        await eventually(`the ${REQUEST} it received`, 10_000, () => otlp.spans.find(about(REQUEST, CONSUMER)));
        const started = metricName('semiont.process.start_time');
        await eventually(`${started} in the output`, 10_000, () => (world.dispatcher.output.some((l) => l.includes(started)) ? true : undefined));
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it('OTEL_METRIC_EXPORT_INTERVAL sets how often metrics are exported (30 s when unset)', async () => {
    await withDispatcherEnv(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500' }),
      async (_world, otlp) => {
        await eventually('a metric export within 3 s', 3_000, () => (otlp.metrics.size > 0 ? true : undefined));
      },
    );
  });

  it('OTEL_BSP_SCHEDULE_DELAY sets how long a finished span waits to be exported (5 s when unset)', async () => {
    await withDispatcherEnv(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (world, otlp) => {
        await ask(world);
        await eventually(`the ${REQUEST} it received, within 2 s`, 2_000, () => otlp.spans.find(about(REQUEST, CONSUMER)));
      },
    );
  });

  it('SEMIONT_BUS_LOG writes a line per frame the dispatcher receives and sends; unset, it writes none', async () => {
    for (const on of [false, true]) {
      await withDispatcherEnv(
        () => ({ SEMIONT_BUS_LOG: on ? '1' : undefined }),
        async (world) => {
          await ask(world);
          if (on) {
            for (const line of [`[bus RECV] ${REQUEST}`, `[bus EMIT] ${FAILURE}`]) {
              await eventually(`a ${line} line`, 5_000, () => (world.dispatcher.output.some((l) => l.includes(line)) ? true : undefined));
            }
          } else {
            await settle(500);
            expect(world.dispatcher.output.filter((l) => l.includes('[bus '))).toEqual([]);
          }
        },
      );
    }
  });

  it('SUPERVISE_EVENTS and SUPERVISE_NAME report semiont.process.restarts: the lives the supervisor recorded, less one', async () => {
    const events = join(tmpdir(), `dispatcher-conformance-supervisor-${randomUUID()}.log`);
    const life = (n: number) => `[supervise 2026-09-30T00:00:0${n}Z] starting dispatcher (rapid failures so far: ${n})`;
    writeFileSync(events, [life(0), life(1), life(2)].join('\n') + '\n');
    try {
      await withDispatcherEnv(
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', SUPERVISE_EVENTS: events, SUPERVISE_NAME: 'dispatcher' }),
        async (_world, otlp) => {
          const restarts = metricName('semiont.process.restarts');
          const values = await eventually(restarts, 10_000, () => {
            const seen = otlp.metrics.get(restarts)?.values;
            return seen && seen.length > 0 ? seen : undefined;
          });
          expect(values.at(-1)).toBe(2);
        },
      );
    } finally {
      rmSync(events, { force: true });
    }
  });
});
