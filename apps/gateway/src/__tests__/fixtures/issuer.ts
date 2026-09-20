/**
 * The core issuer double, served over the MSW server this suite already runs.
 *
 * `@semiont/core/testing/issuer` owns the keys, the signatures and the two
 * document shapes; it serves nothing, so that core need not take a
 * network-interception dependency to answer two URLs. This is the ten lines
 * that wire it to the transport the gateway's tests already have.
 */
import { http, HttpResponse } from 'msw';
import { fixtureIssuer as coreFixtureIssuer, type FixtureIssuer } from '@semiont/core/testing/issuer';
import { server } from '../setup';

export type { FixtureIssuer, TokenOptions } from '@semiont/core/testing/issuer';

export async function fixtureIssuer(
  origin: string,
  options: { audience: string; advertisedIssuer?: string },
): Promise<FixtureIssuer> {
  const issuer = await coreFixtureIssuer(origin, options);
  server.use(
    http.get(issuer.discoveryUrl, () => HttpResponse.json(issuer.discoveryDocument())),
    http.get(issuer.jwksUrl, () => HttpResponse.json(issuer.jwks())),
  );
  return issuer;
}
