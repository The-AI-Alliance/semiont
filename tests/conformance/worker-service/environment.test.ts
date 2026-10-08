/**
 * What a Worker service reads from its environment beside its service
 * account and its providers' keys (WORKER-SERVICE.md § Environment), each
 * variable by name: what the service does with it, and without it. Each case
 * starts a worker with the environment it is about, exporting to a receiver
 * of its own. A worker claims as soon as it has started, so most cases need
 * no job: the claim it sends, and the answer that nothing is pending, are the
 * frames they look for.
 *
 * A span is told by what it carries rather than by name: its kind, and the
 * channel it is about.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { marks } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver, type ReceivedSpan } from '../harness/otlp';
import { REPO_ROOT } from '../harness/paths';
import { metricName } from '../harness/spec';
import { SPAN_KIND } from '../harness/telemetry';
import { READ_FROM_THE_ENVIRONMENT, type WorkerEnvironment } from '../harness/worker-service-process';
import { eachWorkerService, type Served, type WorkerServiceWorld } from '../harness/worker-service-world';
import { markJob, settled } from './support';

const CLAIM = 'job:claim';
const NOTHING_PENDING = 'job:claim-failed';
const QUEUED = 'job:queued';

const about = (channel: string, kind: number | undefined) => (span: ReceivedSpan) => span.kind === kind && span.attributes['bus.channel'] === channel;
const sent = (channel: string) => about(channel, SPAN_KIND['producer']);
const got = (channel: string) => about(channel, SPAN_KIND['consumer']);

/** How long a case waits before it says a thing did not happen: several of the export intervals it set. */
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A worker with `env`, exporting to a receiver of its own, once it has claimed and been told nothing is pending. */
async function withEnv(
  w: WorkerServiceWorld,
  env: (otlp: OtlpReceiver) => WorkerEnvironment,
  run: (served: Served, otlp: OtlpReceiver) => Promise<void>,
  more: Parameters<WorkerServiceWorld['start']>[0] = {},
): Promise<void> {
  const otlp = await startOtlp();
  try {
    const served = await w.start({ ...more, env: env(otlp) });
    await served.emitted(CLAIM);
    await run(served, otlp);
    // The worker is stopped before its receiver is: an export that finds no receiver is retried, and holds the next case up.
    await served.process.stop();
  } finally {
    await otlp.close();
  }
}

eachWorkerService("the worker's environment", (world) => {
  it('WORKER-SERVICE.md § Environment names every variable the suite starts a worker with, and no other', () => {
    const document = readFileSync(join(REPO_ROOT, 'docs/protocol/WORKER-SERVICE.md'), 'utf8');
    const section = /\n## Environment\n([\s\S]*?)\n## /.exec(document)?.[1] ?? '';
    const named = new Set([...section.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1]!));
    // LOG_LEVEL and LOG_FORMAT are named there as the two it does not read.
    expect([...named].sort()).toEqual([...READ_FROM_THE_ENVIRONMENT, 'LOG_LEVEL', 'LOG_FORMAT'].sort());
  });

  it('OTEL_SERVICE_NAME names the service its spans are exported under; semiont-worker when unset', async () => {
    for (const [name, expected] of [[undefined, 'semiont-worker'], ['conformance-renamed', 'conformance-renamed']] as const) {
      await withEnv(
        world(),
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_SERVICE_NAME: name }),
        async (_served, otlp) => {
          const span = await eventually(`the ${CLAIM} it sent`, 10_000, () => otlp.spans.find(sent(CLAIM)));
          expect(span.service).toBe(expected);
        },
      );
    }
  });

  it('with OTEL_EXPORTER_OTLP_ENDPOINT, every message a job sends is in the trace of the job\'s span', async () => {
    const w = world();
    const job = markJob(w, 'traced', { motivation: 'highlighting' });
    w.ollama.script({ response: JSON.stringify([{ exact: 'the first program' }]) });
    await withEnv(
      w,
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (served, otlp) => {
        await settled(served, job);
        const held = await eventually("the job's span", 10_000, () => otlp.spans.find((s) => s.attributes['job.id'] === job.metadata.id));
        // The job sends one of each of these, and nothing else on their channels.
        for (const channel of ['job:start', 'browse:resource-requested', 'mark:commit', 'job:checkpoint', 'job:complete']) {
          const span = await eventually(`the ${channel} it sent`, 10_000, () => otlp.spans.find(sent(channel)));
          expect(span.traceId, channel).toBe(held.traceId);
        }
      },
    );
  });

  it('without OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_CONSOLE_EXPORTER, exports nothing and writes no span or metric', async () => {
    await withEnv(
      world(),
      () => ({ OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500' }),
      async (served, otlp) => {
        await settle(2_000);
        expect(otlp.spans).toEqual([]);
        expect([...otlp.metrics.keys()]).toEqual([]);
        expect(served.process.output.filter((line) => line.includes(CLAIM) || line.includes('semiont.process.start_time'))).toEqual([]);
      },
    );
  });

  it('OTEL_SDK_DISABLED=true exports nothing, though an endpoint is set', async () => {
    await withEnv(
      world(),
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_SDK_DISABLED: 'true' }),
      async (_served, otlp) => {
        await settle(2_000);
        expect(otlp.spans).toEqual([]);
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it("OTEL_CONSOLE_EXPORTER=true, with no endpoint, writes its spans to the worker's output", async () => {
    await withEnv(
      world(),
      () => ({ OTEL_CONSOLE_EXPORTER: 'true', OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (served) => {
        await eventually(`a span about ${CLAIM} in the output`, 10_000, () => (served.process.output.some((line) => line.includes(CLAIM) && !line.startsWith('{')) ? true : undefined));
      },
    );
  });

  it('OTEL_METRICS_EXPORTER=console writes metrics to the output, and spans still reach the endpoint', async () => {
    await withEnv(
      world(),
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100', OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_METRICS_EXPORTER: 'console' }),
      async (served, otlp) => {
        await eventually(`the ${CLAIM} it sent`, 10_000, () => otlp.spans.find(sent(CLAIM)));
        const started = metricName('semiont.process.start_time');
        await eventually(`${started} in the output`, 10_000, () => (served.process.output.some((line) => line.includes(started)) ? true : undefined));
        expect([...otlp.metrics.keys()]).toEqual([]);
      },
    );
  });

  it('OTEL_METRIC_EXPORT_INTERVAL sets how often metrics are exported (30 s when unset)', async () => {
    await withEnv(
      world(),
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500' }),
      async (_served, otlp) => {
        await eventually('a metric export within 3 s', 3_000, () => (otlp.metrics.size > 0 ? true : undefined));
      },
    );
  });

  it('OTEL_BSP_SCHEDULE_DELAY sets how long a finished span waits to be exported (5 s when unset)', async () => {
    const w = world();
    await withEnv(
      w,
      (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_BSP_SCHEDULE_DELAY: '100' }),
      async (_served, otlp) => {
        // An announcement the worker hears and does not claim: its filters do not take the job.
        const unclaimed = w.queued('job-ws-environment-unclaimed', 'mark', { resourceId: 'res-ws-environment-unclaimed', motivation: 'assessing' });
        await w.announce(unclaimed);
        await eventually(`the ${QUEUED} it received, within 2 s`, 2_000, () => otlp.spans.find(got(QUEUED)));
      },
      { agents: [w.entry(w.agents[0]!, [marks('highlighting')])] },
    );
  });

  it('SEMIONT_BUS_LOG writes a line for each frame the worker sends and receives; unset, it writes none', async () => {
    for (const on of [false, true]) {
      await withEnv(
        world(),
        () => ({ SEMIONT_BUS_LOG: on ? '1' : undefined }),
        async (served) => {
          if (on) {
            for (const line of [`[bus EMIT] ${CLAIM}`, `[bus RECV] ${NOTHING_PENDING}`]) {
              await eventually(`a ${line} line`, 5_000, () => (served.process.output.some((l) => l.includes(line)) ? true : undefined));
            }
          } else {
            await settle(500);
            expect(served.process.output.filter((l) => l.includes('[bus '))).toEqual([]);
          }
        },
      );
    }
  });

  it('SUPERVISE_EVENTS and SUPERVISE_NAME report semiont.process.restarts: the lives the supervisor recorded, less one', async () => {
    const events = join(tmpdir(), `worker-conformance-supervisor-${randomUUID()}.log`);
    const life = (n: number) => `[supervise 2026-09-30T00:00:0${n}Z] starting worker (rapid failures so far: ${n})`;
    writeFileSync(events, [life(0), life(1), life(2)].join('\n') + '\n');
    try {
      await withEnv(
        world(),
        (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', SUPERVISE_EVENTS: events, SUPERVISE_NAME: 'worker' }),
        async (_served, otlp) => {
          const restarts = metricName('semiont.process.restarts');
          const values = await eventually(restarts, 10_000, () => {
            const seen = otlp.metrics.get(restarts)?.values;
            return seen && seen.length > 0 ? seen : undefined;
          });
          expect(values.at(-1)).toBe(2);
          expect([...otlp.metrics.get(restarts)!.instruments]).toEqual(['gauge']);
        },
      );
      // With one of the two and not the other, the metric does not exist.
      for (const half of [{ SUPERVISE_EVENTS: events }, { SUPERVISE_NAME: 'worker' }]) {
        await withEnv(
          world(),
          (otlp) => ({ OTEL_EXPORTER_OTLP_ENDPOINT: otlp.endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', ...half }),
          async (_served, otlp) => {
            // Two exports of what it does report, and the restarts in neither.
            await eventually('two metric exports', 10_000, () => ((otlp.metrics.get(metricName('semiont.process.start_time'))?.values.length ?? 0) >= 2 ? true : undefined));
            expect(otlp.metrics.has(metricName('semiont.process.restarts'))).toBe(false);
          },
        );
      }
    } finally {
      rmSync(events, { force: true });
    }
  });

  it('reads neither LOG_LEVEL nor LOG_FORMAT: how much it logs, and how, are its document\'s', async () => {
    const w = world();
    const lines = async (settings: { logLevel: 'error' | 'info'; logFormat: 'json' | 'simple' }, unlisted: Record<string, string>, some: boolean): Promise<string[]> => {
      const served = await w.start({ settings, unlisted });
      await served.emitted(CLAIM);
      if (some) await eventually('a line of its log', 5_000, () => (served.process.stdout.length > 0 ? true : undefined));
      else await settle(500);
      await served.process.stop();
      return [...served.process.stdout];
    };

    // Told to log from info as JSON, with an environment that says errors only, and plainly: it logs as its document says.
    const json = await lines({ logLevel: 'info', logFormat: 'json' }, { LOG_LEVEL: 'error', LOG_FORMAT: 'simple' }, true);
    expect(json.length).toBeGreaterThan(0);
    for (const line of json) expect(typeof JSON.parse(line), line).toBe('object');

    // Told to log plainly, with an environment that says JSON: plainly.
    const simple = await lines({ logLevel: 'info', logFormat: 'simple' }, { LOG_LEVEL: 'debug', LOG_FORMAT: 'json' }, true);
    expect(simple.length).toBeGreaterThan(0);
    for (const line of simple) {
      expect(line.startsWith('{'), line).toBe(false);
      expect(line, line).toMatch(/ \[[A-Z]+\] /);
    }

    // Told to log errors only, with an environment that says everything: nothing has gone wrong, and it logs nothing.
    expect(await lines({ logLevel: 'error', logFormat: 'json' }, { LOG_LEVEL: 'debug', LOG_FORMAT: 'simple' }, false)).toEqual([]);
  });
});
