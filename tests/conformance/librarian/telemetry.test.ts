/**
 * The telemetry a Librarian exports (LIBRARIAN.md § Telemetry): everything
 * specs/src/service-telemetry/telemetry.json lists for it, and the rows of
 * specs/src/sdk-telemetry/telemetry.json it names there, exported over OTLP
 * to the endpoint the standard OpenTelemetry environment names; and nothing
 * else.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eachLibrarian } from '../harness/librarian-world';
import { eventually } from '../harness/net';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { metricName, spanName, telemetry } from '../harness/spec';
import { outsideTheTable, received } from '../harness/telemetry';
import { pdfOf } from '../smelter/support';
import { TIDE } from './support';

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

/** A resource gather that asks for the graph and the similar passages and for nothing a model writes. */
const PLAIN = { depth: 1, maxResources: 10, includeContent: false, includeSummary: false };

/** A resource gather that asks for the texts too. */
const TEXTS = { ...PLAIN, includeContent: true };

/** A resource gather that asks its model for a summary and for suggestions. */
const SUMMARIZED = { ...TEXTS, includeSummary: true };

/** What a provider that fails answers. */
const FAILS = { status: 500, body: JSON.stringify({ error: 'the stand-in fails this generation' }) };

/** A settle bound short enough for the case to wait out, and one a Librarian starts on. */
const SHORT_SETTLE_MS = 2_000;

/** Wait until `metric` has carried every value the table lists for the Librarian's `key` of it. */
async function everyValueOf(metric: string, key: string): Promise<void> {
  const row = telemetry('librarian').metrics.find((one) => one.name === metricName(metric));
  const listed = row?.attributes.find((attribute) => attribute.key === key)?.values;
  if (listed === undefined) throw new Error(`the table lists no values of ${key} for a Librarian's ${metric}`);
  await eventually(`${metric} carrying every ${key}: ${listed.join(', ')}`, 30_000, () => {
    const arrived = otlp().metrics.get(metric)?.attributes.get(key);
    return listed.every((value) => arrived?.has(value)) ? true : undefined;
  });
}

eachLibrarian('what a Librarian exports', (world) => {
  // One case, and judged before the Librarian is stopped: everything it exported for the traffic below, held to the table in both directions.
  it("exports, under the Librarian's name, exactly the telemetry the spec lists: every row it can, and nothing else", async () => {
    // The world's Librarian was started with no endpoint, and exports nothing. This one is told where to export, and how often, and waits two seconds for the Smelter.
    await world().restartLibrarian({
      settings: { ...world().settings, settleTimeoutMs: SHORT_SETTLE_MS },
      env: { ...world().launch().env, OTEL_EXPORTER_OTLP_ENDPOINT: otlp().endpoint, OTEL_METRIC_EXPORT_INTERVAL: '500', OTEL_BSP_SCHEDULE_DELAY: '100' },
    });

    // Two requests of a model that are answered, the first with the tokens its provider counted.
    const marsh = await world().created(TIDE, { name: 'A salt marsh' });
    await world().ready(marsh);
    world().gatherer.script({ response: 'A marsh that floods twice a day.', usage: { prompt: 212, output: 9 } }, { response: 'Read the tide tables\nWalk the sea wall' });
    await world().answered('gather:resource-requested', { resourceId: marsh, options: SUMMARIZED });

    // A request of a model that fails: the gather is answered without its summary and its suggestions.
    world().gatherer.script(FAILS);
    await world().answered('gather:resource-requested', { resourceId: marsh, options: SUMMARIZED });

    // A text that is derived from a resource's bytes is asked of the gateway.
    const pdf = await world().created(pdfOf([['A snipe drums over the fen']]), { name: 'Birds of the fen', format: 'application/pdf' });
    await world().ready(pdf);
    await world().answered('gather:resource-requested', { resourceId: pdf, options: TEXTS });

    // A gather the Smelter does not decide in time: answered without similar passages.
    await world().stopSmelter();
    try {
      const unsettled = await world().created('A cooper hoops the staves of an oak cask.\n', { name: 'Cask' });
      await world().woven(unsettled);
      await world().answered('gather:resource-requested', { resourceId: unsettled, options: PLAIN });
    } finally {
      await world().startSmelter();
    }

    // A gather for a resource the graph does not come to hold: failed.
    await world().stopWeaver();
    try {
      const unwoven = await world().created('A stoat hunts along the dry stone wall.\n', { name: 'Stoat' });
      await eventually(`the view of ${unwoven}`, 10_000, () => world().kb.view(unwoven));
      await world().failed('gather:resource-requested', { resourceId: unwoven, options: PLAIN });
    } finally {
      await world().startWeaver();
    }

    const answered = spanName('bus.emit:{channel}', { channel: 'gather:resource-complete' });
    const span = await eventually('the span of a gather it answered', 15_000, () => otlp().spans.find((s) => s.name === answered));
    expect(span.service).toBe('semiont-librarian');

    // Each way a request of a model ends, the tokens read and written, and each thing a gather went without.
    await everyValueOf('semiont.inference.calls', 'inference.outcome');
    await everyValueOf('semiont.inference.duration', 'inference.outcome');
    await everyValueOf('semiont.inference.tokens', 'inference.direction');
    await everyValueOf('semiont.gather.degraded', 'projection');

    expect(await outsideTheTable(otlp(), 'librarian'), received(otlp())).toEqual([]);
  }, 300_000);
});
