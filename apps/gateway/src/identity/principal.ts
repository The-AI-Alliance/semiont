import { decodeJwt } from 'jose';
import type { AccessToken, UserId } from '@semiont/core';
import { isString, userToDid, userId } from '@semiont/core';
import { JWTService } from '../auth/jwt';
import { IssuerVerifier } from '@semiont/core/identity';
import { trustedIssuer, personNaming } from './trusted-issuer';

/**
 * Who a bearer token says its holder is.
 *
 * Built from the token's own claims. There is no database read here and no row
 * behind it: the identity is the DID, which is derived from facts the token
 * already carries, and every consumer downstream — the bus stamping `_userId`,
 * resource creation, the signal ledger — keys on that DID rather than on any
 * local identifier. A row would have been a second name for the same person
 * that nothing else in the system could resolve.
 */
export interface Principal {
  /** The verified emitter's DID — the one identity fact the bus stamps as `_userId`. */
  did: UserId;
  email: string;
  name: string | null;
  /** The issuer's `picture` claim, when it sends one. */
  image: string | null;
  /**
   * The DID authority this principal is named under — the deployment's
   * `[site] domain`, for a person and a software agent alike. Carried on the
   * gateway token an agent presents, so it is read there rather than
   * re-derived.
   */
  domain: string;
  /**
   * Capabilities the verified token carries (the `roles` claim). A TRANSIENT
   * authorization fact, never persisted as provenance. Today it carries
   * `WORKER_ROLE` on a worker's agent token, which the bus forwards as
   * `_roles` so the dispatcher can authorize a `job:claim` by capability
   * (EXTRACT-JOBS P0).
   */
  roles?: string[];
}

/**
 * The principal behind a bearer token, dispatched on `iss`: a token from the
 * trusted issuer is verified against that issuer's keys; any other token is
 * gateway-signed (a software agent's) and takes the HMAC path.
 */
export async function principalFromToken(token: AccessToken): Promise<Principal> {
  const issuer = trustedIssuer();
  if (issuerOf(token) === issuer.issuer) {
    return principalFromIssuerToken(token, issuer);
  }
  return principalFromGatewayToken(token);
}

function issuerOf(token: string): string | undefined {
  try {
    return decodeJwt(token).iss;
  } catch {
    return undefined;
  }
}

/**
 * A gateway-signed token: verified against the HMAC key ring, then read.
 *
 * The claims are trusted here precisely because the gateway signed them — it
 * is both the minter and the verifier of these, so a valid signature means
 * this process asserted these facts itself.
 */
export function principalFromGatewayToken(token: AccessToken): Principal {
  const payload = JWTService.verifyToken(token);
  return {
    did: userId(payload.did),
    email: payload.email,
    name: payload.name ?? null,
    image: null,
    domain: payload.domain,
    // The worker capability, when this agent token was minted by a worker
    // (EXTRACT-JOBS P0). Absent otherwise. Transient authz, not a PROV leg.
    ...(payload.roles ? { roles: payload.roles } : {}),
  };
}

/**
 * A token from the trusted issuer.
 *
 * No admission check of our own: the issuer decides who may hold a token by
 * deciding whether to mint one, and a token that verifies against its keys has
 * already passed that decision. Re-asking here would only create a second
 * answer capable of disagreeing with the first.
 *
 * The person is NAMED by the claim `[identity] subjectClaim` selects, under
 * the deployment's domain (VERIFIED-PROVENANCE P5). The email is a fact about
 * them, carried for display; it is not their identity, so changing it changes
 * nothing about who authored what.
 */
async function principalFromIssuerToken(
  token: AccessToken,
  verifier: IssuerVerifier,
): Promise<Principal> {
  const claims = await verifier.verify(token);
  const { subjectClaim, domain } = personNaming();
  const subject = claims[subjectClaim];
  if (!isString(subject) || subject === '') {
    throw new Error(`Token carries no "${subjectClaim}" claim — the claim this knowledge base names its people by ([identity] subjectClaim)`);
  }
  const email = claims['email'];
  if (!isString(email)) {
    throw new Error('Token carries no email claim');
  }
  if (claims['email_verified'] === false) {
    throw new Error('Token email is not verified');
  }
  const name = claims['name'];
  const picture = claims['picture'];
  return {
    did: userToDid({ subject, domain }),
    email,
    name: isString(name) ? name : null,
    image: isString(picture) ? picture : null,
    domain,
  };
}
