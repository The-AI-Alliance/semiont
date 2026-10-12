/**
 * The telemetry a Weaver exports (WEAVER.md § Telemetry): everything
 * specs/src/service-telemetry/telemetry.json lists for it, and the rows of
 * specs/src/sdk-telemetry/telemetry.json it names there, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names; and nothing
 * else.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { spanName } from '../harness/spec';
import { outsideTheTable, received } from '../harness/telemetry';
import { eachWeaver } from '../harness/weaver-world';
import { highlighted, uploaded } from './support';

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

eachWeaver('what a Weaver exports', (world) => {
  // One case, and judged before the Weaver is stopped: everything it exported for the traffic below, held to the table in both directions.
  it("exports, under the Weaver's name, exactly the telemetry the spec lists: every row it can, and nothing else", async () => {
    // The world's Weaver was started with no endpoint, and exports nothing. This one is told where to export, and how often.
    await world().stop();
    await world().start({
      env: { ...world().launch().env, OTEL_EXPORTER_OTLP_ENDPOINT: otlp().endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_BSP_SCHEDULE_DELAY: '100' },
    });

    // Its traffic: what it asks of the record as it starts, two events it is delivered and applies, and the marks it then signals.
    const id = await uploaded(world(), 'Told of');
    const grace = await world().kb.person('grace');
    await highlighted(grace, id, 'quick');
    await world().caughtUp(id);

    const signalled = spanName('bus.emit:{channel}', { channel: 'weave:applied' });
    const span = await eventually('the span of a mark it signalled', 15_000, () => otlp().spans.find((s) => s.name === signalled));
    expect(span.service).toBe('semiont-weaver');

    expect(await outsideTheTable(otlp(), 'weaver'), received(otlp())).toEqual([]);
  });
});
