/**
 * The telemetry the Archivist exports: the spans and metrics
 * specs/src/service-telemetry/telemetry.json lists for it, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names. Its last case
 * holds everything the receiver got to the table, in both directions.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withArchivist } from '../harness/archivist-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, spanName } from '../harness/spec';
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

withArchivist(
  'what the Archivist exports',
  (world) => {
    it("each frame it receives is a bus.recv consumer span, and each it sends a bus.emit producer span, under the Archivist's name", async () => {
      const owner = await world().person('owner');
      const id = await world().created(owner.did, { name: 'Observed', storageUri: 'file://observed/a.md', content: 'observed\n' });
      await owner.ask('mark:archive', { resourceId: id, storageUri: 'file://observed/a.md' });
      await owner.ask('browse:kb-requested', {});

      for (const [template, channel, kind] of [
        ['bus.recv:{channel}', 'mark:archive', CONSUMER],
        ['bus.recv:{channel}', 'browse:kb-requested', CONSUMER],
        ['bus.emit:{channel}', 'mark:archive-ok', PRODUCER],
        ['bus.emit:{channel}', 'yield:created', PRODUCER],
        ['bus.emit:{channel}', 'mark:archived', PRODUCER],
      ] as const) {
        const name = spanName(template, { channel });
        const span = await eventually(`a ${name} span`, 10_000, () => otlp().spans.find((s) => s.name === name));
        expect(span.kind).toBe(kind);
        expect(span.attributes['bus.channel']).toBe(channel);
        expect(span.service).toBe('semiont-archivist');
      }
    });

    it('semiont.archivist.fact_pump.depth returns to zero once what was appended is published', async () => {
      const depth = metricName('semiont.archivist.fact_pump.depth');
      await eventually('a depth of zero', 10_000, () => (otlp().metrics.get(depth)?.values.at(-1) === 0 ? true : undefined));
    });

    it('semiont.git.duration measures each git command, by command', async () => {
      const duration = metricName('semiont.git.duration');
      await eventually('a measured add, rm and rev-parse', 15_000, () => {
        const seen = otlp().metrics.get(duration)?.attributes.get('git.command');
        return seen && ['add', 'rm', 'rev-parse'].every((command) => seen.has(command)) ? true : undefined;
      });
    });

    it('semiont.git.staging.failures counts a batch that could not be staged, by why', async () => {
      const owner = await world().person('owner');
      const lock = join(world().dirs.root, '.git', 'index.lock');
      writeFileSync(lock, '');
      try {
        await world().created(owner.did, { name: 'Unstaged', storageUri: 'file://observed/b.md', content: 'unstaged\n' });
        const failures = metricName('semiont.git.staging.failures');
        await eventually('a counted degradation', 20_000, () => (otlp().metrics.get(failures)?.attributes.get('reason')?.has('index-lock') ? true : undefined));
      } finally {
        rmSync(lock, { force: true });
      }
    });

    // Last, and judged on everything the cases above made the Archivist
    // export: run it with them, never alone.
    it('exports exactly the telemetry the spec lists: every row it can, and nothing else', async () => {
      expect(await outsideTheTable(otlp(), 'archivist')).toEqual([]);
    });
  },
  {
    staging: { flushMs: 100, maxWaitMs: 500 },
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
