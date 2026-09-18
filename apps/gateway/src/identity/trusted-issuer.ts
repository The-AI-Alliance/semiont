import type { EnvironmentConfig } from '@semiont/core';
import { IssuerVerifier } from './issuer';

let verifier: IssuerVerifier | null = null;

/**
 * The issuer the gateway trusts for human tokens — `services.identity`,
 * applied once at startup (and by tests). No section means no trusted
 * issuer: only gateway-signed tokens authenticate.
 *
 * `audience` is NOT config: it is this knowledge base's own resource
 * identifier, derived from the committed did:web domain (`kbResource`). It
 * arrives as an argument rather than being derived here so the derivation
 * happens once, beside the identity check that guarantees the domain exists.
 * The same value is what `/.well-known/oauth-protected-resource` publishes as
 * `resource` — they are one string from one object, because two copies of a
 * resource identifier is exactly how every token comes to be refused by a
 * deployment that looks correct.
 */
export function configureTrustedIssuer(
  identity: EnvironmentConfig['services']['identity'],
  audience: string,
): void {
  verifier = identity ? new IssuerVerifier({ issuer: identity.issuer, audience }) : null;
}

export function trustedIssuer(): IssuerVerifier | null {
  return verifier;
}
