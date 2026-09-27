import type { GatewayConfig } from '../config';
import { IssuerVerifier } from '@semiont/core/identity';

/**
 * How a person the issuer vouched for is named (VERIFIED-PROVENANCE P5):
 * `did:web:<domain>:users:<the value of subjectClaim>`.
 */
export interface PersonNaming {
  /**
   * The issuer claim the DID's subject segment is read from — `[identity]
   * subjectClaim`. Declared per deployment, never defaulted: `"sub"` names
   * people by the issuer's stable identifier, `"email"` by their address, and
   * the operator has said which.
   */
  subjectClaim: string;
  /**
   * The DID authority: the deployment's `[site] domain`, the same one its
   * software agents are minted under, so a person and the software working
   * for them are peers beneath one did:web.
   */
  domain: string;
}

let verifier: IssuerVerifier | undefined;
let naming: PersonNaming | undefined;

/**
 * The issuer the gateway trusts for human tokens — the configuration
 * document's `identity`, applied once at startup.
 *
 * An issuer is MANDATORY (user, 2026-09-21): the document is not valid
 * without one. Without it nobody could sign in — no person, because there are
 * no keys to verify against; no sidecar, because the agent-minter refuses
 * before it mints — and the gateway could not reach its own record, because
 * dialling the Archivist needs a service-account token.
 *
 * `audience` is NOT config: it is this knowledge base's own resource
 * identifier, derived from the committed did:web domain (`kbResource`). It
 * arrives as an argument rather than being derived here so the derivation
 * happens once, beside the identity check that guarantees the domain exists.
 * The same value is what `/.well-known/oauth-protected-resource` publishes as
 * `resource` — they are one string from one object, because two copies of a
 * resource identifier is exactly how every token comes to be refused by a
 * deployment that looks correct.
 *
 * `domain` is the deployment's `[site] domain`, resolved in that same block —
 * the authority people are named under, and the one `JWTService` mints agents
 * under. One resolved value feeds both, so the two cannot disagree.
 */
export function configureTrustedIssuer(
  identity: GatewayConfig['identity'],
  kb: { audience: string; domain: string },
): void {
  verifier = new IssuerVerifier({ issuer: identity.issuer, audience: kb.audience });
  naming = { subjectClaim: identity.subjectClaim, domain: kb.domain };
}

/**
 * Throws when called before `configureTrustedIssuer` — a programming error,
 * not a configuration one. Config absence is refused at load.
 */
export function trustedIssuer(): IssuerVerifier {
  if (!verifier) {
    throw new Error('trustedIssuer() called before configureTrustedIssuer() — the gateway must configure its issuer at startup');
  }
  return verifier;
}

/** Same contract as `trustedIssuer`: set by the one configure call, or a programming error. */
export function personNaming(): PersonNaming {
  if (!naming) {
    throw new Error('personNaming() called before configureTrustedIssuer() — the gateway must configure its issuer at startup');
  }
  return naming;
}
