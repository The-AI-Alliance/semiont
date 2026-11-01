/**
 * The client-credentials grant, for a process authenticating as ITSELF.
 *
 * A service or a worker holds its own account at the knowledge base's
 * issuer and exchanges that credential for a short-lived token. That token is
 * its bearer at the gateway, which names it by that account: an agent is an
 * account, as a person is. The account proves itself with its client secret,
 * or with a key: each grant then carries an assertion signed for it alone
 * (`client-assertion.ts`), and no secret is sent.
 *
 * This replaced a single shared secret that every sidecar carried and that the
 * gateway compared by string equality. That secret granted any agent identity
 * to anyone holding it, and could only be rotated by restarting the stack.
 *
 * The token endpoint is discovered rather than constructed. Every issuer
 * publishes it; guessing a vendor's path would put that vendor's layout in
 * code that has no other reason to know it.
 */

import { JWT_BEARER, clientAssertion } from './client-assertion';
import { HTTP_REQUEST_TIMEOUT_MS } from './generated/client-timing';
import { uuidV4 } from './id-generation';
import { SignInError } from './sign-in-error';
import { isObject, isString } from './type-guards';
import { UnansweredError, jsonOf } from './unanswered';

/** A service account at an issuer, which proves itself with its client secret. */
export interface SecretCredential {
  /** The issuer URL, exactly as it appears in tokens' `iss`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/**
 * A service account at an issuer, which proves itself with a key: each grant
 * carries an assertion signed with `privateKey`, which the issuer checks with
 * the public half registered on the client. The key never leaves the process.
 */
export interface KeyCredential {
  /** The issuer URL, exactly as it appears in tokens' `iss`. */
  issuer: string;
  clientId: string;
  /** An RSA key that signs RS256, as `privateKeyFromPem` reads one. */
  privateKey: CryptoKey;
}

/** A service account at an issuer, by how it proves itself. */
export type ServiceAccountCredential = SecretCredential | KeyCredential;

/**
 * The fetch a request is sent with: the one its caller gave, or the runtime's
 * own, looked up as each request is made. Either is called as a plain
 * function, never as a method of something else, which a browser refuses.
 */
function fetchOf(given: typeof fetch | undefined): typeof fetch {
  return (...request: Parameters<typeof fetch>) => (given ?? globalThis.fetch)(...request);
}

/** Renew this long before expiry, so a token never expires mid-flight. */
const RENEW_BEFORE_EXPIRY_MS = 30_000;

/** The client-credentials grant's form: the secret itself, or an assertion signed for this grant alone. */
async function proof(credential: ServiceAccountCredential, endpoint: string): Promise<URLSearchParams> {
  if ('clientSecret' in credential) {
    return new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: credential.clientId,
      client_secret: credential.clientSecret,
    });
  }
  const assertion = await clientAssertion(credential.privateKey, credential.clientId, endpoint, {
    issuedAt: Math.floor(Date.now() / 1000),
    jti: uuidV4(),
  });
  return new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: JWT_BEARER,
    client_assertion: assertion,
  });
}

/**
 * A service account's token, fetched on first use and held until it is due
 * for renewal. A process makes one for its account, with the `fetch` its
 * issuer is asked with, and asks it for the token whenever it needs one.
 *
 * The issuer's token endpoint is discovered by the first ask, and kept for as
 * long as the holder is.
 *
 * The lifetime comes from `expires_in` on the grant response, which is the
 * protocol's own field rather than a number restated here. Deliberately not
 * the JWT's `exp`: a client-credentials access token is not required to be a
 * JWT, and reading one would be assuming a shape the grant does not promise.
 */
export class ServiceToken {
  private discovered: Promise<string> | null = null;
  private held: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly credential: ServiceAccountCredential,
    private readonly fetch?: typeof globalThis.fetch,
  ) {}

  private tokenEndpoint(): Promise<string> {
    if (this.discovered === null) {
      this.discovered = this.discover().catch((error: unknown) => {
        // Not kept: a discovery that failed because the issuer was still
        // booting must be tried again, not remembered.
        this.discovered = null;
        throw error;
      });
    }
    return this.discovered;
  }

  private async discover(): Promise<string> {
    const { issuer } = this.credential;
    const url = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`);
    const unanswered = (error: unknown) => new UnansweredError(`OIDC discovery for ${issuer}`, error);
    const response = await fetchOf(this.fetch)(url, { signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS) }).catch((error: unknown) => {
      throw unanswered(error);
    });
    if (!response.ok) {
      throw new SignInError('discovery', `OIDC discovery for ${issuer} failed: HTTP ${response.status} from ${url}`, response.status);
    }
    const document = await jsonOf(response, unanswered);
    if (!isObject(document) || !isString(document['token_endpoint'])) {
      throw new SignInError('discovery', `OIDC discovery for ${issuer} returned no \`token_endpoint\``);
    }
    return document['token_endpoint'];
  }

  /**
   * The account's access token: the one held until it is due for renewal,
   * and a new grant after it, or at once when `renewed` (the gateway refused
   * the one held, or it is due by the asker's own schedule).
   *
   * Throws on refusal rather than returning null: a sidecar that cannot prove
   * who it is has nothing useful to do, and the caller's retry policy decides
   * whether this is worth attempting again. A refusal is a `SignInError`
   * carrying the status the issuer answered with; a request that got no
   * answer is an `UnansweredError`.
   *
   * Both requests, the issuer's discovery and the grant, are bounded by
   * `httpRequestTimeoutMs` (specs/src/client/timing.json): an issuer that
   * accepts a connection and never answers would otherwise hold a process's
   * start, and every renewal after it, for as long as the process lives. Both
   * are sent with the `fetch` this was made with, or the runtime's own.
   */
  async token({ renewed }: { renewed: boolean }): Promise<string> {
    const { issuer, clientId } = this.credential;

    if (!renewed && this.held && this.held.expiresAt - RENEW_BEFORE_EXPIRY_MS > Date.now()) {
      return this.held.token;
    }

    const endpoint = await this.tokenEndpoint();
    const form = await proof(this.credential, endpoint);

    const unanswered = (error: unknown) => new UnansweredError(`Client-credentials grant for ${clientId} at ${issuer}`, error);
    const response = await fetchOf(this.fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw unanswered(error);
    });

    if (!response.ok) {
      // The status, not the body: a token endpoint's error body can echo the
      // request, and this one carried the secret or the assertion.
      throw new SignInError(
        'exchange',
        `Client-credentials grant for ${clientId} at ${issuer} failed (HTTP ${response.status})`,
        response.status,
      );
    }

    const body = await jsonOf(response, unanswered);
    if (!isObject(body) || !isString(body['access_token'])) {
      throw new SignInError('exchange', `Token endpoint for ${issuer} returned no \`access_token\``);
    }

    const token = body['access_token'];
    const expiresIn = body['expires_in'];
    // A token whose grant reports no lifetime is not held, and neither is the
    // one it replaces, rather than either living by a guess: serving a token
    // past its expiry fails at the far end, where the cause is hardest to see.
    this.held = typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? { token, expiresAt: Date.now() + expiresIn * 1000 } : null;
    return token;
  }
}
