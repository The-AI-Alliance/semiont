/**
 * What each variable in specs/src/gateway-environment/variables.json changes,
 * seen from outside, and what the document's logFormat changes. Each case runs
 * a gateway of its own with the environment it is about. JWT_SECRET,
 * SEMIONT_OIDC_CLIENT_ID, SEMIONT_OIDC_CLIENT_SECRET and HOME are boot.test.ts's,
 * and observability.test.ts exports to OTEL_EXPORTER_OTLP_ENDPOINT throughout.
 */
import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GatewayEnvironment, GatewaySettings } from '../harness/gateway';
import { call } from '../harness/http';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, spanName } from '../harness/spec';
import { World } from '../harness/world';

const DISPATCH = spanName('bus.dispatch:{channel}', { channel: 'beckon:focus' });

/** A gateway with `env` (and, when given, changed settings), exporting to its own receiver. */
async function withGateway(
  env: (otlp: OtlpReceiver) => GatewayEnvironment,
  run: (world: World, otlp: OtlpReceiver) => Promise<void>,
  settings?: (s: GatewaySettings) => GatewaySettings,
): Promise<void> {
  const otlp = await startOtlp();
  const world = await World.create('in-process', { env: env(otlp), ...(settings ? { settings } : {}) });
  try {
    await run(world, otlp);
  } finally {
    await world.close();
    await otlp.close();
  }
}

async function emit(world: World): Promise<void> {
  const reply = await world.emit(await world.person('environment'), { channel: 'beckon:focus', payload: {} });
  expect(reply.status).toBe(202);
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the gateway's environment", () => {
  it('OTEL_SERVICE_NAME names the service its spans are exported under; semiont-gateway when unset', async () => {
    for (const [name, expected] of [[undefined, 'semiont-gateway'], ['conformance-renamed', 'conformance-renamed']] as const) {
      await withGateway(
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_SERVICE_NAME: name }),
        async (world, otlp) => {
          await emit(world);
          const span = await eventually(DISPATCH, 10_000, () => otlp.spans.find((s) => s.name === DISPATCH));
          expect(span.service).toBe(expected);
        },
      );
    }
  });

  it('OTEL_SDK_DISABLED=true exports nothing, though an endpoint is set', async () => {
    await withGateway(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_SDK_DISABLED: 'true' }),
      async (world, otlp) => {
        await emit(world);
        await settle(2_000);
        expect(otlp.spans).toEqual([]);
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it('OTEL_CONSOLE_EXPORTER=true, with no endpoint, writes spans to the gateway\'s output', async () => {
    await withGateway(
      () => ({ OTEL_CONSOLE_EXPORTER: 'true', OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (world) => {
        await emit(world);
        await eventually(`${DISPATCH} in the output`, 10_000, () => (world.gateway.output.some((l) => l.includes(DISPATCH)) ? true : undefined));
      },
    );
  });

  it('OTEL_METRICS_EXPORTER=console writes metrics to the output, and spans still reach the endpoint', async () => {
    await withGateway(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_METRICS_EXPORTER: 'console' }),
      async (world, otlp) => {
        await emit(world);
        await eventually(DISPATCH, 10_000, () => otlp.spans.find((s) => s.name === DISPATCH));
        const emits = metricName('semiont.bus.emit');
        await eventually(`${emits} in the output`, 10_000, () => (world.gateway.output.some((l) => l.includes(emits)) ? true : undefined));
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it('OTEL_METRIC_EXPORT_INTERVAL sets how often metrics are exported (30 s when unset)', async () => {
    await withGateway(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500' }),
      async (_world, otlp) => {
        await eventually('a metric export within 3 s', 3_000, () => (otlp.metrics.size > 0 ? true : undefined));
      },
    );
  });

  it('OTEL_BSP_SCHEDULE_DELAY sets how long a finished span waits to be exported (5 s when unset)', async () => {
    await withGateway(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (world, otlp) => {
        await emit(world);
        await eventually(`${DISPATCH} within 2 s`, 2_000, () => otlp.spans.find((s) => s.name === DISPATCH));
      },
    );
  });

  it('SEMIONT_BUS_LOG writes a line per frame the gateway accepts; unset, it writes none', async () => {
    for (const on of [false, true]) {
      await withGateway(
        () => ({ SEMIONT_BUS_LOG: on ? '1' : undefined }),
        async (world) => {
          await emit(world);
          if (on) {
            await eventually('a [bus EMIT] line', 5_000, () => (world.gateway.output.some((l) => l.includes('[bus EMIT] beckon:focus')) ? true : undefined));
          } else {
            await settle(500);
            expect(world.gateway.output.filter((l) => l.includes('[bus '))).toEqual([]);
          }
        },
      );
    }
  });

  it('SUPERVISE_EVENTS and SUPERVISE_NAME report semiont.process.restarts: the lives the supervisor recorded, less one', async () => {
    const events = join(tmpdir(), `gateway-conformance-supervisor-${randomUUID()}.log`);
    const life = (n: number) => `[supervise 2026-09-27T00:00:0${n}Z] starting gateway (rapid failures so far: ${n})`;
    writeFileSync(events, [life(0), life(1), life(2)].join('\n') + '\n');
    try {
      await withGateway(
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', SUPERVISE_EVENTS: events, SUPERVISE_NAME: 'gateway' }),
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

describe("the document's logFormat", () => {
  /** Every line the gateway wrote to stdout, once it has written any. */
  const logLines = (world: World) =>
    eventually('log lines on stdout', 5_000, () => (world.gateway.stdout.length > 0 ? world.gateway.stdout : undefined));

  it('json writes each line as one JSON object, and a line logged during a traced request carries its trace_id and span_id', async () => {
    await withGateway(
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint }),
      async (world) => {
        const traceId = randomUUID().replaceAll('-', '');
        const traceparent = `00-${traceId}-${randomUUID().replaceAll('-', '').slice(0, 16)}-01`;
        const reply = await call(world.origin, 'POST', '/bus/emit', {
          token: await world.person('traced'),
          json: { channel: 'beckon:focus', payload: {} },
          headers: { traceparent },
        });
        expect(reply.status).toBe(202);
        const traced = await eventually(`a line carrying trace ${traceId}`, 5_000, () => world.gateway.stdout.find((l) => l.includes(traceId)));
        expect(JSON.parse(traced)).toMatchObject({ trace_id: traceId, span_id: expect.stringMatching(/^[0-9a-f]{16}$/) });
        for (const line of await logLines(world)) {
          expect(JSON.parse(line), line).toMatchObject({ level: expect.any(String), message: expect.any(String) });
        }
      },
      (s) => ({ ...s, logLevel: 'debug', logFormat: 'json' }),
    );
  });

  it('simple writes <timestamp> [<LEVEL>] <message>', async () => {
    await withGateway(
      () => ({}),
      async (world) => {
        for (const line of await logLines(world)) expect(line).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[[A-Z]+\] /);
      },
      (s) => ({ ...s, logLevel: 'info', logFormat: 'simple' }),
    );
  });
});
