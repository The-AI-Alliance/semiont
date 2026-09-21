/**
 * What marks a Semiont service account, and how to read it off a token.
 *
 * One string with four writers and readers across two languages: the launcher
 * renders the realm's mapper with it (`identity.go`), its fake runtime emits
 * it (`fakert`), the gateway gates `POST /api/tokens/agent` on it, and the
 * Archivist gates its read path on it. Change it in one place and nothing
 * fails to build — every service-to-service call just starts returning 401
 * against a realm that looks correct in the console.
 *
 * The two TypeScript readers now share this module; the Go pair cannot, so a
 * lint (`npm run lint:service-role`) holds all of them to the same literal.
 */

/**
 * The claim the role travels in — a FLAT array of strings at the top level,
 * deliberately not Keycloak's nested `realm_access.roles`. Nothing in the
 * verification path carries a vendor's name, so an operator federating a
 * different issuer maps their own groups into this claim and no reader has to
 * know the difference.
 */
export const ROLES_CLAIM = 'roles';

/** The role within that claim. Named for what it IS, not for one thing it permits. */
export const SERVICE_ROLE = 'semiont-service';

/**
 * The role that marks a principal permitted to CLAIM JOBS — a worker, whether
 * it is this stack's own or a foreign one (EXTRACT-JOBS P0).
 *
 * Distinct from `SERVICE_ROLE` on purpose. Every sidecar carries the service
 * role, so it proves service-ness and nothing finer; worker-ness is a separate
 * grant the realm makes only to worker clients. Authorizing a `job:claim` by
 * this ROLE — a capability — rather than by the client's identity is what lets
 * a foreign worker claim: the operator grants it this role and the check is
 * unchanged. Matching a client id instead would admit only the one first-party
 * client named `semiont-worker`.
 *
 * That first-party worker's CLIENT id happens to be this same string — but a
 * client id lives in `azp` and a role in `roles`, they are different claims, and
 * only the role is ever checked (`hasWorkerRole`, never `azp === WORKER_ROLE`).
 * The coincidence is a trap: comparing `azp` to it would pass for the first
 * party and silently lock out every foreign worker, whose `azp` differs.
 */
export const WORKER_ROLE = 'semiont-worker';

function hasRole(claims: { [claim: string]: unknown }, role: string): boolean {
  const roles = claims[ROLES_CLAIM];
  return Array.isArray(roles) && roles.some((r) => typeof r === 'string' && r === role);
}

/**
 * Whether a verified token's claims mark a Semiont service account.
 *
 * The shape check travels with the constant on purpose. Both readers used to
 * implement it, and they had already drifted: one guarded against non-string
 * array members, the other did not. A nested `realm_access.roles` fails here,
 * which is the whole point — it is the shape a hand-configured client produces
 * and the one that looks right until every call is refused.
 */
export function hasServiceRole(claims: { [claim: string]: unknown }): boolean {
  return hasRole(claims, SERVICE_ROLE);
}

/**
 * Whether a verified token's claims mark a principal permitted to claim jobs.
 * The dispatcher's `job:claim` authorization reads exactly this — over the roles
 * a worker's agent token carries, stamped at mint from the minting client's own
 * `WORKER_ROLE` grant.
 */
export function hasWorkerRole(claims: { [claim: string]: unknown }): boolean {
  return hasRole(claims, WORKER_ROLE);
}
