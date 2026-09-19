import { decodeJwt } from 'jose';
import type { AccessToken } from '@semiont/core';
import { isString, userToDid } from '@semiont/core';
import { JWTService } from '../auth/jwt';
import { IssuerVerifier } from './issuer';
import { trustedIssuer } from './trusted-issuer';

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
  /**
   * `did:web:<domain>:users:<email>` for a person,
   * `did:web:<domain>:agents:<provider>:<model>` for a software agent.
   */
  did: string;
  email: string;
  name: string | null;
  /** The issuer's `picture` claim, when it sends one. */
  image: string | null;
  /**
   * The email's domain for a person; the DEPLOYMENT's domain for an agent,
   * whose synthetic address lives in an `agents.<host>` namespace. The two
   * differ, which is why this is carried rather than re-derived by readers.
   */
  domain: string;
  /** A software agent the gateway itself minted a token for. */
  isAgent: boolean;
}

/**
 * The principal behind a bearer token, dispatched on `iss`: a token from the
 * trusted issuer is verified against that issuer's keys; any other token is
 * gateway-signed (a software agent's) and takes the HMAC path.
 */
export async function principalFromToken(token: AccessToken): Promise<Principal> {
  const issuer = trustedIssuer();
  if (issuer && issuerOf(token) === issuer.issuer) {
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
    did: payload.did,
    email: payload.email,
    name: payload.name ?? null,
    image: null,
    domain: payload.domain,
    isAgent: true,
  };
}

/**
 * A token from the trusted issuer.
 *
 * No admission check of our own: the issuer decides who may hold a token by
 * deciding whether to mint one, and a token that verifies against its keys has
 * already passed that decision. Re-asking here would only create a second
 * answer capable of disagreeing with the first.
 */
async function principalFromIssuerToken(
  token: AccessToken,
  verifier: IssuerVerifier,
): Promise<Principal> {
  const claims = await verifier.verify(token);
  if (!isString(claims.sub)) {
    throw new Error('Token has no subject');
  }
  const email = claims['email'];
  if (!isString(email)) {
    throw new Error('Token carries no email claim');
  }
  if (claims['email_verified'] === false) {
    throw new Error('Token email is not verified');
  }
  const domain = email.split('@')[1];
  if (!domain) {
    throw new Error('Token email carries no domain');
  }
  const name = claims['name'];
  const picture = claims['picture'];
  return {
    did: userToDid({ email, domain }),
    email,
    name: isString(name) ? name : null,
    image: isString(picture) ? picture : null,
    domain,
    isAgent: false,
  };
}
