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
 * Whether a verified token's claims mark a Semiont service account.
 *
 * The shape check travels with the constant on purpose. Both readers used to
 * implement it, and they had already drifted: one guarded against non-string
 * array members, the other did not. A nested `realm_access.roles` fails here,
 * which is the whole point — it is the shape a hand-configured client produces
 * and the one that looks right until every call is refused.
 */
export function hasServiceRole(claims: { [claim: string]: unknown }): boolean {
  const roles = claims[ROLES_CLAIM];
  return Array.isArray(roles) && roles.some((role) => typeof role === 'string' && role === SERVICE_ROLE);
}
