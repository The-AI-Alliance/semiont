import type { AccessToken } from '@semiont/core';
import { isString, SERVICE_ROLE, ROLES_CLAIM, hasServiceRole } from '@semiont/core';
import { trustedIssuer } from './trusted-issuer';

/**
 * Who may ask the gateway to mint a software-agent token.
 *
 * A sidecar authenticates to the ISSUER as itself — a service account with its
 * own credential — and presents the resulting token here. What it gets back is
 * an agent token naming a (provider, model) identity, which is a different
 * thing: the service account is the PROCESS's identity, and the agent DID is
 * the WORK's. One worker process legitimately holds several agent identities at
 * once, because per-job-type models are configurable, so the two cannot be the
 * same credential.
 *
 * This replaces a single shared secret that every sidecar carried in its
 * environment and that the gateway compared by string equality. That secret
 * granted ANY agent identity to anyone holding it, could only be rotated by
 * restarting the whole stack, and was never scoped to a caller. A service
 * account is rotatable on its own, its tokens expire, and the gateway verifies
 * a signature rather than holding the credential it checks against.
 */

/**
 * The role, the claim it rides in, and the predicate that reads it all come
 * from `@semiont/core` — the Archivist gates its own read path on the same
 * one, and two copies of a literal the realm stamps is how every
 * service-to-service call comes to fail against a realm that looks correct.
 * Re-exported because this module is where the gateway's callers reach for it.
 */
export { SERVICE_ROLE };

export class AgentMinterRefused extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Verify a caller's bearer token and confirm it carries the agent role.
 *
 * Returns the authorized client's id for logging — `azp` when the issuer sends
 * one, else the subject. Nothing downstream depends on it: the agent DID comes
 * from the (provider, model) the caller names, not from who asked.
 */
export async function authorizeAgentMinter(authorization: string | undefined): Promise<string> {
  // Every refusal here is a 401, including "this deployment trusts no issuer".
  // That is a configuration state, and an unverified caller has no business
  // learning it — a distinct status would be a hole in the route-coverage
  // contract shaped like a deployment detail. An operator learns about a
  // missing issuer from the gateway's own startup, not from an anonymous 503.
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (!bearer) {
    throw new AgentMinterRefused('Agent authentication requires a bearer token');
  }

  const issuer = trustedIssuer();
  let claims;
  try {
    claims = await issuer.verify(bearer as AccessToken);
  } catch (error) {
    throw new AgentMinterRefused(
      `Agent token rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!hasServiceRole(claims)) {
    throw new AgentMinterRefused(
      `Agent token carries no '${SERVICE_ROLE}' role in its '${ROLES_CLAIM}' claim`,
    );
  }

  const azp = claims['azp'];
  return isString(azp) ? azp : (claims.sub ?? 'unknown');
}
