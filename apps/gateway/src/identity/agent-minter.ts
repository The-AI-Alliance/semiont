import type { AccessToken } from '@semiont/core';
import { isString, SERVICE_ROLE, ROLES_CLAIM, hasServiceRole, hasWorkerRole } from '@semiont/core';
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
 * The gateway verifies a signature rather than holding the credential it checks
 * against: each service account is rotatable on its own, and its tokens expire.
 */

/**
 * The role, the claim it rides in, and the predicate that reads it all come
 * from `@semiont/core` — the Archivist gates its own read path on the same
 * one, and two copies of a literal the realm stamps is how every
 * service-to-service call comes to fail against a realm that looks correct.
 * Re-exported because this module is where the gateway's callers reach for it.
 */
export { SERVICE_ROLE };

/**
 * A refusal: `message` is what the caller is told, `reason` what the log
 * records. A token that does not verify is told only that — why it did not is
 * the verifier's detail, and the caller has no use for it an attacker would
 * not have more.
 */
export class AgentMinterRefused extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
  }
}

/** The authorized minter: who asked (for logging) and what it may delegate. */
export interface AuthorizedMinter {
  /** `azp` when the issuer sends one, else the subject. For logging only — the
   *  agent DID comes from the (provider, model) named, not from who asked. */
  client: string;
  /** Whether this minter carries `WORKER_ROLE`, so the agent token it is about
   *  to receive should be stamped with the worker capability (EXTRACT-JOBS P0).
   *  The service-role FLOOR is checked above; this is the finer worker grant. */
  workerCapable: boolean;
}

/**
 * Verify a caller's bearer token and confirm it carries the service role.
 *
 * Returns who asked (for logging) and whether it may delegate the worker
 * capability to the agent token being minted — read from the same verified
 * claims, so there is one verification, not two.
 */
export async function authorizeAgentMinter(bearer: AccessToken): Promise<AuthorizedMinter> {
  let claims;
  try {
    claims = await trustedIssuer().verify(bearer);
  } catch (error) {
    throw new AgentMinterRefused('Invalid token', error instanceof Error ? error.message : String(error));
  }

  if (!hasServiceRole(claims)) {
    const missing = `The token carries no '${SERVICE_ROLE}' role in its '${ROLES_CLAIM}' claim`;
    throw new AgentMinterRefused(missing, missing);
  }

  const azp = claims['azp'];
  return {
    client: isString(azp) ? azp : (claims.sub ?? 'unknown'),
    workerCapable: hasWorkerRole(claims),
  };
}
