import type { EnvironmentConfig } from '@semiont/core';
import { IssuerVerifier } from './issuer';

let verifier: IssuerVerifier | null = null;

/**
 * The issuer the gateway trusts for human tokens — `services.identity`,
 * applied once at startup (and by tests). No section means no trusted
 * issuer: only gateway-signed tokens authenticate.
 */
export function configureTrustedIssuer(identity: EnvironmentConfig['services']['identity']): void {
  verifier = identity ? new IssuerVerifier({ issuer: identity.issuer, audience: identity.audience }) : null;
}

export function trustedIssuer(): IssuerVerifier | null {
  return verifier;
}
