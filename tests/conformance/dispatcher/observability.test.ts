/**
 * The telemetry the dispatcher exports: the spans and metrics
 * specs/src/service-telemetry/telemetry.json lists for it, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names. Its last case
 * holds everything the receiver got to the table, in both directions.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { refOf, resourceIdOf, withDispatcher } from '../harness/dispatcher-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, spanName, spec, telemetry } from '../harness/spec';
import { outsideTheTable } from '../harness/telemetry';

/** OTLP's span kinds. */
const PRODUCER = 4;
const CONSUMER = 5;

let receiver: OtlpReceiver | undefined;
beforeAll(async () => {
  receiver = await startOtlp();
});
afterAll(async () => {
  await receiver?.close();
});
const otlp = (): OtlpReceiver => {
  if (!receiver) throw new Error('no OTLP receiver');
  return receiver;
};

withDispatcher(
  'what the dispatcher exports',
  (world) => {
    it("each frame it receives is a bus.recv consumer span, and each it sends a bus.emit producer span, under the dispatcher's name", async () => {
      const { creator, worker, job } = await world().running();
      await worker.reportProgress(refOf(job), 50);
      await worker.complete(refOf(job), { kind: 'highlight-annotation', highlightsFound: 0, highlightsCreated: 0 });
      await creator.until(job.metadata.id, 'the job to complete', (s) => s.status === 'complete');
      const cancelled = await creator.created('highlight-annotation', {}, resourceIdOf());
      expect((await creator.cancelRequest({ jobId: cancelled })).ok).toBe(true);

      for (const [template, channel, kind] of [
        ['bus.recv:{channel}', 'job:create', CONSUMER],
        ['bus.recv:{channel}', 'job:claim', CONSUMER],
        ['bus.recv:{channel}', 'job:complete', CONSUMER],
        ['bus.emit:{channel}', 'job:created', PRODUCER],
        ['bus.emit:{channel}', 'job:queued', PRODUCER],
        ['bus.emit:{channel}', 'job:claimed', PRODUCER],
      ] as const) {
        const name = spanName(template, { channel });
        const span = await eventually(`a ${name} span`, 10_000, () => otlp().spans.find((s) => s.name === name));
        expect(span.kind).toBe(kind);
        expect(span.attributes['bus.channel']).toBe(channel);
        expect(span.service).toBe('semiont-dispatcher');
      }
    });

    it('semiont.job.queue.size reports the queue by each status the spec gives a job', async () => {
      const statuses = (spec().schema('JobStatusResponse')['properties'] as { status: { enum: string[] } }).status.enum;
      const row = telemetry('dispatcher').metrics.find((r) => r.name === metricName('semiont.job.queue.size'));
      expect(row?.attributes.find((a) => a.key === 'job.status')?.values).toEqual(statuses);
      await eventually('a queue size for every status', 10_000, () => {
        const seen = otlp().metrics.get('semiont.job.queue.size')?.attributes.get('job.status');
        return seen && statuses.every((s) => seen.has(s)) ? true : undefined;
      });
    });

    // Last, and judged on everything the cases above made the dispatcher
    // export: run it with them, never alone.
    it('exports exactly the telemetry the spec lists: every row it can, and nothing else', async () => {
      expect(await outsideTheTable(otlp(), 'dispatcher')).toEqual([]);
    });
  },
  {
    env: {
      // Read when the world starts, after the receiver above is listening.
      get OTEL_EXPORTER_OTLP_ENDPOINT() {
        return otlp().endpoint;
      },
      OTEL_METRIC_EXPORT_INTERVAL: '500',
      OTEL_BSP_SCHEDULE_DELAY: '100',
    },
  },
);
