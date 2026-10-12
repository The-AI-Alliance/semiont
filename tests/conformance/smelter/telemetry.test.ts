/**
 * The telemetry a Smelter exports (SMELTER.md § Telemetry): everything
 * specs/src/service-telemetry/telemetry.json lists for it, and the rows of
 * specs/src/sdk-telemetry/telemetry.json it names there, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names; and nothing
 * else.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { eachSmelter } from '../harness/smelter-world';
import { spanName } from '../harness/spec';
import { outsideTheTable, received } from '../harness/telemetry';

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

eachSmelter('what a Smelter exports', (world) => {
  // One case, and judged before the Smelter is stopped: everything it exported for the traffic below, held to the table in both directions.
  it("exports, under the Smelter's name, exactly the telemetry the spec lists: every row it can, and nothing else", async () => {
    // The world's Smelter was started with no endpoint, and exports nothing. This one is told where to export, and how often.
    await world().stop();
    await world().start({
      env: { ...world().launch().env, OTEL_EXPORTER_OTLP_ENDPOINT: otlp().endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_BSP_SCHEDULE_DELAY: '100' },
    });

    // Its traffic: what it asks of the record as it starts, an event it is delivered and applies, and the decision it then signals.
    const id = await world().created('A Smelter says what it has done.\n', 'text/plain');
    await world().settled(id);

    const signalled = spanName('bus.emit:{channel}', { channel: 'smelt:settled' });
    const span = await eventually('the span of a decision it signalled', 15_000, () => otlp().spans.find((s) => s.name === signalled));
    expect(span.service).toBe('semiont-smelter');

    expect(await outsideTheTable(otlp(), 'smelter'), received(otlp())).toEqual([]);
  });
});
