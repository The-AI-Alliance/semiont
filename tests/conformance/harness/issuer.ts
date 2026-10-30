/**
 * The knowledge base's trusted issuer, served over HTTP: OIDC discovery, the
 * key set at the path discovery names, and a token endpoint answering the
 * client-credentials grant for the service accounts it is given. Signing is
 * `@semiont/core/testing/issuer`'s; this file only puts it on a port.
 *
 * An account proves itself by its client secret, or by an assertion signed
 * with the key whose public half the account registers (RFC 7523,
 * `private_key_jwt`; specs/src/session/client-assertion-cases.json), checked
 * here as an issuer checks one: its signature, its issuer and subject, its
 * audience (this token endpoint), its expiry, and a `jti` it has not seen.
 */
import { verify, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixtureIssuer, type FixtureIssuer, type TokenOptions } from '@semiont/core/testing/issuer';
import { SERVICE_ROLE, WORKER_ROLE } from './roles';

/** A service account the issuer grants: by its client secret, or by the key whose public half is registered. */
export type ServiceAccount = { secret: string; roles: string[] } | { publicKey: KeyObject; roles: string[] };

/** The grant's `client_assertion_type` for an assertion that is a JWT. */
export const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** A JWT's part as the JSON object it holds, or undefined for one that is not. */
function part(encoded: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The client an assertion proves, or undefined: signed RS256 by a key account's
 * registered key, its `iss` and `sub` that account, its `aud` this token
 * endpoint, not expired, and its `jti` one not seen before.
 */
function asserted(
  assertion: string,
  tokenEndpoint: string,
  accounts: Record<string, ServiceAccount>,
  seen: Set<string>,
): string | undefined {
  const [head, body, signature, ...rest] = assertion.split('.');
  if (head === undefined || body === undefined || signature === undefined || rest.length > 0) return undefined;
  const header = part(head);
  const claims = part(body);
  if (header?.alg !== 'RS256' || claims === undefined) return undefined;
  const clientId = claims.sub;
  if (typeof clientId !== 'string' || claims.iss !== clientId) return undefined;
  const account = accounts[clientId];
  if (account === undefined || !('publicKey' in account)) return undefined;
  if (!verify('sha256', Buffer.from(`${head}.${body}`), account.publicKey, Buffer.from(signature, 'base64url'))) return undefined;
  if (claims.aud !== tokenEndpoint) return undefined;
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return undefined;
  if (typeof claims.jti !== 'string' || seen.has(claims.jti)) return undefined;
  seen.add(claims.jti);
  return clientId;
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
  /** Every assertion's `jti` the token endpoint has taken: one is never taken twice. */
  const seen = new Set<string>();
  /** The client a client-credentials grant proves, by its assertion or by its secret, or undefined. */
  const clientOf = (form: URLSearchParams): string | undefined => {
    if (form.get('grant_type') !== 'client_credentials') return undefined;
    const assertion = form.get('client_assertion');
    if (assertion !== null) {
      return form.get('client_assertion_type') === JWT_BEARER ? asserted(assertion, `${fixture!.issuer}/token`, accounts, seen) : undefined;
    }
    const clientId = form.get('client_id') ?? '';
    const account = accounts[clientId];
    return account !== undefined && 'secret' in account && account.secret === form.get('client_secret') ? clientId : undefined;
  };

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
        const clientId = clientOf(form);
        const account = clientId === undefined ? undefined : accounts[clientId];
        if (clientId === undefined || account === undefined) {
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
