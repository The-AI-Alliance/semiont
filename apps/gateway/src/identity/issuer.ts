import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, RemoteJWKSet, RemoteJWKSetOptions } from 'jose';
import { isObject, isString } from '@semiont/core';
import type { AccessToken } from '@semiont/core';

export interface IssuerVerifierOptions {
  /** The issuer URL, exactly as it appears in `iss`; discovery is read beneath it. */
  issuer: string;
  audience: string;
  jwks?: Pick<RemoteJWKSetOptions, 'cooldownDuration' | 'cacheMaxAge'>;
}

/**
 * Verifies tokens from one OIDC issuer against the keys that issuer publishes.
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
