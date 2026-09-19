import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, RemoteJWKSet, RemoteJWKSetOptions } from 'jose';
import { isObject, isString } from '../type-guards';
import type { AccessToken } from '../branded-types';

export interface IssuerVerifierOptions {
  /** The issuer URL, exactly as it appears in `iss`; discovery is read beneath it. */
  issuer: string;
  audience: string;
  jwks?: Pick<RemoteJWKSetOptions, 'cooldownDuration' | 'cacheMaxAge'>;
}

/**
 * Verifies tokens from one OIDC issuer against the keys that issuer publishes.
 *
 * Lives in core rather than in the gateway because the gateway is no longer the
 * only verifier: the Archivist authenticates its own callers, and two copies of
 * a verifier is exactly how two services come to disagree about which tokens
 * are acceptable.
 *
 * Reachable ONLY as `@semiont/core/identity`. That subpath is what keeps `jose`
 * out of the browser bundle — a bundler includes what is imported, and nothing
 * in the browser imports this. Re-exporting it from core's root index would
 * pull jose into every bundle silently, which is why a lint forbids it.
 * Discovery is read once and kept; keys are selected by `kid` and refetched on
 * an unknown `kid` no more often than the cooldown.
 */
export class IssuerVerifier {
  private keys?: Promise<RemoteJWKSet>;

  constructor(private readonly options: IssuerVerifierOptions) {}

  /** The issuer URL this verifier trusts — what a token's `iss` must equal. */
  get issuer(): string {
    return this.options.issuer;
  }

  /** What a token's `aud` must carry for this gateway to accept it. */
  get audience(): string {
    return this.options.audience;
  }

  async verify(token: AccessToken): Promise<JWTPayload> {
    const { payload } = await jwtVerify(token, await this.keySet(), {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ['RS256'],
    });
    return payload;
  }

  private keySet(): Promise<RemoteJWKSet> {
    this.keys ??= this.discover().catch((error: unknown) => {
      this.keys = undefined;
      throw error;
    });
    return this.keys;
  }

  private async discover(): Promise<RemoteJWKSet> {
    const { issuer } = this.options;
    const url = new URL('.well-known/openid-configuration', issuer.endsWith('/') ? issuer : `${issuer}/`);
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery for ${issuer} failed: HTTP ${response.status} from ${url}`);
    }
    const document: unknown = await response.json();
    if (!isObject(document) || !isString(document['issuer']) || !isString(document['jwks_uri'])) {
      throw new Error(`OIDC discovery for ${issuer} returned a document without \`issuer\` and \`jwks_uri\``);
    }
    if (document['issuer'] !== issuer) {
      throw new Error(`OIDC discovery for ${issuer} names a different issuer: ${document['issuer']}`);
    }
    return createRemoteJWKSet(new URL(document['jwks_uri']), this.options.jwks);
  }
}
