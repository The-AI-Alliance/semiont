/**
 * The worker suite: every SDK that has a worker's surface, through its worker
 * driver, put through every case in worker/cases/ against a real gateway on
 * each signal plane, with the suite playing the dispatcher. README.md states
 * the driver protocol; the case format and its runner are the SDK suite's
 * (../sdk/README.md § A case, ../sdk/case.ts).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject, it } from 'vitest';
import { eachPlane } from '../harness/world';
import { casesIn, runCase } from '../sdk/case';

const corpus = casesIn(join(dirname(fileURLToPath(import.meta.url)), 'cases'));

for (const [sdk, { worker }] of Object.entries(inject('sdkDrivers'))) {
  if (!worker) continue;
  eachPlane(`a worker written on the ${sdk} SDK`, (world, plane) => {
    for (const kase of corpus) {
      if (kase.planes && !kase.planes.includes(plane)) continue;
      it(`${kase.name}: ${kase.about}`, () => runCase(world(), worker, kase, 'worker'));
    }
  });
}
