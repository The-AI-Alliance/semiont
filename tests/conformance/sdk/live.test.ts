/**
 * The live layer: every SDK with a live layer, through its driver, put through
 * the cases of the tier it is held to, against a real gateway on each signal
 * plane: those in sdk/live/, and one built from each row of
 * specs/src/client/refresh.json (refresh-cases.ts). README.md states the
 * driver protocol and the case format; case.ts runs one case.
 */
import { inject, it } from 'vitest';
import { eachPlane } from '../harness/world';
import { cases, runCase } from './case';
import { refreshCases } from './refresh-cases';

const corpus = [...cases('live'), ...refreshCases()];

for (const [sdk, { live }] of Object.entries(inject('sdkDrivers'))) {
  if (!live) continue;
  eachPlane(`the ${sdk} SDK's live layer`, (world, plane) => {
    for (const kase of corpus) {
      if (kase.planes && !kase.planes.includes(plane)) continue;
      // The fleet's cases hold every live layer; the rest, an SDK at full parity.
      if (kase.tier === 'parity' && live.tier !== 'parity') continue;
      it(`${kase.name}: ${kase.about}`, () => runCase(world(), live.command, kase, 'live'));
    }
  });
}
