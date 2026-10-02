/**
 * The knowledge base's trusted issuer, served over HTTP: OIDC discovery, the
 * key set at the path discovery names, and a token endpoint answering the
 * client-credentials grant for the service accounts it is given. Signing is
 * `@semiont/core/testing/issuer`'s; this file only puts it on a port.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureIssuer, type FixtureIssuer, type TokenOptions } from '@semiont/core/testing/issuer';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';

export interface ServiceAccount {
  secret: string;
  roles: string[];
}

export interface IssuerServer {
  readonly origin: string;
  readonly fixture: FixtureIssuer;
  /** Client-credentials grants answered, per client id. */
  readonly grants: Map<string, number>;
  /**
   * The key set: how many times it has been asked for, and what the issuer
   * does when it is — publish it, answer 500, or accept the request and never
   * answer. Discovery and the token endpoint answer whichever it is.
   */
  readonly keys: { fetches: number; answer: 'published' | 'failing' | 'silent' };
  /** A person's token. `sub` names them; the claims default to a verified email and a name. */
  person(sub: string, claims?: Record<string, unknown>, options?: Omit<TokenOptions, 'claims'>): Promise<string>;
  /** A service account's token, as the token endpoint would issue it. */
  service(clientId: string, roles?: string[]): Promise<string>;
  close(): Promise<void>;
}

export async function startIssuer(audience: string, accounts: Record<string, ServiceAccount>): Promise<IssuerServer> {
  let fixture: FixtureIssuer | undefined;
  const grants = new Map<string, number>();
  const keys: IssuerServer['keys'] = { fetches: 0, answer: 'published' };

  const serviceToken = (clientId: string, roles: string[]) =>
    fixture!.token({ claims: { sub: `service-account-${clientId}`, azp: clientId, roles } });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://issuer');
      const reply = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (!fixture) return reply(503, { error: 'starting' });
      if (req.method === 'GET' && `${fixture.issuer}${url.pathname}` === fixture.discoveryUrl) {
        return reply(200, { ...fixture.discoveryDocument(), token_endpoint: `${fixture.issuer}/token` });
      }
      if (req.method === 'GET' && `${fixture.issuer}${url.pathname}` === fixture.jwksUrl) {
        keys.fetches += 1;
        if (keys.answer === 'silent') return;
        if (keys.answer === 'failing') return reply(500, { error: 'unavailable' });
        return reply(200, fixture.jwks());
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const clientId = form.get('client_id') ?? '';
        const account = accounts[clientId];
        if (form.get('grant_type') !== 'client_credentials' || !account || account.secret !== form.get('client_secret')) {
          return reply(401, { error: 'invalid_client' });
        }
        grants.set(clientId, (grants.get(clientId) ?? 0) + 1);
        return reply(200, { access_token: await serviceToken(clientId, account.roles), token_type: 'Bearer', expires_in: 300 });
      }
      reply(404, { error: 'not found' });
    })().catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fixture = await fixtureIssuer(origin, { audience });

  return {
    origin,
    get fixture() {
      return fixture!;
    },
    grants,
    keys,
    person(sub, claims = {}, options = {}) {
      return fixture!.token({
        ...options,
        claims: { sub, email: `${sub}@people.example`, email_verified: true, name: `Person ${sub}`, ...claims },
      });
    },
    service(clientId, roles = [SERVICE_ROLE]) {
      return serviceToken(clientId, roles);
    },
    // Kept-alive connections too: a client holding one could otherwise still
    // reach an issuer that has closed.
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export { SERVICE_ROLE, WORKER_ROLE };
