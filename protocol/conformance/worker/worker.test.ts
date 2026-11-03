/**
 * The worker suite: every SDK that has a worker's surface, through its worker
 * driver, put through every case in worker/cases/ against a real gateway on
 * each signal plane, with the suite playing the dispatcher. README.md states
 * the driver protocol; the case format and its runner are the SDK suite's
 * (../sdk/README.md § A case, ../sdk/case.ts).
 *
 * The gateway exports its telemetry, to a receiver nothing reads: a gateway
 * carries a trace from the frame it is sent to the frame it delivers only
 * when it exports, and a case holds a worker to the trace a reply brings it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, inject, it } from 'vitest';
import { startOtlp, type OtlpReceiver } from '../harness/otlp';
import { eachPlane } from '../harness/world';
import { casesIn, runCase } from '../sdk/case';

const corpus = casesIn(join(dirname(fileURLToPath(import.meta.url)), 'cases'));

let receiver: OtlpReceiver | undefined;
beforeAll(async () => {
  receiver = await startOtlp();
});
afterAll(async () => {
  await receiver?.close();
});
const exporting = {
  env: {
    // Read when a world starts, after the receiver above is listening.
    get OTEL_EXPORTER_OTLP_ENDPOINT() {
      if (!receiver) throw new Error('no OTLP receiver');
      return receiver.endpoint;
    },
  },
};

for (const [sdk, { worker }] of Object.entries(inject('sdkDrivers'))) {
  if (!worker) continue;
  eachPlane(`a worker written on the ${sdk} SDK`, (world, plane) => {
    for (const kase of corpus) {
      if (kase.planes && !kase.planes.includes(plane)) continue;
      it(`${kase.name}: ${kase.about}`, () => runCase(world(), worker, kase, 'worker'));
    }
  }, exporting);
}
